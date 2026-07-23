import os from "node:os";
import path from "node:path";

import type { JsonValue } from "@elgato/utils";

import {
  AppServerCatalogClient,
  AppServerProtocolError,
} from "../catalog/app-server-catalog-client.ts";
import { parseTaskId, type TaskId } from "../catalog/catalog-projection.ts";
import { taskAtPosition } from "../catalog/task-feed.ts";
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
import { projectTaskChangeStats, type TaskChangeStats } from "../task-change-stats.ts";
import {
  renderFastModeKeyDataUrl,
  type FastModeVisualState,
} from "../rendering/utility-key-renderer.ts";
import {
  DEFAULT_TASK_KEY_APPEARANCE,
  normalizeTaskKeyAppearanceSettings,
  normalizeTaskKeySettings,
  type TaskKeySettings,
} from "../settings/task-key-settings.ts";
import { createKeySnapshot, type KeySnapshot } from "./key-snapshot.ts";
import type { DesktopState } from "./key-presentation.ts";
import { FastModeKeyAnimator } from "./fast-mode-key-animator.ts";
import { TaskKeyRegistry, type TaskKeyActionPort } from "./task-key-registry.ts";
import { renderSnapshotDataUrl } from "./task-key-render-queue.ts";

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;
const IPC_RETRY_DELAY_MS = 60_000;
const DESKTOP_WARNING_GRACE_MS = 2_500;
const TASK_CHANGE_REFRESH_MS = 45_000;

interface PropertyInspectorPort {
  send(payload: JsonValue): Promise<void>;
}

interface UtilityKeyActionPort {
  readonly id: string;
  setImage(image?: string): Promise<void>;
  showAlert(): Promise<void>;
}

interface FastModeEntry {
  readonly action: UtilityKeyActionPort;
  readonly animator: FastModeKeyAnimator;
  propertyInspectorVisible: boolean;
  state: FastModeVisualState;
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
  readonly #optimisticFastModeByTaskId = new Map<string, boolean>();
  readonly #liveExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #propertyInspectorConsumers = new Set<string>();
  readonly #fastModeActions = new Map<string, FastModeEntry>();
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
      this.#live.set(record.taskId, record);
      // Keep a successful toggle visible until ChatGPT supplies its next
      // matching service-tier value. An unrelated patch can still contain the
      // renderer's older cached settings and must not undo the successful key
      // state while ChatGPT is converging.
      const optimisticFastMode = this.#optimisticFastModeByTaskId.get(record.taskId);
      if (optimisticFastMode !== undefined && record.facts.serviceTier !== undefined
        && (record.facts.serviceTier === "priority") === optimisticFastMode) {
        this.#optimisticFastModeByTaskId.delete(record.taskId);
      }
      if (this.#catalogService !== null) {
        this.#catalogView = this.#catalogService.rerank(this.#liveStatuses());
        this.#hydrateVisibleTaskStatuses();
      }
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

