import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { JsonValue } from "@elgato/utils";
import type { TaskId } from "../catalog/catalog-projection.ts";
import type { LiveTaskRecord } from "../desktop-ipc/chatgpt-desktop-ipc-adapter.ts";
import { taskTransitionNotification } from "../notifications/task-transition-notification.ts";
import type { TaskNotifier } from "../notifications/mac-task-notifier.ts";
import { renderModelKeyDataUrl } from "../rendering/model-key-renderer.ts";
import { createKeySnapshot } from "../runtime/key-snapshot.ts";
import { TaskKeyRegistry, type TaskKeyActionPort } from "../runtime/task-key-registry.ts";
import { renderSnapshotDataUrl } from "../runtime/task-key-render-queue.ts";
import { FastModeKeyAnimator } from "../runtime/fast-mode-key-animator.ts";
import { DEFAULT_TASK_KEY_APPEARANCE, normalizeTaskKeyAppearanceSettings, type TaskKeySettings } from "../settings/task-key-settings.ts";
import type { ModelKeySettings } from "../settings/model-key-settings.ts";
import { loadCredentials, pairT3, record, records, saveCredentials, T3Client, type T3Credentials } from "./t3-client.ts";
import { activeThread, eligible, modelOptions, modelsFromConfig, selections, taskFeed, taskKey, thread, threadLink, threadStatus, type T3Model, type T3Thread } from "./t3-projection.ts";

