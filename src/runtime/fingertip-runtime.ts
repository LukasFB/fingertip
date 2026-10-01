import os from "node:os";
import path from "node:path";

import type { JsonValue } from "@elgato/utils";

import {
  AppServerCatalogClient,
  AppServerProtocolError,
  AppServerRequestError,
} from "../catalog/app-server-catalog-client.ts";
import { parseTaskId, type TaskId } from "../catalog/catalog-projection.ts";
import { type CatalogTask } from "../catalog/task-feed.ts";
import { CatalogCompatibilityTracker } from "../catalog/catalog-compatibility.ts";
import { readWorkspaceMetadata } from "../catalog/global-state-reader.ts";
import { watchWorkspaceMetadataFile } from "../catalog/global-state-watcher.ts";
import type { WorkspaceMetadata } from "../catalog/project-label-resolver.ts";
import {
  CatalogSchemaError,
  TaskCatalogService,
  type CatalogRpcPort,
  type CatalogView,
} from "../catalog/task-catalog-service.ts";
import { ChatGptBundleResolver, type ResolvedChatGptBundle } from "../chatgpt/chatgpt-bundle-resolver.ts";
import { ChatGptNavigationPort } from "../chatgpt/chatgpt-navigation-port.ts";
import {
  diagnosticLabel,
  selectDiagnosticCode,
} from "../diagnostics/safe-diagnostics.ts";
import { ChatGptDesktopIpcAdapter, type LiveTaskRecord } from "../desktop-ipc/chatgpt-desktop-ipc-adapter.ts";
import { discoverModels, type ModelCatalogEntry } from "../models/model-catalog.ts";
import { renderModelKeyDataUrl } from "../rendering/model-key-renderer.ts";
import type { ModelKeySettings } from "../settings/model-key-settings.ts";
import { MacTaskNotifier, type TaskNotifier } from "../notifications/mac-task-notifier.ts";
import type { FastModeVisualState } from "../rendering/fast-mode-key-renderer.ts";
import { taskTransitionNotification } from "../notifications/task-transition-notification.ts";
import { projectTaskChangeStats, type TaskChangeStats } from "../task-change-stats.ts";
import {
  DEFAULT_TASK_KEY_APPEARANCE,
  normalizeTaskKeyAppearanceSettings,
  normalizeTaskKeySettings,
  type TaskNotificationStatus,
  type TaskKeySettings,
} from "../settings/task-key-settings.ts";
import { createKeySnapshot, type KeySnapshot } from "./key-snapshot.ts";
import { FastModeKeyAnimator } from "./fast-mode-key-animator.ts";
import type { DesktopState } from "./key-presentation.ts";
import { TaskKeyRegistry, type TaskKeyActionPort } from "./task-key-registry.ts";
import { renderSnapshotDataUrl } from "./task-key-render-queue.ts";
import { taskAtPositionForKey } from "./task-selection.ts";

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
// A routine socket replacement can span the first few reconnect attempts and
// their handshakes. Keep the last trustworthy key state visible throughout
// that window so a shared transport hiccup does not flash every key offline.
const DESKTOP_WARNING_GRACE_MS = 10_000;
const DESKTOP_HYDRATION_GRACE_MS = 2_500;
const TASK_CHANGE_REFRESH_MS = 45_000;
const MODEL_CATALOG_REFRESH_MS = 60_000;
export const KEY_HOLD_THRESHOLD_MS = 600;
export const KEY_DOUBLE_TAP_WINDOW_MS = 300;
export const TASK_HIGHLIGHT_DURATION_MS = 15 * 60 * 1_000;
export const UNREAD_NAVIGATION_TIMEOUT_MS = 1_000;

interface PropertyInspectorPort {
  send(payload: JsonValue): Promise<void>;
}

interface ModelKeyActionPort {
  readonly id: string;
  setImage(image: string): Promise<void>;
  showAlert(): Promise<void>;
}

interface FastModeEntry {
  readonly action: ModelKeyActionPort;
  readonly animator: FastModeKeyAnimator;
}

interface ConfiguredModelKeyEntry {
  readonly action: ModelKeyActionPort;
  settings: ModelKeySettings;
  lastImage: string;
  pendingImage: string | null;
  rendering: boolean;
}

export interface CatalogClientLifecyclePort extends CatalogRpcPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  readThread?(input: { readonly threadId: string }): Promise<unknown>;
  readThreadGoal?(input: { readonly threadId: string }): Promise<unknown>;
  listModels?(input: { readonly limit: number; readonly cursor?: string }): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOngoingGoal(value: unknown): boolean {
  if (!isRecord(value) || value.goal === null || !isRecord(value.goal)) return false;
  return value.goal.status === "active"
    || value.goal.status === "paused"
    || value.goal.status === "blocked"
    || value.goal.status === "usageLimited"
    || value.goal.status === "budgetLimited";
}

interface RuntimeOptions {
  readonly bundleResolver: ChatGptBundleResolver;
  readonly desktopIpc: ChatGptDesktopIpcAdapter;
  readonly navigation: ChatGptNavigationPort;
  readonly propertyInspector: PropertyInspectorPort;
  readonly catalogClientFactory: (binaryPath: string) => CatalogClientLifecyclePort;
  readonly readWorkspaceMetadata: () => Promise<WorkspaceMetadata>;
  readonly watchWorkspaceMetadata: (onChange: () => void) => () => void;
  readonly random: () => number;
  readonly setTimer: typeof setTimeout;
  readonly clearTimer: typeof clearTimeout;
  readonly now: () => number;
  readonly notifier: TaskNotifier;
}

export function computeRetryDelayMs(attempt: number, random: () => number): number {
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 10_000;
  return Math.round(base * (0.9 + random() * 0.2));
}

function catalogCompatibilitySignature(error: unknown): string | null {
  if (error instanceof CatalogSchemaError) return `schema:${error.signature}`;
  if (error instanceof AppServerProtocolError) return `protocol:${error.signature}`;
  return null;
}