  attachFastModeAction(action: UtilityKeyActionPort): void {
    const existing = this.#fastModeActions.get(action.id);
    if (existing === undefined) {
      this.#fastModeActions.set(action.id, {
        action,
        animator: new FastModeKeyAnimator(action, {
          setTimer: this.#options.setTimer,
          clearTimer: this.#options.clearTimer,
        }),
        propertyInspectorVisible: false,
        state: "unknown",
      });
    }
    this.#cancelShutdown();
    this.#ensureStarted();
    this.#renderAll();
  }

  detachFastModeAction(actionId: string): void {
    this.#fastModeActions.get(actionId)?.animator.dispose();
    this.#fastModeActions.delete(actionId);
    this.#propertyInspectorConsumers.delete(actionId);
    this.#scheduleShutdownIfUnused();
  }

  async pressFastMode(actionId: string): Promise<void> {
    const entry = this.#fastModeActions.get(actionId);
    const activeTaskId = this.#options.desktopIpc.activeTaskId;
    if (entry === undefined || activeTaskId === null || entry.state === "unknown") {
      await entry?.action.showAlert().catch(() => undefined);
      return;
    }
    const enabled = entry.state !== "fast";
    const succeeded = await this.#options.desktopIpc.setFastMode(
      parseTaskId(activeTaskId),
      enabled,
    );
    if (!succeeded) await entry.action.showAlert().catch(() => undefined);
    else {
      this.#optimisticFastModeByTaskId.set(activeTaskId, enabled);
      this.#renderAll();
    }
    await this.#sendPropertyInspector(actionId);
  }

  fastModePropertyInspectorDidAppear(actionId: string): void {
    const entry = this.#fastModeActions.get(actionId);
    if (entry === undefined) return;
    entry.propertyInspectorVisible = true;
    this.#propertyInspectorConsumers.add(actionId);
    this.#cancelShutdown();
    this.#ensureStarted();
    void this.#sendPropertyInspector(actionId);
  }

  fastModePropertyInspectorDidDisappear(actionId: string): void {
    const entry = this.#fastModeActions.get(actionId);
    if (entry !== undefined) entry.propertyInspectorVisible = false;
    this.#propertyInspectorConsumers.delete(actionId);
    this.#scheduleShutdownIfUnused();
  }

  detachAction(actionId: string): void {
    this.#registry.remove(actionId);
    this.#scheduleShutdownIfUnused();
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
    this.#catalogClient?.stop();
    this.#catalogClient = null;
    this.#catalogService = null;
    this.#ongoingGoalByTaskId.clear();
    this.#options.desktopIpc.stop();
    this.#stopWorkspaceMetadataWatch?.();
    this.#stopWorkspaceMetadataWatch = null;
    this.#registry.clear();
    for (const entry of this.#fastModeActions.values()) entry.animator.dispose();
    this.#fastModeActions.clear();
    this.#propertyInspectorConsumers.clear();
    this.#live.clear();
    this.#optimisticFastModeByTaskId.clear();
    this.#catalogView = Object.freeze({ state: "cold", feed: null });
    this.#desktopState = "connecting";
    this.#reportedDesktopState = "connecting";
    this.#bundle = null;
    this.#catalogCompatibility.clearFailures();
    this.#taskChangeStatsByTaskId.clear();
    this.#ongoingGoalByTaskId.clear();
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
      const task = taskAtPosition(feed, entry.settings.taskPosition, entry.settings.taskSource);
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
    this.#renderFastModeActions();
    for (const entry of this.#registry.entries()) {
      void entry.queue.whenIdle().then(() => this.#sendPropertyInspector(entry.action.id));
    }
  }

  #visibleTaskIds(): readonly TaskId[] {
    const feed = this.#catalogView.feed;
    if (feed === null) return [];
    const taskIds = new Set<TaskId>();
    for (const entry of this.#registry.entries()) {
      const task = taskAtPosition(feed, entry.settings.taskPosition, entry.settings.taskSource);
      if (task !== null) taskIds.add(parseTaskId(task.id));
    }
    return [...taskIds];
  }

  #hydrateVisibleTaskStatuses(): void {
    const feed = this.#catalogView.feed;
    if (feed === null || this.#options.desktopIpc.state !== "online") return;
    const taskIds = new Set<TaskId>();
    for (const entry of this.#registry.entries()) {
      const task = taskAtPosition(feed, entry.settings.taskPosition, entry.settings.taskSource);
      if (task !== null) taskIds.add(parseTaskId(task.id));
    }
    void this.#options.desktopIpc.hydrateTaskIds?.(taskIds);
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

  #renderFastModeActions(): void {
    const displayLive = this.#displayLiveRecords();
    for (const entry of this.#fastModeActions.values()) {
      const taskId = this.#options.desktopIpc.activeTaskId;
      const live = taskId === null ? null : displayLive.get(taskId) ?? null;
      const optimistic = taskId === null ? undefined : this.#optimisticFastModeByTaskId.get(taskId);
      const state: FastModeVisualState = optimistic !== undefined
        ? optimistic ? "fast" : "standard"
        : live?.freshness !== "fresh"
          ? "unknown"
          : live.facts.serviceTier === "priority" ? "fast" : "standard";
      const offline = this.#desktopState !== "online";
      const signature = JSON.stringify({
        taskId,
        state,
        offline,
      });
      entry.state = state;
      entry.animator.render({
        signature,
        state,
        offline,
      });
    }
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
    const fastEntry = this.#fastModeActions.get(actionId);
    if (fastEntry !== undefined) {
      if (!this.#propertyInspectorConsumers.has(actionId)) return;
      await this.#options.propertyInspector.send({
        type: "fingertip-fast-mode-state",
        preview: renderFastModeKeyDataUrl({
          state: fastEntry.state,
          offline: this.#desktopState !== "online",
        }),
        fastMode: fastEntry.state,
        hasActiveComposer: this.#options.desktopIpc.activeTaskId !== null,
        connection: {
          label: this.#desktopState === "online" ? "Connected" : "ChatGPT connection unavailable",
          appVersion: this.#bundle?.appVersion ?? "",
        },
      }).catch(() => undefined);
      return;
    }
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
    await this.#options.propertyInspector.send({
      type: "fingertip-state",
      preview: renderSnapshotDataUrl(snapshot),
      appearance: this.#appearance,
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
    if (this.#registry.size !== 0 || this.#fastModeActions.size !== 0
      || this.#propertyInspectorConsumers.size !== 0 || this.#shutdownTimer !== null) return;
    this.#shutdownTimer = this.#options.setTimer(() => this.shutdown(), 30_000);
  }

  #cancelShutdown(): void {
    if (this.#shutdownTimer !== null) this.#options.clearTimer(this.#shutdownTimer);
    this.#shutdownTimer = null;
  }
}