interface KeyPort { id: string; setImage(image: string): Promise<void>; showAlert(): Promise<void> }
interface ModelEntry { action: KeyPort; settings: ModelKeySettings; image: string; tail: Promise<unknown> }
interface Gesture { taskId: TaskId | null; timer: ReturnType<typeof setTimeout>; held: boolean; double: boolean }
export type T3RuntimeClient = Pick<T3Client, "environmentId" | "version" | "connect" | "close" | "rpc" | "http" | "subscribe">;
interface T3RuntimeOptions {
  loadCredentials(): Promise<T3Credentials | null>;
  createClient(credentials: T3Credentials, disconnected: () => void): T3RuntimeClient;
  openThread(url: string): Promise<unknown>;
}
export class T3Runtime {
  #registry = new TaskKeyRegistry(() => this.#sendInspectors());
  #models = new Map<string, ModelEntry>();
  #fast = new Map<string, FastModeKeyAnimator>();
  #inspectors = new Set<string>();
  #threads = new Map<string, T3Thread>();
  #projects = new Map<string, Record<string, unknown>>();
  #catalog: T3Model[] = [];
  #appearance = DEFAULT_TASK_KEY_APPEARANCE;
  #client: T3RuntimeClient | null = null;
  #environmentId = "offline";
  #hydration: ReturnType<typeof setTimeout> | null = null;
  #generation = 0;
  #connecting = false;
  #online = false;
  #hasSnapshot = false;
  #error = "Connect T3 Code with a pairing link in General.";
  #retry: ReturnType<typeof setTimeout> | null = null;
  #tick: ReturnType<typeof setInterval> | null = null;
  #gestures = new Map<string, Gesture>();
  #taps = new Map<string, { taskId: TaskId | null; timer: ReturnType<typeof setTimeout> }>();
  #highlighted = new Map<string, number>();
  #pairing = false;
  #serverAddress = "";
  #customSounds = { done: false, confirmation: false };
  readonly #options: T3RuntimeOptions;
  readonly send: (value: JsonValue) => Promise<void>;
  readonly notifier: TaskNotifier;
  constructor(send: (value: JsonValue) => Promise<void>, notifier: TaskNotifier, options: Partial<T3RuntimeOptions> = {}) {
    this.send = send; this.notifier = notifier;
    this.#options = { loadCredentials, createClient: (credentials, disconnected) => new T3Client(credentials, disconnected),
      openThread: (url) => promisify(execFile)("/usr/bin/open", [url]), ...options };
  }
  updateAppearance(value: unknown): void { this.#appearance = normalizeTaskKeyAppearanceSettings(value); this.#render(); }
  attachAction(action: TaskKeyActionPort, settings: TaskKeySettings): void {
    this.#registry.upsert(action, settings); this.#start(); this.#render();
  }
  updateSettings(action: TaskKeyActionPort, settings: TaskKeySettings): void { this.attachAction(action, settings); }
  detachAction(id: string): void {
    this.#clearGesture(id); this.#registry.remove(id); this.#inspectors.delete(id); this.#stopIfUnused();
  }
  attachModelKeyAction(action: KeyPort, settings: ModelKeySettings): void {
    const existing = this.#models.get(action.id);
    if (existing) existing.settings = settings;
    else this.#models.set(action.id, { action, settings, image: "", tail: Promise.resolve() });
    this.#start(); this.#render();
  }
  updateModelKeySettings(action: KeyPort, settings: ModelKeySettings): void { this.attachModelKeyAction(action, settings); }
  detachModelKeyAction(id: string): void { this.#models.delete(id); this.#inspectors.delete(id); this.#stopIfUnused(); }
  attachFastModeAction(action: KeyPort): void {
    if (!this.#fast.has(action.id)) this.#fast.set(action.id, new FastModeKeyAnimator(action));
    this.#start(); this.#render();
  }
  detachFastModeAction(id: string): void { this.#fast.get(id)?.dispose(); this.#fast.delete(id); this.#stopIfUnused(); }
  propertyInspectorDidAppear(id: string): void { this.#inspectors.add(id); this.#start(); void this.refreshCustomSounds(); this.#sendInspectors(); }
  propertyInspectorDidDisappear(id: string): void { this.#inspectors.delete(id); }
  modelPropertyInspectorDidAppear(id: string): void { this.propertyInspectorDidAppear(id); }
  modelPropertyInspectorDidDisappear(id: string): void { this.propertyInspectorDidDisappear(id); }
  async refreshCustomSounds(): Promise<void> {
    const [done, confirmation] = await Promise.all([this.notifier.customSoundAvailable("done"), this.notifier.customSoundAvailable("confirmation")]);
    this.#customSounds = { done, confirmation }; this.#sendInspectors();
  }
  #start(): void {
    if (!this.#tick) this.#tick = setInterval(() => this.#render(), 15_000);
    if (!this.#client && !this.#connecting && !this.#retry) void this.#connect();
  }
  #stopIfUnused(): void { if (!this.#registry.size && !this.#models.size && !this.#fast.size) this.shutdown(); }
  #disconnect(): void {
    if (this.#hydration) clearTimeout(this.#hydration); this.#hydration = null;
    ++this.#generation; this.#connecting = false; this.#online = false;
    this.#client?.close(); this.#client = null;
    if (this.#retry) clearTimeout(this.#retry); this.#retry = null;
    if (this.#tick) clearInterval(this.#tick); this.#tick = null;
    for (const id of new Set([...this.#gestures.keys(), ...this.#taps.keys()])) this.#clearGesture(id);
  }
  shutdown(): void {
    this.#disconnect(); this.#registry.clear(); this.#models.clear(); this.#inspectors.clear();
    for (const animator of this.#fast.values()) animator.dispose();
    this.#fast.clear();
  }
  retryNow(): void { this.#disconnect(); if (this.#registry.size || this.#models.size || this.#fast.size) this.#start(); this.#render(); }
  async pair(link: string, serverAddress?: string): Promise<void> {
    if (this.#pairing) return;
    this.#pairing = true;
    try {
      const credentials = await pairT3(link, fetch, serverAddress);
      await saveCredentials(credentials);
      this.#threads.clear(); this.#projects.clear(); this.#catalog = []; this.#hasSnapshot = false;
      this.retryNow();
    } catch (error) { this.#error = error instanceof Error ? error.message : "T3 pairing failed."; }
    finally { this.#pairing = false; this.#sendInspectors(); }
  }
  async #connect(): Promise<void> {
    this.#connecting = true;
    const generation = ++this.#generation;
    try {
      const credentials = await this.#options.loadCredentials();
      if (generation !== this.#generation) return;
      this.#serverAddress = credentials?.origin ?? "";
      if (!credentials) { this.#error = "Connect T3 Code with a pairing link in General."; return; }
      const client = this.#options.createClient(credentials, () => {
        if (this.#client !== client) return;
        if (this.#hydration) clearTimeout(this.#hydration); this.#hydration = null;
        this.#client = null; this.#online = false; this.#error = "T3 disconnected. Reconnecting…";
        this.#scheduleRetry(); this.#render();
      });
      this.#client = client;
      await client.connect();
      if (generation !== this.#generation || this.#client !== client) { client.close(); return; }
      this.#environmentId = client.environmentId;
      this.#hydration = setTimeout(() => {
        if (this.#client !== client) return;
        client.close(); this.#client = null; this.#online = false;
        this.#error = "T3 snapshot timed out. Reconnecting…"; this.#scheduleRetry(); this.#render();
      }, 10_000);
      // Always resubscribe from a full snapshot: no stale sequence or deleted thread survives reconnect.
      client.subscribe("orchestration.subscribeShell", {}, (value) => {
        if (this.#client === client) this.#accept(value);
      });
      client.subscribe("subscribeServerConfig", {}, (value) => {
        if (this.#client !== client) return;
        const event = record(value);
        const config = event.config ?? event.payload ?? event;
        if (Array.isArray(record(config).providers)) { this.#catalog = modelsFromConfig(config); this.#render(); }
      });
      await this.refreshModelCatalog();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#client?.close(); this.#client = null; this.#online = false;
      this.#error = error instanceof Error ? error.message : "T3 connection failed.";
      this.#scheduleRetry();
    } finally {
      if (generation === this.#generation) { this.#connecting = false; this.#render(); }
    }
  }
  #scheduleRetry(): void {
    if (!this.#retry && (this.#registry.size || this.#models.size || this.#fast.size)) {
      this.#retry = setTimeout(() => { this.#retry = null; void this.#connect(); }, 5_000);
    }
  }
  #accept(value: unknown): void {
    const event = record(value);
    if (event.kind === "snapshot") {
      // T3 also sends repository-identity enrichment snapshots with no threads.
      // They contain no fields used by our renderer and are not authoritative.
      if (event.resolvedRepositoryIdentityRoots !== undefined) return;
      const snapshot = record(event.snapshot);
      if (!Array.isArray(snapshot.threads) || !Array.isArray(snapshot.projects)) throw new Error("Invalid T3 snapshot.");
      this.#threads = new Map(snapshot.threads.map((value) => { const item = thread(value); return [item.id, item]; }));
      this.#projects = new Map(records(snapshot.projects).map((item) => [String(item.id), item]));
      if (this.#hydration) clearTimeout(this.#hydration); this.#hydration = null;
      this.#hasSnapshot = true; this.#online = true; this.#error = "";
    } else if (event.kind === "thread.updated") {
      const item = thread(event.thread);
      const previous = this.#threads.get(item.id);
      if (event.location === "archive" || item.deletedAt) this.#threads.delete(item.id);
      else { this.#threads.set(item.id, item); this.#notify(previous, item); }
    } else if (event.kind === "thread.removed") this.#threads.delete(String(event.threadId));
    else if (event.kind === "project.updated") { const item = record(event.project); this.#projects.set(String(item.id), item); }
    else if (event.kind === "project.removed") this.#projects.delete(String(event.projectId));
    this.#render();
  }
  #notify(previous: T3Thread | undefined, item: T3Thread): void {
    if (!this.#online || !previous || !eligible(item) || record(item.goal).status === "active") return;
    const key = taskKey(this.#client!.environmentId, item.id);
    if (!this.#registry.entries().some((entry) => this.#registry.displayedTaskId(entry.action.id) === key)) return;
    const live = (item: T3Thread): LiveTaskRecord => ({ taskId: key, ownerClientId: "t3", revision: 0,
      status: threadStatus(item), freshness: "fresh", facts: { isActive: false, waitingOnApproval: false, waitingOnUserInput: false, hasUnreadTurn: false } });
    const notification = taskTransitionNotification(live(previous), live(item), this.#appearance, item.title);
    if (notification) this.notifier.notify(notification);
  }
  #snapshot(settings: TaskKeySettings) {
    const environment = this.#environmentId;
    const feed = taskFeed(this.#threads.values(), this.#projects, environment, settings.taskSource);
    const live = new Map([...this.#threads.values()].map((item) => [taskKey(environment, item.id), {
      freshness: this.#online ? "fresh" as const : "stale" as const, status: threadStatus(item),
    }]));
    return createKeySnapshot({ settings: { ...settings, moveActiveUnreadThreadsToTop: this.#appearance.moveActiveUnreadThreadsToTop }, appearance: this.#appearance,
      catalog: this.#hasSnapshot ? { state: this.#online ? "fresh" : "stale", feed } : { state: this.#connecting ? "cold" : "unavailable", feed: null },
      desktopState: this.#online ? "online" : "offline", liveByTaskId: live, now: Date.now(),
      ongoingGoalByTaskId: new Map([...this.#threads.values()].map((item) => [taskKey(environment, item.id), record(item.goal).status === "active"])),
      highlightedTaskIds: new Set([...this.#highlighted].filter(([, until]) => until > Date.now()).map(([key]) => key)),
    });
  }
  #modelImage(entry: ModelEntry): string {
    const active = activeThread(this.#threads.values());
    const selection = record(active?.modelSelection);
    const model = this.#catalog.find((model) => model.model === entry.settings.model);
    return renderModelKeyDataUrl({ settings: entry.settings, modelLabel: model?.slug ?? entry.settings.model,
      offline: !this.#online, active: this.#online && !!model && selection.instanceId === model.instanceId && selection.model === model.slug
        && String(selections(selection.options).find((item) => item.id === model.effortId)?.value ?? model.defaultReasoningEffort) === entry.settings.effort });
  }
  #render(): void {
    this.#registry.render((settings) => this.#snapshot(settings));
    for (const entry of this.#models.values()) {
      const image = this.#modelImage(entry);
      if (image !== entry.image) {
        entry.image = image;
        entry.tail = entry.tail.catch(() => undefined).then(() => this.#models.get(entry.action.id) === entry ? entry.action.setImage(image) : undefined)
          .catch(() => { entry.image = ""; });
      }
    }
    const fast = this.#fastOption();
    const state = fast ? fast.enabled ? "fast" : "standard" : "unknown";
    for (const animator of this.#fast.values()) animator.render({ state, offline: !this.#online, signature: `${state}:${this.#online}` });
    this.#sendInspectors();
  }
  #sendInspectors(): void {
    for (const id of this.#inspectors) {
      const model = this.#models.get(id);
      if (model) void this.send({ type: "fingertip-model-state", actionId: id, models: this.#catalog.map((entry) => ({ model: entry.model, displayName: entry.displayName, defaultReasoningEffort: entry.defaultReasoningEffort, isDefault: entry.isDefault, supportedReasoningEfforts: entry.supportedReasoningEfforts.map((effort) => ({ ...effort })) })),
        loading: this.#connecting, error: this.#error || null, preview: this.#modelImage(model), activeThreadId: this.#online ? activeThread(this.#threads.values())?.id ?? null : null }).catch(() => undefined);
      const task = this.#registry.get(id);
      if (task) void this.send({ type: "fingertip-state", actionId: id, preview: renderSnapshotDataUrl(this.#snapshot(task.settings)), appearance: this.#appearance,
        customSounds: this.#customSounds, connection: { code: this.#online ? "ready" : "offline", label: this.#error || "T3 Code connected", appVersion: this.#client?.version ?? "", codexVersion: "", retrySeconds: this.#retry ? 5 : 0 },
      }).catch(() => undefined);
      void this.send({ type: "fingertip-t3-state", actionId: id, connected: this.#online,
        configured: !!this.#serverAddress, serverAddress: this.#serverAddress, pairing: this.#pairing,
        message: this.#pairing ? "Connecting…" : this.#error || "T3 Code connected" }).catch(() => undefined);
    }
  }
  #threadForKey(key: TaskId | null): T3Thread | undefined {
    if (!key || !this.#client) return undefined;
    return [...this.#threads.values()].find((item) => taskKey(this.#client!.environmentId, item.id) === key);
  }
  #clearGesture(id: string): void {
    const gesture = this.#gestures.get(id); if (gesture) clearTimeout(gesture.timer);
    const tap = this.#taps.get(id); if (tap) clearTimeout(tap.timer);
    this.#gestures.delete(id); this.#taps.delete(id);
  }
  keyDown(id: string): void {
    const tap = this.#taps.get(id);
    const taskId = tap?.taskId ?? this.#registry.displayedTaskId(id);
    this.#clearGesture(id);
    const gesture: Gesture = { taskId, double: !!tap, held: false, timer: setTimeout(() => {
      gesture.held = true;
      void this.#operateKey(id, taskId, true);
    }, 600) };
    this.#gestures.set(id, gesture);
  }
  async keyUp(id: string): Promise<void> {
    const gesture = this.#gestures.get(id); if (!gesture) return;
    clearTimeout(gesture.timer); this.#gestures.delete(id);
    if (gesture.held) return;
    if (gesture.double && gesture.taskId) {
      if (this.#highlighted.has(gesture.taskId)) this.#highlighted.delete(gesture.taskId);
      else this.#highlighted.set(gesture.taskId, Date.now() + 15 * 60_000);
      this.#render(); return;
    }
    this.#taps.set(id, { taskId: gesture.taskId, timer: setTimeout(() => {
      this.#taps.delete(id); void this.#operateKey(id, gesture.taskId, false);
    }, 300) });
  }
  async #operateKey(id: string, key: TaskId | null, unread: boolean): Promise<void> {
    try {
      const item = this.#threadForKey(key);
      if (!item || !this.#online || !this.#client) throw new Error("Unavailable thread.");
      if (unread) await this.#client.rpc("orchestration.dispatchCommand", { type: "thread.mark-unread", commandId: randomUUID(), threadId: item.id });
      else await this.#options.openThread(threadLink(this.#client.environmentId, item.id));
    } catch { await this.#registry.get(id)?.action.showAlert().catch(() => undefined); }
  }
  async refreshModelCatalog(): Promise<void> {
    const client = this.#client; if (!client) return;
    try {
      const config = await client.rpc("server.getConfig", {});
      if (client === this.#client) { this.#catalog = modelsFromConfig(config); this.#render(); }
    } catch { if (client === this.#client) { this.#catalog = []; this.#error = "Could not load T3 models. Check access or reconnect."; this.#render(); } }
  }
  async #setSelection(item: T3Thread, model: T3Model, options: { id: string; value: string | boolean }[]): Promise<boolean> {
    const client = this.#client; if (!client || !this.#online) return false;
    await client.rpc("orchestration.dispatchCommand", { type: "thread.model-selection.set", commandId: randomUUID(), threadId: item.id,
      modelSelection: { instanceId: model.instanceId, model: model.slug, options } });
    const snapshot = record(await client.http(`/api/orchestration/threads/${encodeURIComponent(item.id)}/bounded`));
    const selected = record(record(record(snapshot.projection).thread).modelSelection);
    return client === this.#client && this.#online && selected.instanceId === model.instanceId && selected.model === model.slug
      && options.every((option) => selections(selected.options).some((current) => current.id === option.id && current.value === option.value));
  }
  async pressModelKey(id: string): Promise<boolean> {
    const entry = this.#models.get(id); const item = activeThread(this.#threads.values());
    if (!entry || !item || !this.#online) return false;
    const { model: key, effort } = entry.settings;
    const model = this.#catalog.find((candidate) => candidate.model === key);
    if (!model || (model.supportedReasoningEfforts.length ? !model.supportedReasoningEfforts.some((value) => value.reasoningEffort === effort) : effort !== "")) return false;
    return this.#setSelection(item, model, modelOptions(model, record(item.modelSelection).options, effort));
  }
  #fastOption() {
    const item = activeThread(this.#threads.values()); if (!item) return null;
    const selection = record(item.modelSelection);
    const model = this.#catalog.find((model) => model.instanceId === selection.instanceId && model.slug === selection.model);
    if (!model) return null;
    const descriptor = model.descriptors.find((option) => option.id === "fastMode" && option.type === "boolean")
      ?? model.descriptors.find((option) => option.id === "serviceTier" && records(option.options).some((choice) => choice.id === "priority")
        && records(option.options).some((choice) => choice.id === "default"));
    if (!descriptor) return null;
    const id = String(descriptor.id);
    const value = selections(selection.options).find((option) => option.id === id)?.value ?? descriptor.currentValue;
    return { item, model, id, enabled: id === "fastMode" ? value === true : value === "priority" };
  }
  async pressFastMode(): Promise<boolean> {
    const fast = this.#fastOption(); if (!fast || !this.#online) return false;
    const options = selections(record(fast.item.modelSelection).options).filter((option) => option.id !== fast.id);
    options.push({ id: fast.id, value: fast.id === "fastMode" ? !fast.enabled : fast.enabled ? "default" : "priority" });
    try { return await this.#setSelection(fast.item, fast.model, options); } catch { return false; }
  }
}
