import os from "node:os";
import path from "node:path";

import type { JsonValue } from "@elgato/utils";

import {
  AppServerCatalogClient,
  AppServerProtocolError,
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
import { MacTaskNotifier, type TaskNotifier } from "../notifications/mac-task-notifier.ts";
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
import type { DesktopState } from "./key-presentation.ts";
import { TaskKeyRegistry, type TaskKeyActionPort } from "./task-key-registry.ts";
import { renderSnapshotDataUrl } from "./task-key-render-queue.ts";
import { needsTaskStatusHydration, taskAtPositionForKey } from "./task-selection.ts";

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
const IPC_RETRY_DELAY_MS = 60_000;
const DESKTOP_WARNING_GRACE_MS = 2_500;
const TASK_CHANGE_REFRESH_MS = 45_000;
export const KEY_HOLD_THRESHOLD_MS = 600;
export const KEY_DOUBLE_TAP_WINDOW_MS = 300;
export const TASK_HIGHLIGHT_DURATION_MS = 15 * 60 * 1_000;
export const UNREAD_NAVIGATION_TIMEOUT_MS = 1_000;

interface PropertyInspectorPort {
  send(payload: JsonValue): Promise<void>;
}

export interface CatalogClientLifecyclePort extends CatalogRpcPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  readThread?(input: { readonly threadId: string }): Promise<unknown>;
  readThreadGoal?(input: { readonly threadId: string }): Promise<unknown>;
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
      if (state === "online") {
        this.#ipcAttempt = 0;
        this.#ipcRetryAt = null;
        this.#chatGptNotRunning = false;
        this.#hydrateVisibleTaskStatuses();
      }
      if (state === "offline" && this.#running) this.#scheduleIpcRetry();
    });
    this.#options.desktopIpc.onTaskRecord((record) => {
      const previous = this.#live.get(record.taskId);
      const visibleTaskIds = new Set(this.#visibleTaskIds());
      const visibleTask = this.#catalogView.feed?.find((task) => task.id === record.taskId
        && visibleTaskIds.has(task.id));
      this.#live.set(record.taskId, record);
      if (this.#catalogService !== null) {
        this.#catalogView = this.#catalogService.rerank(this.#liveStatuses());
        this.#hydrateVisibleTaskStatuses();
      }
      const notification = visibleTask === undefined
        ? null
        : taskTransitionNotification(previous, record, this.#appearance, visibleTask.title);
      if (notification !== null) this.#options.notifier.notify(notification);
      if (!this.#catalogHas(record.taskId)) this.#scheduleLiveExpiry(record.taskId);
      this.#renderAll();
    });
    this.#options.desktopIpc.onActiveTask?.(() => this.#renderAll());
    this.#options.desktopIpc.onCatalogHint(() => this.#queueCatalogRefresh());
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
    this.#chatGptNotRunning = false;
    this.#catalogAttempt = 0;
    this.#ipcAttempt = 0;
    this.#catalogRefreshGeneration = null;
    this.#catalogRefreshQueued = false;
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
    const catalogStopped = this.#catalogClient?.stop() ?? Promise.resolve();
    this.#catalogClient = null;
    this.#catalogService = null;
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
    this.#catalogRefreshGeneration = null;
    this.#catalogRefreshQueued = false;
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
    this.#catalogClient?.stop();
    this.#catalogClient = null;
    this.#catalogService = null;
    this.#ongoingGoalByTaskId.clear();
    this.#options.desktopIpc.stop();
    this.#stopWorkspaceMetadataWatch?.();
    this.#stopWorkspaceMetadataWatch = null;
    this.#registry.clear();
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
    const delay = IPC_RETRY_DELAY_MS;
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
    }, DESKTOP_WARNING_GRACE_MS);
  }

  async #startCatalog(generation: number): Promise<void> {
    if (!this.#running || generation !== this.#generation) return;
    try {
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
      const client = this.#options.catalogClientFactory(bundle.binaryPath);
      this.#catalogClient = client;
      await client.start();
      if (!this.#running || generation !== this.#generation) {
        client.stop();
        return;
      }
      this.#catalogService = new TaskCatalogService(client, {
        readMetadata: this.#options.readWorkspaceMetadata,
      });
      await this.#refreshCatalog(generation);
    } catch (error) {
      if (!this.#running || generation !== this.#generation) return;
      await this.#handleCatalogFailure(error);
    }
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
      await this.#handleCatalogFailure(error);
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

  async #handleCatalogFailure(error: unknown): Promise<void> {
    const signature = catalogCompatibilitySignature(error);
    const incompatible = signature !== null && this.#catalogCompatibility.recordFailure(signature);
    await (this.#catalogClient?.stop() ?? Promise.resolve());
    this.#catalogClient = null;
    this.#catalogService = null;
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
    return createKeySnapshot({
      settings,
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
    for (const entry of this.#registry.entries()) {
      void entry.queue.whenIdle().then(() => this.#sendPropertyInspector(entry.action.id));
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
    const feed = this.#catalogView.feed;
    if (feed === null || this.#options.desktopIpc.state !== "online") return;
    const taskIds = new Set<TaskId>();
    const entries = this.#registry.entries();
    const hydrationSources = new Set(entries
      .filter((entry) => needsTaskStatusHydration(entry.settings))
      .map((entry) => entry.settings.taskSource));
    if (hydrationSources.size > 0) {
      for (const task of feed) {
        if (hydrationSources.has(task.source)) taskIds.add(parseTaskId(task.id));
      }
    } else {
      for (const entry of entries) {
        const task = this.#taskForSettings(entry.settings, feed);
        if (task !== null) taskIds.add(parseTaskId(task.id));
      }
    }
    void this.#options.desktopIpc.hydrateTaskIds?.(taskIds);
  }

  #taskForSettings(settings: TaskKeySettings, feed: readonly CatalogTask[]): CatalogTask | null {
    return taskAtPositionForKey(feed, settings, {
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

  #scheduleLiveExpiry(taskId: string): void {
    if (this.#liveExpiryTimers.has(taskId)) return;
    const generation = this.#generation;
    const timer = this.#options.setTimer(() => {
      this.#liveExpiryTimers.delete(taskId);
      if (generation === this.#generation && !this.#catalogHas(taskId)) {
        this.#live.delete(taskId);
        this.#renderAll();
      }
    }, 30_000);
    this.#liveExpiryTimers.set(taskId, timer);
  }

  #reconcileLiveExpiry(): void {
    for (const taskId of this.#live.keys()) {
      if (this.#catalogHas(taskId)) {
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

  async #sendPropertyInspector(actionId: string): Promise<void> {
    const entry = this.#registry.get(actionId);
    if (entry === null || !this.#propertyInspectorConsumers.has(actionId)) return;
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
    const [doneCustomSound, confirmationCustomSound] = await Promise.all([
      this.#options.notifier.customSoundAvailable("done"),
      this.#options.notifier.customSoundAvailable("confirmation"),
    ]);
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
      || this.#shutdownTimer !== null) return;
    this.#shutdownTimer = this.#options.setTimer(() => this.shutdown(), 30_000);
  }

  #cancelShutdown(): void {
    if (this.#shutdownTimer !== null) this.#options.clearTimer(this.#shutdownTimer);
    this.#shutdownTimer = null;
  }
}