export class FingertipRuntime {
  readonly #options: RuntimeOptions;
  readonly #registry: TaskKeyRegistry;
  readonly #catalogCompatibility = new CatalogCompatibilityTracker();
  readonly #live = new Map<string, LiveTaskRecord>();
  readonly #pendingDoneNotifications = new Map<string, LiveTaskRecord>();
  readonly #modelKeyActions = new Map<string, ConfiguredModelKeyEntry>();
  readonly #modelInspectorConsumers = new Set<string>();
  readonly #fastModeActions = new Map<string, FastModeEntry>();
  readonly #knownServiceTiers = new Map<TaskId, string | null>();
  readonly #liveExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #propertyInspectorConsumers = new Set<string>();
  #catalogView: CatalogView = Object.freeze({ state: "cold", feed: null });
  #desktopState: DesktopState = "connecting";
  #reportedDesktopState: DesktopState = "connecting";
  #desktopWarningTimer: ReturnType<typeof setTimeout> | null = null;
  #desktopHydrationTimer: ReturnType<typeof setTimeout> | null = null;
  #bundle: ResolvedChatGptBundle | null = null;
  #catalogClient: CatalogClientLifecyclePort | null = null;
  #catalogService: TaskCatalogService | null = null;
  #catalogStartGeneration: number | null = null;
  #catalogStopped: Promise<void> | null = null;
  readonly #catalogClientStops = new WeakMap<CatalogClientLifecyclePort, Promise<void>>();
  #catalogTimer: ReturnType<typeof setTimeout> | null = null;
  #ipcTimer: ReturnType<typeof setTimeout> | null = null;
  #shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  #catalogAttempt = 0;
  #ipcAttempt = 0;
  #catalogRetryAt: number | null = null;
  #ipcRetryAt: number | null = null;
  #generation = 0;
  #running = false;
  #catalogRefreshGeneration: number | null = null;
  #catalogRefreshQueued = false;
  #stopWorkspaceMetadataWatch: (() => void) | null = null;
  #chatGptNotRunning = false;
  #appearance = DEFAULT_TASK_KEY_APPEARANCE;
  #taskChangeStatsByTaskId = new Map<string, TaskChangeStats>();
  #taskChangeTimer: ReturnType<typeof setTimeout> | null = null;
  #taskChangeRefreshing = false;
  #ongoingGoalByTaskId = new Map<string, boolean>();
  readonly #keyHoldTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #heldActionIds = new Set<string>();
  readonly #keyDownTaskIds = new Map<string, TaskId | null>();
  readonly #pendingTapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #pendingTapTaskIds = new Map<string, TaskId | null>();
  readonly #doubleTapTaskIds = new Map<string, TaskId | null>();
  readonly #highlightedTaskIds = new Set<TaskId>();
  readonly #highlightExpiryTimers = new Map<TaskId, ReturnType<typeof setTimeout>>();
  #models: readonly ModelCatalogEntry[] = [];
  #modelCatalogLoading = false;
  #modelCatalogError: string | null = null;
  #modelCatalogRequest: Promise<void> | null = null;
  #modelCatalogTimer: ReturnType<typeof setTimeout> | null = null;
  #modelsRefreshedAt: number | null = null;

  constructor(options: Partial<RuntimeOptions> & Pick<RuntimeOptions, "propertyInspector">) {
    this.#options = {
      bundleResolver: options.bundleResolver ?? new ChatGptBundleResolver(),
      desktopIpc: options.desktopIpc ?? new ChatGptDesktopIpcAdapter(),
      navigation: options.navigation ?? new ChatGptNavigationPort(),
      propertyInspector: options.propertyInspector,
      catalogClientFactory: options.catalogClientFactory ?? ((binaryPath) => new AppServerCatalogClient(binaryPath)),
      readWorkspaceMetadata: options.readWorkspaceMetadata ?? (() => {
        const statePath = path.join(os.homedir(), ".codex", ".codex-global-state.json");
        return readWorkspaceMetadata(statePath);
      }),
      watchWorkspaceMetadata: options.watchWorkspaceMetadata ?? ((onChange) => {
        const statePath = path.join(os.homedir(), ".codex", ".codex-global-state.json");
        return watchWorkspaceMetadataFile(statePath, onChange);
      }),
      random: options.random ?? Math.random,
      setTimer: options.setTimer ?? setTimeout,
      clearTimer: options.clearTimer ?? clearTimeout,
      now: options.now ?? Date.now,
      notifier: options.notifier ?? new MacTaskNotifier(),
    };
    this.#registry = new TaskKeyRegistry((actionId) => {
      void this.#sendPropertyInspector(actionId);
    });
    this.#options.desktopIpc.onHealth((state) => {
      this.#acceptDesktopState(state);
      this.#renderModelKeyActions();
      void this.#sendVisibleModelPropertyInspectors();
      if (state === "online") {
        this.#clearIpcRetry();
        this.#ipcAttempt = 0;
        this.#chatGptNotRunning = false;
        this.#hydrateVisibleTaskStatuses();
      }
      if (state === "offline" && this.#running) this.#scheduleIpcRetry();
    });
    this.#options.desktopIpc.onTaskRecord((record) => {
      const previous = this.#live.get(record.taskId);
      if (record.status !== "done" || record.freshness !== "fresh") {
        this.#pendingDoneNotifications.delete(record.taskId);
      }
      const feed = this.#catalogView.feed;
      const observers = this.#registry.entries()
        .filter((entry) => feed !== null && this.#taskForSettings(entry.settings, feed)?.id === record.taskId)
        .map((entry) => ({ entry, taskSource: entry.settings.taskSource, taskPosition: entry.settings.taskPosition }));
      const visibleTask = observers.length === 0 ? undefined : feed?.find((task) => task.id === record.taskId);
      this.#live.set(record.taskId, record);
      if (record.facts.serviceTier !== undefined) {
        this.#knownServiceTiers.set(record.taskId, record.facts.serviceTier);
      }
      if (this.#catalogService !== null) {
        this.#catalogView = this.#catalogService.rerank(this.#liveStatuses());
        this.#hydrateVisibleTaskStatuses();
      }
      if (visibleTask !== undefined) {
        void this.#notifyTaskTransition(previous, record, visibleTask.title, () => observers.some(
          ({ entry, taskSource, taskPosition }) => this.#registry.get(entry.action.id) === entry
            && entry.settings.taskSource === taskSource && entry.settings.taskPosition === taskPosition,
        ));
      }
      if (!this.#retainLiveRecord(record.taskId)) this.#scheduleLiveExpiry(record.taskId);
      this.#renderAll();
    });
    this.#options.desktopIpc.onActiveTask?.(() => {
      this.#hydrateVisibleTaskStatuses();
      this.#renderAll();
    });
    this.#options.desktopIpc.onCatalogHint(() => this.#queueCatalogRefresh());
  }

  async #notifyTaskTransition(
    previous: LiveTaskRecord | undefined,
    record: LiveTaskRecord,
    taskTitle: string,
    isStillObserved: () => boolean,
  ): Promise<void> {
    const notification = taskTransitionNotification(previous, record, this.#appearance, taskTitle);
    if (notification === null) return;
    const client = this.#catalogClient;
    if (notification.status !== "done") {
      this.#options.notifier.notify(notification);
      return;
    }
    if (client === null) return;
    if (client.readThreadGoal === undefined) {
      this.#options.notifier.notify(notification);
      return;
    }

    const generation = this.#generation;
    this.#pendingDoneNotifications.set(record.taskId, record);
    try {
      // A finished turn can be followed by another Goal turn. Check the current
      // Goal even when its badge is hidden, rather than relying on the badge cache.
      let result: unknown;
      try {
        result = await client.readThreadGoal({ threadId: record.taskId });
      } catch (error) {
        // Older app servers can lack Goals altogether. Other failures leave the
        // Goal state unknown; let catalog recovery handle them without notifying.
        if (!(error instanceof AppServerRequestError && error.code === -32601)) return;
      }
      if (isRecord(result) && isRecord(result.goal) && result.goal.status === "active") return;
      const current = this.#live.get(record.taskId);
      if (!this.#running || generation !== this.#generation || client !== this.#catalogClient
        || this.#pendingDoneNotifications.get(record.taskId) !== record
        || current?.status !== "done" || current.freshness !== "fresh"
        || !this.#catalogHas(record.taskId) || !isStillObserved()) return;
      const currentNotification = taskTransitionNotification(previous, current, this.#appearance, taskTitle);
      if (currentNotification !== null) this.#options.notifier.notify(currentNotification);
    } finally {
      if (this.#pendingDoneNotifications.get(record.taskId) === record) {
        this.#pendingDoneNotifications.delete(record.taskId);
      }
    }
  }

  normalizeSettings(value: unknown): TaskKeySettings {
    return normalizeTaskKeySettings(value);
  }

  updateAppearance(value: unknown): void {
    this.#appearance = normalizeTaskKeyAppearanceSettings(value);
    this.#options.navigation.setWindowTarget?.(this.#appearance.windowTarget);
    if (!this.#appearance.showGitDiffStats) {
      if (this.#taskChangeTimer !== null) this.#options.clearTimer(this.#taskChangeTimer);
      this.#taskChangeTimer = null;
      this.#taskChangeStatsByTaskId.clear();
    } else {
      this.#queueTaskChangeRefresh(true);
    }
    this.#queueCatalogRefresh();
    this.#renderAll();
    void this.#sendVisiblePropertyInspector();
  }

  attachAction(action: TaskKeyActionPort, settings: TaskKeySettings): void {
    this.#registry.upsert(action, settings);
    this.#cancelShutdown();
    this.#ensureStarted();
    this.#renderAll();
    this.#hydrateVisibleTaskStatuses();
  }

  updateSettings(action: TaskKeyActionPort, settings: TaskKeySettings): void {
    this.#registry.upsert(action, settings);
    this.#renderAll();
    this.#hydrateVisibleTaskStatuses();
    if (this.#catalogService !== null) this.#queueCatalogRefresh();
  }

  detachAction(actionId: string): void {
    this.#clearKeyHold(actionId);
    this.#clearPendingTap(actionId);
    this.#keyDownTaskIds.delete(actionId);
    this.#doubleTapTaskIds.delete(actionId);
    this.#registry.remove(actionId);
    this.#scheduleShutdownIfUnused();
  }

  attachModelKeyAction(action: ModelKeyActionPort, settings: ModelKeySettings): void {
    this.#modelKeyActions.set(action.id, {
      action, settings, lastImage: "", pendingImage: null, rendering: false,
    });
    this.#cancelShutdown();
    this.#ensureStarted();
    this.#renderModelKeyActions();
    this.#hydrateVisibleTaskStatuses();
    if (this.#models.length === 0) void this.refreshModelCatalog();
  }

  updateModelKeySettings(action: ModelKeyActionPort, settings: ModelKeySettings): void {
    const entry = this.#modelKeyActions.get(action.id);
    if (entry === undefined) return this.attachModelKeyAction(action, settings);
    entry.settings = settings;
    this.#renderModelKeyActions();
    void this.#sendModelPropertyInspector(action.id);
  }

  detachModelKeyAction(actionId: string): void {
    this.#modelKeyActions.delete(actionId);
    this.#modelInspectorConsumers.delete(actionId);
    this.#hydrateVisibleTaskStatuses();
    this.#scheduleShutdownIfUnused();
  }

  modelPropertyInspectorDidAppear(actionId: string): void {
    this.#modelInspectorConsumers.add(actionId);
    this.#cancelShutdown();
    this.#ensureStarted();
    void this.#sendModelPropertyInspector(actionId);
    void this.refreshModelCatalog();
  }

  modelPropertyInspectorDidDisappear(actionId: string): void {
    this.#modelInspectorConsumers.delete(actionId);
    this.#scheduleShutdownIfUnused();
  }

  attachFastModeAction(action: ModelKeyActionPort): void {
    const existing = this.#fastModeActions.get(action.id);
    if (existing === undefined) {
      this.#fastModeActions.set(action.id, {
        action,
        animator: new FastModeKeyAnimator(action, {
          setTimer: this.#options.setTimer,
          clearTimer: this.#options.clearTimer,
        }),
      });
    }
    this.#cancelShutdown();
    this.#ensureStarted();
    this.#renderFastModeActions();
    this.#hydrateVisibleTaskStatuses();
  }

  detachFastModeAction(actionId: string): void {
    this.#fastModeActions.get(actionId)?.animator.dispose();
    this.#fastModeActions.delete(actionId);
    this.#hydrateVisibleTaskStatuses();
    this.#scheduleShutdownIfUnused();
  }

  async pressModelKey(actionId: string): Promise<boolean> {
    const generation = this.#generation;
    const entry = this.#modelKeyActions.get(actionId);
    if (entry === undefined || !entry.settings.model || this.#options.desktopIpc.state !== "online") return false;
    const { model, effort } = entry.settings;
    const taskId = this.#options.desktopIpc.activeTaskId;
    if (taskId === null) return false;
    if (this.#modelsRefreshedAt === null
      || this.#options.now() - this.#modelsRefreshedAt >= MODEL_CATALOG_REFRESH_MS) {
      await this.refreshModelCatalog();
    }
    if (this.#modelsRefreshedAt === null || this.#modelCatalogLoading || this.#modelCatalogError !== null || generation !== this.#generation
      || this.#options.desktopIpc.state !== "online") return false;
    const available = this.#models.find((candidate) => candidate.model === model);
    if (available === undefined || (available.supportedReasoningEfforts.length > 0
      ? !available.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === effort)
      : effort !== "")) return false;
    if (this.#modelKeyActions.get(actionId) !== entry) return false;
    // Capture this press's selection and target once; later UI changes belong to the next press.
    return this.#options.desktopIpc.setModelSelection(taskId, { model, effort: effort || null });
  }

  refreshModelCatalog(): Promise<void> {
    this.#ensureStarted();
    if (this.#modelCatalogRequest !== null) return this.#modelCatalogRequest;
    const client = this.#catalogClient;
    if (client === null || client.listModels === undefined || this.#catalogService === null) {
      this.#modelCatalogLoading = client === null || this.#catalogService === null;
      this.#modelCatalogError = this.#modelCatalogLoading ? null : "Model discovery is unavailable. Reconnect ChatGPT.";
      void this.#sendVisibleModelPropertyInspectors();
      return Promise.resolve();
    }
    if (this.#modelCatalogTimer !== null) this.#options.clearTimer(this.#modelCatalogTimer);
    this.#modelCatalogTimer = null;
    this.#modelCatalogLoading = true;
    this.#modelCatalogError = null;
    void this.#sendVisibleModelPropertyInspectors();
    const generation = this.#generation;
    const request = (async () => {
      try {
        const models = await discoverModels({ listModels: client.listModels!.bind(client) });
        if (!this.#running || generation !== this.#generation || this.#catalogClient !== client) return;
        this.#models = models;
        this.#modelsRefreshedAt = this.#options.now();
        this.#modelCatalogError = models.length === 0 ? "No models are available for this account." : null;
      } catch {
        if (!this.#running || generation !== this.#generation || this.#catalogClient !== client) return;
        this.#modelCatalogError = "Could not load models. Reconnect ChatGPT or refresh the list.";
      } finally {
        if (generation === this.#generation && this.#catalogClient === client) {
          this.#modelCatalogLoading = false;
          this.#renderModelKeyActions();
          await this.#sendVisibleModelPropertyInspectors();
          this.#scheduleModelCatalogRefresh();
        }
      }
    })();
    this.#modelCatalogRequest = request;
    void request.finally(() => {
      if (this.#modelCatalogRequest === request) this.#modelCatalogRequest = null;
    });
    return request;
  }

  #scheduleModelCatalogRefresh(): void {
    if (!this.#running || this.#modelCatalogTimer !== null
      || (this.#modelKeyActions.size === 0 && this.#modelInspectorConsumers.size === 0)) return;
    this.#modelCatalogTimer = this.#options.setTimer(() => {
      this.#modelCatalogTimer = null;
      void this.refreshModelCatalog();
    }, MODEL_CATALOG_REFRESH_MS);
  }

  #clearModelCatalogRefresh(): void {
    if (this.#modelCatalogTimer !== null) this.#options.clearTimer(this.#modelCatalogTimer);
    this.#modelCatalogTimer = null;
    this.#modelCatalogRequest = null;
    this.#modelCatalogLoading = false;
    this.#modelsRefreshedAt = null;
  }

  async pressFastMode(): Promise<boolean> {
    const generation = this.#generation;
    if (this.#options.desktopIpc.state !== "online") return false;
    const taskId = this.#options.desktopIpc.activeTaskId;
    if (taskId === null || generation !== this.#generation || this.#options.desktopIpc.state !== "online") return false;
    const enabled = this.#knownServiceTiers.get(taskId) !== "priority";
    const succeeded = await this.#options.desktopIpc.setFastMode(taskId, enabled);
    if (succeeded) {
      this.#knownServiceTiers.set(taskId, enabled ? "priority" : null);
      this.#renderFastModeActions();
    }
    return succeeded;
  }

  keyDown(actionId: string): void {
    this.#clearKeyHold(actionId);
    this.#heldActionIds.delete(actionId);
    const taskId = this.#registry.displayedTaskId(actionId);
    this.#keyDownTaskIds.set(actionId, taskId);
    if (this.#pendingTapTimers.has(actionId)) {
      const firstTapTaskId = this.#pendingTapTaskIds.get(actionId) ?? null;
      this.#clearPendingTap(actionId);
      this.#doubleTapTaskIds.set(actionId, firstTapTaskId);
    }
    const timer = this.#options.setTimer(() => {
      this.#keyHoldTimers.delete(actionId);
      this.#heldActionIds.add(actionId);
      const gestureTaskId = this.#doubleTapTaskIds.get(actionId) ?? taskId;
      this.#doubleTapTaskIds.delete(actionId);
      void this.#markUnread(actionId, gestureTaskId);
    }, KEY_HOLD_THRESHOLD_MS);
    this.#keyHoldTimers.set(actionId, timer);
  }

  async keyUp(actionId: string): Promise<void> {
    const held = this.#heldActionIds.delete(actionId);
    const taskId = this.#keyDownTaskIds.get(actionId) ?? null;
    this.#keyDownTaskIds.delete(actionId);
    this.#clearKeyHold(actionId);
    if (held) return;
    if (this.#doubleTapTaskIds.has(actionId)) {
      const doubleTapTaskId = this.#doubleTapTaskIds.get(actionId) ?? null;
      this.#doubleTapTaskIds.delete(actionId);
      await this.#toggleHighlight(actionId, doubleTapTaskId);
      return;
    }
    const timer = this.#options.setTimer(() => {
      this.#pendingTapTimers.delete(actionId);
      this.#pendingTapTaskIds.delete(actionId);
      void this.#pressTask(actionId, taskId);
    }, KEY_DOUBLE_TAP_WINDOW_MS);
    this.#pendingTapTimers.set(actionId, timer);
    this.#pendingTapTaskIds.set(actionId, taskId);
  }

  async press(actionId: string): Promise<void> {
    const activatedTaskId = await this.#registry.press(actionId, this.#options.navigation);
    if (activatedTaskId !== null) this.#options.desktopIpc.selectActiveTask(activatedTaskId);
    await this.#sendPropertyInspector(actionId);
  }

  propertyInspectorDidAppear(actionId: string): void {
    this.#propertyInspectorConsumers.add(actionId);
    const entry = this.#registry.get(actionId);
    if (entry !== null) entry.propertyInspectorVisible = true;
    this.#cancelShutdown();
    this.#ensureStarted();
    void this.#sendPropertyInspector(actionId);
  }

  propertyInspectorDidDisappear(actionId: string): void {
    this.#propertyInspectorConsumers.delete(actionId);
    const entry = this.#registry.get(actionId);
    if (entry !== null) entry.propertyInspectorVisible = false;
    this.#scheduleShutdownIfUnused();
  }

  retryNow(): void {
    if (!this.#running) return;
    this.#ipcAttempt = 0;
    this.#clearIpcRetry();
    this.#options.desktopIpc.clearCompatibilityLatch();
    this.#options.desktopIpc.stop();
    this.#clearIpcRetry();
    void this.#startIpc(this.#generation);
    void this.#sendVisiblePropertyInspector();
  }

  async importCustomSound(status: TaskNotificationStatus): Promise<void> {
    await this.#options.notifier.importCustomSound(status).catch(() => false);
    await this.#sendVisiblePropertyInspector();
  }

  previewSound(status: TaskNotificationStatus): void {
    const done = status === "done";
    this.#options.notifier.notify({
      status,
      mode: "sound",
      source: done ? this.#appearance.doneSoundSource : this.#appearance.confirmationSoundSource,
      sound: done ? this.#appearance.doneSound : this.#appearance.confirmationSound,
      volume: done ? this.#appearance.doneVolume : this.#appearance.confirmationVolume,
      repeat: done ? this.#appearance.doneRepeat : this.#appearance.confirmationRepeat,
      repeatDelayMs: done
        ? this.#appearance.doneRepeatDelayMs : this.#appearance.confirmationRepeatDelayMs,
      taskTitle: "Sound preview",
    });
  }

  applicationDidLaunch(): void {
    this.#restartServices(false);
  }

  applicationDidTerminate(): void {
    this.#chatGptNotRunning = true;
    this.#options.desktopIpc.stop();
    this.#acceptDesktopState("offline", true);
  }

  systemDidWake(): void {
    this.#restartServices(false);
  }

  #restartServices(clearCompatibility: boolean): void {
    const shouldRun = this.#running;
    this.#running = false;
    this.#pendingDoneNotifications.clear();
    this.#chatGptNotRunning = false;
    this.#catalogAttempt = 0;
    this.#ipcAttempt = 0;
    this.#catalogRefreshGeneration = null;
    this.#catalogRefreshQueued = false;
    this.#clearModelCatalogRefresh();
    if (clearCompatibility) this.#catalogCompatibility.clearFailures();
    if (this.#catalogTimer !== null) this.#options.clearTimer(this.#catalogTimer);
    if (this.#ipcTimer !== null) this.#options.clearTimer(this.#ipcTimer);
    if (this.#desktopWarningTimer !== null) this.#options.clearTimer(this.#desktopWarningTimer);
    if (this.#desktopHydrationTimer !== null) this.#options.clearTimer(this.#desktopHydrationTimer);
    if (this.#taskChangeTimer !== null) this.#options.clearTimer(this.#taskChangeTimer);
    this.#catalogTimer = null;
    this.#ipcTimer = null;
    this.#desktopWarningTimer = null;
    this.#desktopHydrationTimer = null;
    this.#taskChangeTimer = null;
    this.#catalogRetryAt = null;
    this.#ipcRetryAt = null;
    this.#options.desktopIpc.stop();
    for (const timer of this.#liveExpiryTimers.values()) this.#options.clearTimer(timer);
    this.#liveExpiryTimers.clear();
    for (const timer of this.#keyHoldTimers.values()) this.#options.clearTimer(timer);
    this.#keyHoldTimers.clear();
    this.#heldActionIds.clear();
    for (const timer of this.#pendingTapTimers.values()) this.#options.clearTimer(timer);
    this.#pendingTapTimers.clear();
    this.#pendingTapTaskIds.clear();
    this.#keyDownTaskIds.clear();
    this.#doubleTapTaskIds.clear();
    if (clearCompatibility) this.#options.desktopIpc.clearCompatibilityLatch();
    const catalogStopped = this.#stopCatalogClient();
    this.#ongoingGoalByTaskId.clear();
    this.#generation += 1;
    this.#running = shouldRun;
    if (shouldRun) {
      const generation = this.#generation;
      void this.#startIpc(generation);
      void catalogStopped.then(() => this.#startCatalog(generation));
    }
  }

  shutdown(): void {
    this.#running = false;
    this.#pendingDoneNotifications.clear();
    this.#catalogRefreshGeneration = null;
    this.#catalogRefreshQueued = false;
    this.#clearModelCatalogRefresh();
    this.#generation += 1;
    this.#cancelShutdown();
    if (this.#catalogTimer !== null) this.#options.clearTimer(this.#catalogTimer);
    if (this.#ipcTimer !== null) this.#options.clearTimer(this.#ipcTimer);
    if (this.#desktopWarningTimer !== null) this.#options.clearTimer(this.#desktopWarningTimer);
    if (this.#desktopHydrationTimer !== null) this.#options.clearTimer(this.#desktopHydrationTimer);
    if (this.#taskChangeTimer !== null) this.#options.clearTimer(this.#taskChangeTimer);
    this.#catalogTimer = null;
    this.#ipcTimer = null;
    this.#desktopWarningTimer = null;
    this.#desktopHydrationTimer = null;
    this.#taskChangeTimer = null;
    this.#catalogRetryAt = null;
    this.#ipcRetryAt = null;
    for (const timer of this.#liveExpiryTimers.values()) this.#options.clearTimer(timer);
    this.#liveExpiryTimers.clear();
    for (const timer of this.#keyHoldTimers.values()) this.#options.clearTimer(timer);
    this.#keyHoldTimers.clear();
    this.#heldActionIds.clear();
    for (const timer of this.#pendingTapTimers.values()) this.#options.clearTimer(timer);
    this.#pendingTapTimers.clear();
    this.#pendingTapTaskIds.clear();
    this.#keyDownTaskIds.clear();
    this.#doubleTapTaskIds.clear();
    for (const timer of this.#highlightExpiryTimers.values()) this.#options.clearTimer(timer);
    this.#highlightExpiryTimers.clear();
    this.#highlightedTaskIds.clear();
    void this.#stopCatalogClient();
    this.#ongoingGoalByTaskId.clear();
    this.#options.desktopIpc.stop();
    this.#stopWorkspaceMetadataWatch?.();
    this.#stopWorkspaceMetadataWatch = null;
    this.#registry.clear();
    this.#modelKeyActions.clear();
    this.#modelInspectorConsumers.clear();
    for (const entry of this.#fastModeActions.values()) entry.animator.dispose();
    this.#fastModeActions.clear();
    this.#knownServiceTiers.clear();
    this.#models = [];
    this.#modelCatalogError = null;
    this.#propertyInspectorConsumers.clear();
    this.#live.clear();
    this.#catalogView = Object.freeze({ state: "cold", feed: null });
    this.#desktopState = "connecting";
    this.#reportedDesktopState = "connecting";
    this.#bundle = null;
    this.#catalogCompatibility.clearFailures();
    this.#taskChangeStatsByTaskId.clear();
    this.#ongoingGoalByTaskId.clear();
  }

  async #markUnread(actionId: string, taskId: TaskId | null): Promise<void> {
    const entry = this.#registry.get(actionId);
    if (taskId === null) {
      await entry?.action.showAlert().catch(() => undefined);
      return;
    }
    if (this.#options.desktopIpc.activeTaskId === taskId) {
      const opened = await this.#options.navigation.openNewChat();
      if (!opened) {
        await entry?.action.showAlert().catch(() => undefined);
        return;
      }
      await this.#options.desktopIpc.waitUntilTaskInactive(taskId, UNREAD_NAVIGATION_TIMEOUT_MS);
    }
    if (!this.#options.desktopIpc.markTaskUnread(taskId)) {
      await entry?.action.showAlert().catch(() => undefined);
    }
  }

  async #toggleHighlight(actionId: string, taskId: TaskId | null): Promise<void> {
    const entry = this.#registry.get(actionId);
    if (taskId === null) {
      await entry?.action.showAlert().catch(() => undefined);
      return;
    }
    const existingTimer = this.#highlightExpiryTimers.get(taskId);
    if (existingTimer !== undefined) this.#options.clearTimer(existingTimer);
    this.#highlightExpiryTimers.delete(taskId);
    if (this.#highlightedTaskIds.delete(taskId)) {
      this.#renderAll();
      return;
    }
    this.#highlightedTaskIds.add(taskId);
    const timer = this.#options.setTimer(() => {
      this.#highlightExpiryTimers.delete(taskId);
      if (this.#highlightedTaskIds.delete(taskId)) this.#renderAll();
    }, TASK_HIGHLIGHT_DURATION_MS);
    this.#highlightExpiryTimers.set(taskId, timer);
    this.#renderAll();
  }

  async #pressTask(actionId: string, taskId: TaskId | null): Promise<void> {
    const activatedTaskId = await this.#registry.pressTask(actionId, taskId, this.#options.navigation);
    if (activatedTaskId !== null) this.#options.desktopIpc.selectActiveTask(activatedTaskId);
    await this.#sendPropertyInspector(actionId);
  }

  #clearKeyHold(actionId: string): void {
    const timer = this.#keyHoldTimers.get(actionId);
    if (timer !== undefined) this.#options.clearTimer(timer);
    this.#keyHoldTimers.delete(actionId);
  }

  #clearPendingTap(actionId: string): void {
    const timer = this.#pendingTapTimers.get(actionId);
    if (timer !== undefined) this.#options.clearTimer(timer);
    this.#pendingTapTimers.delete(actionId);
    this.#pendingTapTaskIds.delete(actionId);
  }

  #ensureStarted(): void {
    if (this.#running) return;
    this.#running = true;
    this.#generation += 1;
    try {
      this.#stopWorkspaceMetadataWatch = this.#options.watchWorkspaceMetadata(() => {
        if (this.#running) this.#queueCatalogRefresh();
      });
    } catch {
      this.#stopWorkspaceMetadataWatch = null;
    }
    this.#launchServices(this.#generation);
  }

  #launchServices(generation: number): void {
    void this.#startIpc(generation);
    void this.#startCatalog(generation);
  }

  async #startIpc(generation: number): Promise<void> {
    if (!this.#running || generation !== this.#generation || this.#ipcTimer !== null) return;
    try {
      await this.#options.desktopIpc.start();
    } catch {
      if (this.#running && generation === this.#generation) this.#scheduleIpcRetry();
    }
  }

  #scheduleIpcRetry(): void {
    if (this.#ipcTimer !== null || !this.#running || this.#chatGptNotRunning) return;
    const generation = this.#generation;
    const delay = computeRetryDelayMs(this.#ipcAttempt, this.#options.random);
    this.#ipcAttempt += 1;
    this.#ipcRetryAt = this.#options.now() + delay;
    this.#ipcTimer = this.#options.setTimer(() => {
      this.#ipcTimer = null;
      this.#ipcRetryAt = null;
      void this.#startIpc(generation);
    }, delay);
    void this.#sendVisiblePropertyInspector();
  }

  #clearIpcRetry(): void {
    if (this.#ipcTimer !== null) this.#options.clearTimer(this.#ipcTimer);
    this.#ipcTimer = null;
    this.#ipcRetryAt = null;
  }

  #acceptDesktopState(state: DesktopState, immediate = false): void {
    const recoveredBeforeWarning = state === "online"
      && this.#desktopState === "online"
      && this.#desktopWarningTimer !== null;
    this.#reportedDesktopState = state;
    if (!this.#running && !immediate) return;
    if (state === "online" || state === "incompatible" || immediate || this.#desktopState !== "online") {
      if (this.#desktopWarningTimer !== null) this.#options.clearTimer(this.#desktopWarningTimer);
      this.#desktopWarningTimer = null;
      if (state === "online" && recoveredBeforeWarning) this.#startDesktopHydrationGrace();
      if ((state === "incompatible" || immediate) && this.#desktopHydrationTimer !== null) {
        this.#options.clearTimer(this.#desktopHydrationTimer);
        this.#desktopHydrationTimer = null;
      }
      if (this.#desktopState === state) return;
      this.#desktopState = state;
      this.#renderAll();
      return;
    }
    if (this.#desktopWarningTimer !== null) return;
    const generation = this.#generation;
    this.#desktopWarningTimer = this.#options.setTimer(() => {
      this.#desktopWarningTimer = null;
      if (generation !== this.#generation || this.#reportedDesktopState === "online") return;
      this.#desktopState = this.#reportedDesktopState;
      this.#renderAll();
    }, DESKTOP_WARNING_GRACE_MS);
  }

  #startDesktopHydrationGrace(): void {
    if (this.#desktopHydrationTimer !== null) this.#options.clearTimer(this.#desktopHydrationTimer);
    this.#desktopHydrationTimer = this.#options.setTimer(() => {
      this.#desktopHydrationTimer = null;
      this.#renderAll();
    }, DESKTOP_HYDRATION_GRACE_MS);
  }

  async #startCatalog(generation: number): Promise<void> {
    // Metadata notifications may arrive while resolution or initialization is still awaiting.
    if (!this.#running || generation !== this.#generation
      || this.#catalogStartGeneration === generation || this.#catalogClient !== null) return;
    this.#catalogStartGeneration = generation;
    let client: CatalogClientLifecyclePort | null = null;
    try {
      if (this.#catalogStopped !== null) await this.#catalogStopped;
      if (!this.#running || generation !== this.#generation) return;
      const bundle = await this.#options.bundleResolver.resolve();
      if (!this.#running || generation !== this.#generation) return;
      this.#bundle = bundle;
      this.#catalogCompatibility.observeFingerprint(bundle.fingerprint);
      this.#options.desktopIpc.setCompatibilityFingerprint(`${bundle.appVersion}\u0000${bundle.appBuild}`);
      if (this.#catalogCompatibility.incompatible) {
        this.#catalogView = Object.freeze({ state: "incompatible", feed: this.#catalogView.feed });
        this.#renderAll();
        this.#scheduleCatalog(10_000, true);
        return;
      }
      client = this.#options.catalogClientFactory(bundle.binaryPath);
      this.#catalogClient = client;
      await client.start();
      if (!this.#running || generation !== this.#generation) {
        await this.#stopCatalogClient(client);
        return;
      }
      this.#catalogService = new TaskCatalogService(client, {
        readMetadata: this.#options.readWorkspaceMetadata,
      });
      if (this.#modelKeyActions.size > 0 || this.#modelInspectorConsumers.size > 0) {
        void this.refreshModelCatalog();
      }
      await this.#refreshCatalog(generation);
    } catch (error) {
      if (!this.#running || generation !== this.#generation) {
        if (client !== null) await this.#stopCatalogClient(client);
        return;
      }
      await this.#handleCatalogFailure(error, generation, client);
    } finally {
      if (this.#catalogStartGeneration === generation) this.#catalogStartGeneration = null;
    }
  }

  #stopCatalogClient(client = this.#catalogClient): Promise<void> {
    if (client === null) return this.#catalogStopped ?? Promise.resolve();
    if (this.#catalogClient === client) {
      this.#clearModelCatalogRefresh();
      this.#catalogClient = null;
      this.#catalogService = null;
      this.#modelCatalogError = "ChatGPT connection unavailable. Reconnecting…";
      void this.#sendVisibleModelPropertyInspectors();
    }
    let stopped = this.#catalogClientStops.get(client);
    if (stopped === undefined) {
      stopped = client.stop().catch(() => undefined);
      this.#catalogClientStops.set(client, stopped);
      // Reconnects must wait for retired processes, including ones detached by a failure.
      const retirement = Promise.all([this.#catalogStopped, stopped]).then(() => undefined);
      this.#catalogStopped = retirement;
      void retirement.then(() => {
        if (this.#catalogStopped === retirement) this.#catalogStopped = null;
      });
    }
    return this.#catalogStopped ?? stopped;
  }

  async #refreshCatalog(generation: number): Promise<void> {
    const service = this.#catalogService;
    if (service === null || this.#catalogRefreshGeneration !== null
      || !this.#running || generation !== this.#generation) return;
    this.#catalogRefreshGeneration = generation;
    try {
      await service.refresh(this.#greatestTaskPosition(), this.#liveStatuses());
      if (!this.#running || generation !== this.#generation) return;
      this.#catalogView = service.view;
      this.#catalogAttempt = 0;
      this.#catalogCompatibility.recordSuccess();
      this.#options.desktopIpc.setCatalogTaskIds(new Set(this.#catalogView.feed?.map((task) => task.id) ?? []));
      this.#hydrateVisibleTaskStatuses();
      this.#reconcileLiveExpiry();
      await this.#refreshVisibleGoals(generation);
      if (!this.#running || generation !== this.#generation) return;
      this.#queueTaskChangeRefresh(true);
      this.#renderAll();
      this.#scheduleCatalog(2_000);
    } catch (error) {
      if (!this.#running || generation !== this.#generation) return;
      this.#catalogView = service.view;
      await this.#handleCatalogFailure(error, generation, this.#catalogClient);
    } finally {
      if (this.#catalogRefreshGeneration === generation) {
        this.#catalogRefreshGeneration = null;
        if (this.#catalogRefreshQueued && this.#catalogService !== null && this.#running
          && generation === this.#generation) {
          this.#catalogRefreshQueued = false;
          this.#scheduleCatalog(100);
        }
      }
    }
  }

  #queueCatalogRefresh(): void {
    if (this.#catalogRefreshGeneration !== null) {
      this.#catalogRefreshQueued = true;
      return;
    }
    this.#scheduleCatalog(100);
  }

  async #handleCatalogFailure(
    error: unknown,
    generation: number,
    client: CatalogClientLifecyclePort | null,
  ): Promise<void> {
    if (!this.#running || generation !== this.#generation || this.#catalogClient !== client) return;
    const signature = catalogCompatibilitySignature(error);
    const incompatible = signature !== null && this.#catalogCompatibility.recordFailure(signature);
    await this.#stopCatalogClient(client);
    if (!this.#running || generation !== this.#generation || this.#catalogClient !== null) return;
    this.#ongoingGoalByTaskId.clear();
    if (incompatible) {
      this.#catalogView = Object.freeze({ state: "incompatible", feed: this.#catalogView.feed });
    } else if (this.#catalogView.state !== "stale" && this.#catalogView.state !== "unavailable") {
      this.#catalogView = this.#catalogView.feed === null
        ? Object.freeze({ state: "unavailable", feed: null })
        : Object.freeze({ state: "stale", feed: this.#catalogView.feed });
    }
    this.#renderAll();
    if (incompatible) {
      this.#scheduleCatalog(10_000, true);
      return;
    }
    this.#scheduleCatalog(computeRetryDelayMs(this.#catalogAttempt, this.#options.random), true);
    this.#catalogAttempt += 1;
  }

  #scheduleCatalog(delayMs: number, newGeneration = false): void {
    if (!this.#running) return;
    if (this.#catalogTimer !== null) this.#options.clearTimer(this.#catalogTimer);
    const generation = this.#generation;
    this.#catalogRetryAt = newGeneration ? this.#options.now() + delayMs : null;
    this.#catalogTimer = this.#options.setTimer(() => {
      if (!this.#running || generation !== this.#generation) return;
      this.#catalogTimer = null;
      this.#catalogRetryAt = null;
      if (this.#taskChangeRefreshing) {
        this.#scheduleCatalog(100, newGeneration);
        return;
      }
      if (newGeneration || this.#catalogService === null) void this.#startCatalog(generation);
      else void this.#refreshCatalog(generation);
    }, delayMs);
    void this.#sendVisiblePropertyInspector();
  }

  #snapshot(settings: TaskKeySettings): KeySnapshot {
    const selectionSettings = Object.freeze({
      ...settings,
      moveActiveUnreadThreadsToTop: this.#appearance.moveActiveUnreadThreadsToTop,
    });
    return createKeySnapshot({
      settings: selectionSettings,
      appearance: this.#appearance,
      catalog: this.#catalogView,
      desktopState: this.#desktopState,
      liveByTaskId: this.#displayLiveRecords(),
      now: this.#options.now(),
      taskChangeStatsByTaskId: this.#taskChangeStatsByTaskId,
      ongoingGoalByTaskId: this.#ongoingGoalByTaskId,
      highlightedTaskIds: this.#highlightedTaskIds,
      ...(this.#catalogService === null
        ? {}
        : { queuedFollowUpCountByTaskId: this.#catalogService.queuedFollowUpCounts() }),
    });
  }

  async #refreshVisibleGoals(generation: number): Promise<void> {
    const client = this.#catalogClient;
    const feed = this.#catalogView.feed;
    if (client?.readThreadGoal === undefined || feed === null) {
      this.#ongoingGoalByTaskId.clear();
      return;
    }
    const taskIds = new Set<TaskId>();
    if (!this.#appearance.showGoalBadge) {
      this.#ongoingGoalByTaskId.clear();
      return;
    }
    for (const entry of this.#registry.entries()) {
      const task = this.#taskForSettings(entry.settings, feed);
      if (task !== null) taskIds.add(parseTaskId(task.id));
    }
    const next = new Map<string, boolean>();
    for (const taskId of taskIds) {
      if (!this.#running || generation !== this.#generation) return;
      try {
        next.set(taskId, hasOngoingGoal(await client.readThreadGoal({ threadId: taskId })));
      } catch {
        const previous = this.#ongoingGoalByTaskId.get(taskId);
        if (previous !== undefined) next.set(taskId, previous);
      }
    }
    this.#ongoingGoalByTaskId = next;
  }

  #renderAll(): void {
    this.#registry.render((settings) => this.#snapshot(settings));
    this.#renderModelKeyActions();
    this.#renderFastModeActions();
    void this.#sendVisibleModelPropertyInspectors();
    for (const entry of this.#registry.entries()) {
      void entry.queue.whenIdle().then(() => this.#sendPropertyInspector(entry.action.id));
    }
  }

  #modelKeyImage(entry: ConfiguredModelKeyEntry): string {
    const model = this.#models.find((candidate) => candidate.model === entry.settings.model);
    const activeTaskId = this.#options.desktopIpc.activeTaskId;
    const live = activeTaskId == null ? undefined : this.#live.get(activeTaskId);
    const active = this.#reportedDesktopState === "online"
      && this.#options.desktopIpc.state === "online"
      && live?.freshness === "fresh"
      && entry.settings.model !== ""
      && live.facts.model === entry.settings.model
      && live.facts.effort !== undefined
      && (live.facts.effort ?? "") === entry.settings.effort;
    return renderModelKeyDataUrl({
      settings: entry.settings,
      modelLabel: model?.displayName ?? entry.settings.model,
      offline: this.#desktopState !== "online",
      active,
    });
  }

  #renderModelKeyActions(): void {
    for (const entry of this.#modelKeyActions.values()) {
      const image = this.#modelKeyImage(entry);
      if (image === entry.lastImage && entry.pendingImage === null) continue;
      entry.pendingImage = image;
      if (!entry.rendering) void this.#flushModelKeyImage(entry);
    }
  }

  async #flushModelKeyImage(entry: ConfiguredModelKeyEntry): Promise<void> {
    entry.rendering = true;
    try {
      while (entry.pendingImage !== null && this.#modelKeyActions.get(entry.action.id) === entry) {
        const image = entry.pendingImage;
        entry.pendingImage = null;
        try {
          await entry.action.setImage(image);
          entry.lastImage = image;
        } catch {
          entry.lastImage = "";
          await entry.action.showAlert().catch(() => undefined);
        }
      }
    } finally {
      entry.rendering = false;
    }
  }

  #renderFastModeActions(): void {
    const taskId = this.#options.desktopIpc.activeTaskId;
    let state: FastModeVisualState = "unknown";
    if (this.#desktopState === "online" && taskId !== null && this.#knownServiceTiers.has(taskId)) {
      state = this.#knownServiceTiers.get(taskId) === "priority" ? "fast" : "standard";
    }
    const signature = JSON.stringify({ taskId, state, desktopState: this.#desktopState });
    for (const entry of this.#fastModeActions.values()) {
      entry.animator.render({
        signature,
        state,
        offline: this.#desktopState !== "online",
      });
    }
  }

  #visibleTaskIds(): readonly TaskId[] {
    const feed = this.#catalogView.feed;
    if (feed === null) return [];
    const taskIds = new Set<TaskId>();
    for (const entry of this.#registry.entries()) {
      const task = this.#taskForSettings(entry.settings, feed);
      if (task !== null) taskIds.add(parseTaskId(task.id));
    }
    return [...taskIds];
  }

  #hydrateVisibleTaskStatuses(): void {
    this.#reconcileLiveExpiry();
    const feed = this.#catalogView.feed;
    if (this.#options.desktopIpc.state !== "online") return;
    const taskIds = new Set<TaskId>();
    const activeTaskId = this.#options.desktopIpc.activeTaskId;
    if ((this.#modelKeyActions.size > 0 || this.#fastModeActions.size > 0) && activeTaskId != null) {
      taskIds.add(activeTaskId);
    }
    const entries = this.#registry.entries();
    const hydrationSources = this.#appearance.moveActiveUnreadThreadsToTop
      ? new Set(entries.map((entry) => entry.settings.taskSource))
      : new Set<TaskKeySettings["taskSource"]>();
    if (hydrationSources.size > 0) {
      for (const task of feed ?? []) {
        if (hydrationSources.has(task.source)) taskIds.add(parseTaskId(task.id));
      }
    } else {
      for (const entry of entries) {
        const task = feed === null ? null : this.#taskForSettings(entry.settings, feed);
        if (task !== null) taskIds.add(parseTaskId(task.id));
      }
    }
    void this.#options.desktopIpc.hydrateTaskIds?.(taskIds);
  }

  #taskForSettings(settings: TaskKeySettings, feed: readonly CatalogTask[]): CatalogTask | null {
    return taskAtPositionForKey(feed, {
      ...settings,
      moveActiveUnreadThreadsToTop: this.#appearance.moveActiveUnreadThreadsToTop,
    }, {
      catalogState: this.#catalogView.state,
      desktopState: this.#desktopState,
      liveByTaskId: this.#displayLiveRecords(),
    });
  }

  #queueTaskChangeRefresh(immediate: boolean): void {
    if (!this.#running || !this.#appearance.showGitDiffStats || this.#taskChangeRefreshing) return;
    if (this.#taskChangeTimer !== null) return;
    const generation = this.#generation;
    this.#taskChangeTimer = this.#options.setTimer(() => {
      this.#taskChangeTimer = null;
      void this.#refreshTaskChangeStats(generation);
    }, immediate ? 0 : TASK_CHANGE_REFRESH_MS);
  }

  async #refreshTaskChangeStats(generation: number): Promise<void> {
    if (!this.#running || generation !== this.#generation || !this.#appearance.showGitDiffStats
      || this.#taskChangeRefreshing) return;
    const client = this.#catalogClient;
    if (client?.readThread === undefined) return;
    const taskIds = this.#visibleTaskIds();
    this.#taskChangeRefreshing = true;
    try {
      const byTaskId = new Map<string, TaskChangeStats>();
      for (const taskId of taskIds) {
        if (!this.#running || generation !== this.#generation || !this.#appearance.showGitDiffStats) return;
        try {
          const stats = projectTaskChangeStats(await client.readThread({ threadId: taskId }));
          if (stats !== null && (stats.added > 0 || stats.deleted > 0)) byTaskId.set(taskId, stats);
        } catch {
          // One unavailable task must not prevent other visible task footers from refreshing.
        }
      }
      if (!this.#running || generation !== this.#generation || !this.#appearance.showGitDiffStats) return;
      this.#taskChangeStatsByTaskId = byTaskId;
      this.#renderAll();
    } finally {
      this.#taskChangeRefreshing = false;
      if (this.#running && generation === this.#generation && this.#appearance.showGitDiffStats) {
        this.#queueTaskChangeRefresh(false);
      }
    }
  }

  #greatestTaskPosition(): number {
    return Math.max(
      1,
      ...this.#registry.entries().map((entry) => entry.settings.taskPosition),
    );
  }

  #liveStatuses(): ReadonlyMap<string, LiveTaskRecord["status"]> {
    return new Map([...this.#live].map(([taskId, record]) => [
      taskId,
      record.freshness === "fresh" ? record.status : "idle",
    ]));
  }

  #displayLiveRecords(): ReadonlyMap<string, LiveTaskRecord> {
    const retainLastSafeState = this.#desktopState === "online"
      && (this.#reportedDesktopState !== "online" || this.#desktopHydrationTimer !== null);
    if (!retainLastSafeState) return this.#live;
    return new Map([...this.#live].map(([taskId, record]) => [
      taskId,
      record.freshness === "stale" ? Object.freeze({ ...record, freshness: "fresh" as const }) : record,
    ]));
  }

  #catalogHas(taskId: string): boolean {
    return this.#catalogView.feed?.some((task) => task.id === taskId) === true;
  }

  #retainLiveRecord(taskId: string): boolean {
    return this.#catalogHas(taskId)
      || ((this.#modelKeyActions.size > 0 || this.#fastModeActions.size > 0)
        && this.#options.desktopIpc.activeTaskId === taskId);
  }

  #scheduleLiveExpiry(taskId: string): void {
    if (this.#liveExpiryTimers.has(taskId)) return;
    const generation = this.#generation;
    const timer = this.#options.setTimer(() => {
      this.#liveExpiryTimers.delete(taskId);
      if (generation === this.#generation && !this.#retainLiveRecord(taskId)) {
        this.#live.delete(taskId);
        this.#renderAll();
      }
    }, 30_000);
    this.#liveExpiryTimers.set(taskId, timer);
  }

  #reconcileLiveExpiry(): void {
    for (const taskId of this.#live.keys()) {
      if (this.#retainLiveRecord(taskId)) {
        const timer = this.#liveExpiryTimers.get(taskId);
        if (timer !== undefined) this.#options.clearTimer(timer);
        this.#liveExpiryTimers.delete(taskId);
      } else {
        this.#scheduleLiveExpiry(taskId);
      }
    }
  }

  async #sendVisiblePropertyInspector(): Promise<void> {
    const visible = this.#registry.entries().find((entry) => this.#propertyInspectorConsumers.has(entry.action.id));
    if (visible !== undefined) await this.#sendPropertyInspector(visible.action.id);
  }

  async #sendVisibleModelPropertyInspectors(): Promise<void> {
    for (const actionId of this.#modelInspectorConsumers) await this.#sendModelPropertyInspector(actionId);
  }

  async #sendModelPropertyInspector(actionId: string): Promise<void> {
    const entry = this.#modelKeyActions.get(actionId);
    if (entry === undefined || !this.#modelInspectorConsumers.has(actionId)) return;
    await this.#options.propertyInspector.send({
      type: "fingertip-model-state",
      actionId,
      models: this.#models.map((model) => ({ ...model,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({ ...effort })),
      })),
      loading: this.#modelCatalogLoading,
      error: this.#modelCatalogError,
      preview: this.#modelKeyImage(entry),
      activeThreadId: this.#options.desktopIpc.activeTaskId ?? null,
    }).catch(() => undefined);
  }

  async #sendPropertyInspector(actionId: string): Promise<void> {
    const entry = this.#registry.get(actionId);
    if (entry === null || !this.#propertyInspectorConsumers.has(actionId)) return;
    const [doneCustomSound, confirmationCustomSound] = await Promise.all([
      this.#options.notifier.customSoundAvailable("done"),
      this.#options.notifier.customSoundAvailable("confirmation"),
    ]);
    if (this.#registry.get(actionId) !== entry || !this.#propertyInspectorConsumers.has(actionId)) return;
    // Read the current state after asynchronous sound checks so older sends cannot restore stale diagnostics.
    const snapshot = entry.queue.displayedSnapshot ?? this.#snapshot(entry.settings);
    const code = selectDiagnosticCode({
      imageUpdateFailed: entry.queue.imageUpdateFailed,
      navigationFailed: entry.navigationFailed,
      catalogState: this.#catalogView.state,
      desktopState: this.#desktopState,
      taskLiveFreshness: snapshot.kind === "task" ? snapshot.liveFreshness : "none",
      chatGptNotRunning: this.#chatGptNotRunning,
    });
    const retrySeconds = Math.ceil(Math.max(
      0,
      (this.#catalogRetryAt ?? 0) - this.#options.now(),
      (this.#ipcRetryAt ?? 0) - this.#options.now(),
    ) / 1_000);
    await this.#options.propertyInspector.send({
      type: "fingertip-state",
      preview: renderSnapshotDataUrl(snapshot),
      appearance: this.#appearance,
      customSounds: {
        done: doneCustomSound,
        confirmation: confirmationCustomSound,
      },
      connection: {
        code,
        label: diagnosticLabel(code),
        appVersion: this.#bundle?.appVersion ?? "",
        codexVersion: this.#bundle?.codexVersion ?? "",
        retrySeconds,
      },
    }).catch(() => undefined);
  }

  #scheduleShutdownIfUnused(): void {
    if (this.#registry.size !== 0 || this.#propertyInspectorConsumers.size !== 0
      || this.#modelKeyActions.size !== 0 || this.#modelInspectorConsumers.size !== 0
      || this.#fastModeActions.size !== 0
      || this.#shutdownTimer !== null) return;
    this.#shutdownTimer = this.#options.setTimer(() => this.shutdown(), 30_000);
  }

  #cancelShutdown(): void {
    if (this.#shutdownTimer !== null) this.#options.clearTimer(this.#shutdownTimer);
    this.#shutdownTimer = null;
  }
}
