import { lstat, realpath } from "node:fs/promises";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseTaskId, type TaskId } from "../catalog/catalog-projection.ts";
import {
  applyStatusPatches,
  deriveTaskStatus,
  projectStatusSnapshot,
  toTaskLiveFacts,
  type ProjectedStatusState,
  type TaskLiveFacts,
  type TaskStatus,
} from "../status/task-status-projector.ts";
import { encodeIpcFrame, IpcFrameDecoder } from "./ipc-framer.ts";

export interface LiveTaskRecord {
  readonly taskId: TaskId;
  readonly ownerClientId: string;
  readonly revision: number;
  readonly facts: TaskLiveFacts;
  readonly status: TaskStatus;
  readonly freshness: "fresh" | "stale";
  readonly queuedFollowUpCount?: number;
}

interface OwnerState {
  readonly ownerClientId: string;
  readonly revision: number;
  readonly projection: ProjectedStatusState;
  readonly record: LiveTaskRecord;
}

interface DesktopIpcAdapterOptions {
  readonly tempDirectory: string;
  readonly homeDirectory: string;
  readonly createConnection: (socketPath: string) => Socket;
  readonly setTimer: typeof setTimeout;
  readonly clearTimer: typeof clearTimeout;
}

interface IpcSocketEndpoint {
  readonly socketPath: string;
  readonly rootDirectory: string;
  readonly rootMustBePrivate: boolean;
  readonly directories: readonly Readonly<{ path: string; mustBePrivate: boolean }>[];
}

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

type Listener<T> = (event: T) => void;

// A renderer handoff can take several seconds when ChatGPT hydrates a large
// conversation snapshot. Keep the last known state during that handoff instead
// of briefly presenting just that task as offline.
const OWNER_HANDOFF_GRACE_MS = 10_000;
const QUEUED_FOLLOW_UP_HANDOFF_GRACE_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128) {
    throw new TypeError("invalid IPC identifier");
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new TypeError("invalid IPC revision");
  }
  return value;
}

function currentUid(): number {
  if (process.getuid === undefined) throw new Error("desktop IPC requires macOS UID support");
  return process.getuid();
}

function immutableRecord(
  taskId: TaskId,
  ownerClientId: string,
  revision: number,
  projection: ProjectedStatusState,
  freshness: "fresh" | "stale",
  hasQueuedFollowUp = false,
  queuedFollowUpCount = 0,
): LiveTaskRecord {
  const projectedFacts = toTaskLiveFacts(projection);
  const facts = hasQueuedFollowUp
    ? Object.freeze({ ...projectedFacts, hasQueuedFollowUp: true as const })
    : projectedFacts;
  return Object.freeze({
    taskId,
    ownerClientId,
    revision,
    facts,
    status: deriveTaskStatus(facts),
    freshness,
    ...(queuedFollowUpCount > 0 ? { queuedFollowUpCount } : {}),
  });
}

export class ChatGptDesktopIpcAdapter {
  readonly #options: DesktopIpcAdapterOptions;
  readonly #taskListeners = new Set<Listener<LiveTaskRecord>>();
  readonly #healthListeners = new Set<Listener<"connecting" | "online" | "offline" | "incompatible">>();
  readonly #catalogHintListeners = new Set<Listener<TaskId>>();
  readonly #activeTaskListeners = new Set<Listener<TaskId | null>>();
  readonly #owners = new Map<TaskId, OwnerState>();
  readonly #tasksWithRunnableQueuedFollowUps = new Set<TaskId>();
  readonly #queuedFollowUpCountByTaskId = new Map<TaskId, number>();
  readonly #queuedFollowUpHandoffs = new Set<TaskId>();
  readonly #queuedFollowUpHandoffTimers = new Map<TaskId, ReturnType<typeof setTimeout>>();
  readonly #ownerHandoffTimers = new Map<TaskId, ReturnType<typeof setTimeout>>();
  readonly #followedTaskIds = new Set<TaskId>();
  readonly #hydrationsInFlight = new Set<TaskId>();
  readonly #externalFollowingByClientId = new Map<string, TaskId>();
  #requestedHydrationTaskIds = new Set<TaskId>();
  #catalogTaskIds = new Set<TaskId>();
  #socket: Socket | null = null;
  #decoder: IpcFrameDecoder | null = null;
  #clientId: string | null = null;
  #requestId: string | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #startResolve: (() => void) | null = null;
  #startReject: ((error: Error) => void) | null = null;
  #stopping = false;
  #connectionGeneration = 0;
  #compatibilityFingerprint = "";
  #schemaFailureCount = 0;
  #lastSchemaFailureSignature = "";
  #incompatibleLatched = false;
  #state: "connecting" | "online" | "offline" | "incompatible" = "offline";
  #activeTaskId: TaskId | null = null;

  constructor(options?: Partial<DesktopIpcAdapterOptions>) {
    this.#options = {
      tempDirectory: options?.tempDirectory ?? os.tmpdir(),
      homeDirectory: options?.homeDirectory ?? os.homedir(),
      createConnection: options?.createConnection ?? ((socketPath) => net.createConnection(socketPath)),
      setTimer: options?.setTimer ?? setTimeout,
      clearTimer: options?.clearTimer ?? clearTimeout,
    };
  }

  get state(): "connecting" | "online" | "offline" | "incompatible" {
    return this.#state;
  }

  get activeTaskId(): TaskId | null {
    return this.#activeTaskId;
  }

  onTaskRecord(listener: Listener<LiveTaskRecord>): () => void {
    this.#taskListeners.add(listener);
    return () => this.#taskListeners.delete(listener);
  }

  onHealth(listener: Listener<"connecting" | "online" | "offline" | "incompatible">): () => void {
    this.#healthListeners.add(listener);
    return () => this.#healthListeners.delete(listener);
  }

  onCatalogHint(listener: Listener<TaskId>): () => void {
    this.#catalogHintListeners.add(listener);
    return () => this.#catalogHintListeners.delete(listener);
  }

  onActiveTask(listener: Listener<TaskId | null>): () => void {
    this.#activeTaskListeners.add(listener);
    return () => this.#activeTaskListeners.delete(listener);
  }

  waitUntilTaskInactive(taskId: TaskId, timeoutMs: number): Promise<boolean> {
    if (this.#activeTaskId !== taskId) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (inactive: boolean): void => {
        if (settled) return;
        settled = true;
        this.#options.clearTimer(timer);
        this.#activeTaskListeners.delete(onActiveTask);
        resolve(inactive);
      };
      const onActiveTask = (activeTaskId: TaskId | null): void => {
        if (activeTaskId !== taskId) finish(true);
      };
      const timer = this.#options.setTimer(() => finish(false), timeoutMs);
      this.#activeTaskListeners.add(onActiveTask);
    });
  }

  setCatalogTaskIds(taskIds: ReadonlySet<TaskId>): void {
    this.#catalogTaskIds = new Set(taskIds);
  }

  getRecord(taskId: TaskId): LiveTaskRecord | null {
    return this.#owners.get(taskId)?.record ?? null;
  }

  selectActiveTask(taskId: TaskId): void {
    this.#setActiveTask(taskId);
    this.#reconcileFollowing();
  }

  markTaskUnread(taskId: TaskId): boolean {
    if (this.#state !== "online" || this.#clientId === null) return false;
    try {
      this.#write({
        type: "broadcast",
        method: "thread-read-state-changed",
        version: 2,
        sourceClientId: this.#clientId,
        params: { conversationId: taskId, hostId: "local", hasUnreadTurn: true },
      });
      const current = this.#owners.get(taskId);
      if (current !== undefined) {
        const projection = applyStatusPatches(current.projection, [{
          op: "replace",
          path: ["hasUnreadTurn"],
          value: true,
        }]);
        this.#publish(taskId, current.ownerClientId, current.revision, projection);
      }
      return true;
    } catch {
      return false;
    }
  }

  async hydrateTaskIds(taskIds: Iterable<TaskId>): Promise<void> {
    this.#requestedHydrationTaskIds = new Set(taskIds);
    this.#reconcileFollowing();
  }

  #reconcileFollowing(): void {
    if (this.#state !== "online" || this.#clientId === null) return;
    const desiredTaskIds = new Set(this.#requestedHydrationTaskIds);
    if (this.#activeTaskId !== null) desiredTaskIds.add(this.#activeTaskId);
    for (const taskId of this.#followedTaskIds) {
      if (desiredTaskIds.has(taskId)) continue;
      this.#announceFollowing(taskId, false);
      this.#followedTaskIds.delete(taskId);
      this.#hydrationsInFlight.delete(taskId);
    }
    for (const taskId of desiredTaskIds) {
      if (this.#followedTaskIds.has(taskId)) continue;
      this.#followedTaskIds.add(taskId);
      this.#hydrationsInFlight.add(taskId);
      this.#announceFollowing(taskId, true);
    }
  }

  setCompatibilityFingerprint(fingerprint: string): void {
    if (fingerprint === this.#compatibilityFingerprint) return;
    this.#compatibilityFingerprint = fingerprint;
    this.#schemaFailureCount = 0;
    this.#lastSchemaFailureSignature = "";
    this.#incompatibleLatched = false;
    if (this.#state === "incompatible") this.#setState("offline");
  }

  clearCompatibilityLatch(): void {
    this.#schemaFailureCount = 0;
    this.#lastSchemaFailureSignature = "";
    this.#incompatibleLatched = false;
    if (this.#state === "incompatible") this.#setState("offline");
  }

  async start(): Promise<void> {
    if (this.#incompatibleLatched) {
      this.#setState("incompatible");
      throw new Error("desktop IPC compatibility is latched");
    }
    if (this.#socket !== null || this.#state === "connecting" || this.#state === "online") {
      throw new Error("desktop IPC already started");
    }
    this.#stopping = false;
    const connectionGeneration = ++this.#connectionGeneration;
    this.#clearOwnerHandoffTimers();
    this.#owners.clear();
    this.#followedTaskIds.clear();
    this.#hydrationsInFlight.clear();
    this.#externalFollowingByClientId.clear();
    this.#setActiveTask(null);
    this.#tasksWithRunnableQueuedFollowUps.clear();
    this.#queuedFollowUpCountByTaskId.clear();
    this.#clearQueuedFollowUpHandoffs();
    this.#setState("connecting");
    const endpoint = await this.#findSocketEndpoint().catch((error: unknown) => {
      this.#setState("offline");
      throw error;
    });
    const { socketPath, identity: before } = endpoint;
    return new Promise<void>((resolve, reject) => {
      this.#startResolve = resolve;
      this.#startReject = reject;
      let socket: Socket;
      try {
        socket = this.#options.createConnection(socketPath);
      } catch {
        this.#failConnection("transport");
        return;
      }
      this.#socket = socket;
      this.#decoder = new IpcFrameDecoder();
      socket.once("connect", () => {
        if (connectionGeneration !== this.#connectionGeneration) return;
        void lstat(socketPath).then((after) => {
          if (connectionGeneration !== this.#connectionGeneration) return;
          if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) {
            this.#failConnection("handshake");
            return;
          }
          this.#requestId = randomUUID();
          this.#write({
            type: "request",
            requestId: this.#requestId,
            sourceClientId: "initializing-client",
            version: 0,
            method: "initialize",
            params: { clientType: "fingertip-stream-deck" },
          });
          this.#handshakeTimer = this.#options.setTimer(() => this.#failConnection("handshake"), 2_000);
        }).catch(() => this.#failConnection("handshake"));
      });
      socket.on("data", (chunk) => {
        if (connectionGeneration === this.#connectionGeneration) this.#receive(chunk);
      });
      socket.once("error", () => {
        if (connectionGeneration === this.#connectionGeneration) this.#failConnection("transport");
      });
      socket.once("close", () => {
        if (connectionGeneration === this.#connectionGeneration
          && !this.#stopping && this.#state !== "incompatible") this.#failConnection("transport");
      });
    });
  }

  stop(): void {
    this.#stopping = true;
    this.#connectionGeneration += 1;
    this.#clearHandshakeTimer();
    this.#socket?.destroy();
    this.#socket = null;
    this.#decoder = null;
    this.#clientId = null;
    this.#requestId = null;
    this.#rejectStart(new Error("desktop IPC stopped"));
    this.#clearOwnerHandoffTimers();
    this.#setState(this.#incompatibleLatched ? "incompatible" : "offline");
    this.#markAllStale();
    this.#setActiveTask(null);
    this.#tasksWithRunnableQueuedFollowUps.clear();
    this.#queuedFollowUpCountByTaskId.clear();
    this.#followedTaskIds.clear();
    this.#hydrationsInFlight.clear();
    this.#externalFollowingByClientId.clear();
    this.#clearQueuedFollowUpHandoffs();
  }

  async #findSocketEndpoint(): Promise<Readonly<{ socketPath: string; identity: SocketIdentity }>> {
    let lastError: unknown = null;
    for (const endpoint of this.#socketEndpoints()) {
      try {
        return Object.freeze({
          socketPath: endpoint.socketPath,
          identity: await this.#validateSocketPath(endpoint),
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("desktop IPC socket is unavailable");
  }

  #socketEndpoints(): readonly IpcSocketEndpoint[] {
    const homeCodexDirectory = path.join(this.#options.homeDirectory, ".codex");
    return Object.freeze([
      // ChatGPT desktop 26.715+ keeps the live IPC endpoint with the shared
      // Codex state, rather than below the per-boot temporary directory.
      Object.freeze({
        socketPath: path.join(homeCodexDirectory, "ipc", "ipc.sock"),
        rootDirectory: this.#options.homeDirectory,
        rootMustBePrivate: false,
        directories: Object.freeze([
          Object.freeze({ path: homeCodexDirectory, mustBePrivate: false }),
          Object.freeze({ path: path.join(homeCodexDirectory, "ipc"), mustBePrivate: true }),
        ]),
      }),
      // Keep support for the earlier desktop builds while they remain in use.
      Object.freeze({
        socketPath: path.join(this.#options.tempDirectory, "codex-ipc", `ipc-${currentUid()}.sock`),
        rootDirectory: this.#options.tempDirectory,
        rootMustBePrivate: true,
        directories: Object.freeze([
          Object.freeze({ path: path.join(this.#options.tempDirectory, "codex-ipc"), mustBePrivate: true }),
        ]),
      }),
    ]);
  }

  async #validateSocketPath(endpoint: IpcSocketEndpoint): Promise<SocketIdentity> {
    const uid = currentUid();
    const root = await lstat(endpoint.rootDirectory);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== uid
      || (endpoint.rootMustBePrivate && (root.mode & 0o077) !== 0)) {
      throw new Error("untrusted IPC root directory");
    }
    let canonicalParent = await realpath(endpoint.rootDirectory);
    for (const directoryRequirement of endpoint.directories) {
      const directory = await lstat(directoryRequirement.path);
      const canonicalDirectory = await realpath(directoryRequirement.path);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid
        || (directoryRequirement.mustBePrivate && (directory.mode & 0o077) !== 0)
        || path.dirname(canonicalDirectory) !== canonicalParent) {
        throw new Error("untrusted IPC directory");
      }
      canonicalParent = canonicalDirectory;
    }
    const socket = await lstat(endpoint.socketPath);
    if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o022) !== 0) {
      throw new Error("untrusted IPC socket");
    }
    return Object.freeze({ dev: socket.dev, ino: socket.ino });
  }

  #receive(chunk: Buffer): void {
    const decoder = this.#decoder;
    if (decoder === null) return;
    let messages: readonly Readonly<Record<string, unknown>>[];
    try {
      messages = decoder.push(chunk);
    } catch {
      this.#failConnection("transport");
      return;
    }
    for (const message of messages) {
      try {
        this.#handleMessage(message);
      } catch (error) {
        const signature = error instanceof Error ? error.message : "unknown-schema";
        this.#failConnection(this.#state === "connecting" ? "handshake" : "schema", signature);
        return;
      }
    }
  }

  #handleMessage(message: Readonly<Record<string, unknown>>): void {
    if (message.type === "client-discovery-request") {
      const requestId = boundedString(message.requestId);
      if (!isRecord(message.request) || !Number.isSafeInteger(message.request.version)) {
        throw new TypeError("invalid discovery envelope");
      }
      boundedString(message.request.method);
      this.#write({ type: "client-discovery-response", requestId, response: { canHandle: false } });
      return;
    }
    if (message.type === "request") {
      const requestId = boundedString(message.requestId);
      boundedString(message.method);
      if (!Number.isSafeInteger(message.version)) throw new TypeError("invalid direct request envelope");
      this.#write({ type: "response", requestId, resultType: "error", error: "no-handler-for-request" });
      return;
    }
    if (this.#state === "connecting" && message.type === "response") {
      this.#acceptInitializeResponse(message);
      return;
    }
    if (message.type === "response" && this.#state === "online") return;
    if (message.type !== "broadcast" || this.#state !== "online") return;
    const method = boundedString(message.method);
    if (method === "thread-stream-state-changed") {
      if (message.version !== 11) return this.#latchIncompatible();
      this.#handleStreamChange(message);
      return;
    }
    if (method === "thread-stream-following-status-requested") {
      if (message.version !== 1) return this.#latchIncompatible();
      const params = message.params;
      if (!isRecord(params) || params.hostId !== "local") return;
      let taskId: TaskId;
      try {
        taskId = parseTaskId(params.conversationId);
      } catch {
        return;
      }
      if (this.#followedTaskIds.has(taskId)) {
        this.#announceFollowing(taskId, true, [boundedString(message.sourceClientId)]);
      }
      return;
    }
    if (method === "thread-read-state-changed") {
      // Desktop 26.715 raised the envelope version without changing the
      // sanitized conversationId/hasUnreadTurn payload used below.
      if (message.version !== 1 && message.version !== 2) return this.#latchIncompatible();
      this.#handleReadState(message);
      return;
    }
    if (method === "thread-stream-following-changed") {
      if (message.version !== 1) return this.#latchIncompatible();
      this.#handleFollowingChange(message);
      return;
    }
    if (method === "thread-queued-followups-changed") {
      if (message.version === 1) this.#handleQueuedFollowUps(message);
      return;
    }
    if (method === "thread-archived" || method === "thread-unarchived") {
      const expected = method === "thread-archived" ? 2 : 1;
      if (message.version !== expected) return;
      const params = message.params;
      if (!isRecord(params) || params.hostId !== "local") return;
      let taskId: TaskId;
      try {
        taskId = parseTaskId(params.conversationId);
      } catch {
        return;
      }
      if (method === "thread-archived") {
        this.#tasksWithRunnableQueuedFollowUps.delete(taskId);
        this.#queuedFollowUpCountByTaskId.delete(taskId);
        this.#clearQueuedFollowUpHandoff(taskId);
      }
      this.#emitCatalogHint(taskId);
      return;
    }
    if (method === "client-status-changed" && message.version === 0) this.#handleClientStatus(message);
  }

  #acceptInitializeResponse(message: Readonly<Record<string, unknown>>): void {
    if (message.requestId !== this.#requestId || message.resultType !== "success" || message.method !== "initialize"
      || !isRecord(message.result)) throw new TypeError("invalid IPC initialize response");
    const handledByClientId = boundedString(message.handledByClientId);
    const resultClientId = boundedString(message.result.clientId);
    if (handledByClientId !== resultClientId) throw new TypeError("IPC client ID mismatch");
    this.#clientId = resultClientId;
    this.#clearHandshakeTimer();
    this.#setState("online");
    this.#reconcileFollowing();
    const resolve = this.#startResolve;
    this.#startResolve = null;
    this.#startReject = null;
    resolve?.();
  }

  #handleStreamChange(message: Readonly<Record<string, unknown>>): void {
    const ownerClientId = boundedString(message.sourceClientId);
    const params = message.params;
    if (!isRecord(params) || !isRecord(params.change)) {
      throw new TypeError("invalid stream change");
    }
    if (params.hostId !== "local") return;
    const taskId = parseTaskId(params.conversationId);
    const change = params.change;
    const current = this.#owners.get(taskId);
    if (change.type === "snapshot") {
      const revision = nonNegativeInteger(change.revision);
      if (current?.ownerClientId === ownerClientId && revision <= current.revision) return;
      const projection = projectStatusSnapshot(change.conversationState);
      this.#hydrationsInFlight.delete(taskId);
      this.#publish(taskId, ownerClientId, revision, projection);
      this.#schemaFailureCount = 0;
      this.#lastSchemaFailureSignature = "";
      if (!this.#catalogTaskIds.has(taskId)) this.#emitCatalogHint(taskId);
      return;
    }
    if (change.type !== "patches") throw new TypeError("invalid stream change kind");
    const baseRevision = nonNegativeInteger(change.baseRevision);
    const revision = nonNegativeInteger(change.revision);
    if (current !== undefined && current.ownerClientId === ownerClientId && revision <= current.revision) return;
    if (current === undefined || current.ownerClientId !== ownerClientId
      || baseRevision !== current.revision || revision <= baseRevision) {
      this.#followedTaskIds.add(taskId);
      this.#hydrationsInFlight.add(taskId);
      this.#announceFollowing(taskId, true, [ownerClientId]);
      return;
    }
    const projection = applyStatusPatches(current.projection, change.patches);
    this.#publish(taskId, ownerClientId, revision, projection);
    this.#schemaFailureCount = 0;
    this.#lastSchemaFailureSignature = "";
  }

  #handleFollowingChange(message: Readonly<Record<string, unknown>>): void {
    const sourceClientId = boundedString(message.sourceClientId);
    if (sourceClientId === this.#clientId) return;
    const params = message.params;
    if (!isRecord(params) || typeof params.following !== "boolean") {
      throw new TypeError("invalid following change");
    }
    if (params.hostId !== "local") return;
    const taskId = parseTaskId(params.conversationId);
    const previousTaskId = this.#externalFollowingByClientId.get(sourceClientId);
    if (params.following) {
      // ChatGPT's composer renderer follows exactly the Task it currently
      // displays. Keep this independent from Fingertip's own subscriptions,
      // which exist only to hydrate Task Keys.
      this.#externalFollowingByClientId.delete(sourceClientId);
      this.#externalFollowingByClientId.set(sourceClientId, taskId);
      this.#setActiveTask(taskId);
      this.#reconcileFollowing();
      return;
    }
    if (previousTaskId !== taskId) return;
    this.#externalFollowingByClientId.delete(sourceClientId);
    if (this.#activeTaskId !== taskId) return;
    const remainingTaskIds = [...this.#externalFollowingByClientId.values()];
    this.#setActiveTask(remainingTaskIds.at(-1) ?? null);
    this.#reconcileFollowing();
  }

  #handleReadState(message: Readonly<Record<string, unknown>>): void {
    const params = message.params;
    if (!isRecord(params) || typeof params.hasUnreadTurn !== "boolean") throw new TypeError("invalid read state");
    const taskId = parseTaskId(params.conversationId);
    if (!this.#catalogTaskIds.has(taskId)) return;
    const current = this.#owners.get(taskId);
    if (current === undefined) return;
    const projection = applyStatusPatches(current.projection, [{
      op: "replace",
      path: ["hasUnreadTurn"],
      value: params.hasUnreadTurn,
    }]);
    this.#publish(taskId, current.ownerClientId, current.revision, projection);
    this.#schemaFailureCount = 0;
    this.#lastSchemaFailureSignature = "";
  }

  #handleQueuedFollowUps(message: Readonly<Record<string, unknown>>): void {
    const params = message.params;
    if (!isRecord(params) || !Array.isArray(params.messages) || params.messages.length > 256) return;
    const messages = params.messages;
    let taskId: TaskId;
    try {
      taskId = parseTaskId(params.conversationId);
    } catch {
      return;
    }
    let hasRunnableQueuedFollowUp = false;
    for (const candidate of messages) {
      if (!isRecord(candidate)) return;
      const pausedReason = candidate.pausedReason;
      if (pausedReason === undefined || pausedReason === null) {
        hasRunnableQueuedFollowUp = true;
      } else if (typeof pausedReason !== "string" || Buffer.byteLength(pausedReason, "utf8") > 128) {
        return;
      }
    }
    const current = this.#owners.get(taskId);
    if (messages.length > 0) this.#queuedFollowUpCountByTaskId.set(taskId, messages.length);
    else this.#queuedFollowUpCountByTaskId.delete(taskId);
    const previouslyRunnable = this.#tasksWithRunnableQueuedFollowUps.has(taskId);
    if (hasRunnableQueuedFollowUp) {
      this.#tasksWithRunnableQueuedFollowUps.add(taskId);
      this.#clearQueuedFollowUpHandoff(taskId);
    } else {
      this.#tasksWithRunnableQueuedFollowUps.delete(taskId);
      const automaticHandoff = previouslyRunnable
        && messages.length === 0
        && current !== undefined
        && deriveTaskStatus(toTaskLiveFacts(current.projection)) === "done";
      if (automaticHandoff) this.#scheduleQueuedFollowUpHandoff(taskId);
      else this.#clearQueuedFollowUpHandoff(taskId);
    }
    if (current !== undefined) {
      this.#publish(taskId, current.ownerClientId, current.revision, current.projection);
    }
  }

  #handleClientStatus(message: Readonly<Record<string, unknown>>): void {
    const params = message.params;
    if (!isRecord(params) || params.status !== "disconnected") return;
    const clientId = boundedString(params.clientId);
    const selectedTaskId = this.#externalFollowingByClientId.get(clientId);
    if (selectedTaskId !== undefined) {
      this.#externalFollowingByClientId.delete(clientId);
      if (this.#activeTaskId === selectedTaskId) {
        const remainingTaskIds = [...this.#externalFollowingByClientId.values()];
        this.#setActiveTask(remainingTaskIds.at(-1) ?? null);
        this.#reconcileFollowing();
      }
    }
    for (const [taskId, owner] of this.#owners) {
      if (owner.ownerClientId !== clientId || owner.record.freshness === "stale") continue;
      this.#scheduleOwnerHandoff(taskId, clientId);
    }
  }

  #setActiveTask(taskId: TaskId | null): void {
    if (this.#activeTaskId === taskId) return;
    this.#activeTaskId = taskId;
    for (const listener of this.#activeTaskListeners) listener(taskId);
  }

  #publish(taskId: TaskId, ownerClientId: string, revision: number, projection: ProjectedStatusState): void {
    this.#cancelOwnerHandoff(taskId);
    if (projection.runtime.type === "active") this.#clearQueuedFollowUpHandoff(taskId);
    const record = immutableRecord(
      taskId,
      ownerClientId,
      revision,
      projection,
      "fresh",
      this.#tasksWithRunnableQueuedFollowUps.has(taskId) || this.#queuedFollowUpHandoffs.has(taskId),
      this.#queuedFollowUpCountByTaskId.get(taskId) ?? 0,
    );
    this.#owners.set(taskId, Object.freeze({ ownerClientId, revision, projection, record }));
    this.#emitTask(record);
  }

  #write(message: Readonly<Record<string, unknown>>): void {
    if (this.#socket === null || this.#socket.destroyed) throw new Error("IPC socket unavailable");
    this.#socket.write(encodeIpcFrame(message));
  }

  #announceFollowing(taskId: TaskId, following: boolean, targetClientIds?: readonly string[]): void {
    this.#write({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: this.#clientId,
      ...(targetClientIds === undefined ? {} : { targetClientIds }),
      params: { conversationId: taskId, hostId: "local", following },
    });
  }

  #latchIncompatible(): void {
    this.#incompatibleLatched = true;
    this.#setState("incompatible");
    this.#clearOwnerHandoffTimers();
    this.#markAllStale();
    this.#tasksWithRunnableQueuedFollowUps.clear();
    this.#queuedFollowUpCountByTaskId.clear();
    this.#followedTaskIds.clear();
    this.#hydrationsInFlight.clear();
    this.#externalFollowingByClientId.clear();
    this.#setActiveTask(null);
    this.#clearQueuedFollowUpHandoffs();
    this.#clearHandshakeTimer();
    this.#socket?.destroy();
  }

  #failConnection(reason: "transport" | "handshake" | "schema", signature = ""): void {
    if (this.#stopping || this.#state === "incompatible") return;
    if (reason === "schema") {
      if (signature === this.#lastSchemaFailureSignature) this.#schemaFailureCount += 1;
      else {
        this.#lastSchemaFailureSignature = signature;
        this.#schemaFailureCount = 1;
      }
      if (this.#schemaFailureCount >= 3) {
        this.#latchIncompatible();
        this.#rejectStart(new Error("desktop IPC compatibility failure"));
        return;
      }
    } else {
      this.#schemaFailureCount = 0;
      this.#lastSchemaFailureSignature = "";
    }
    this.#clearHandshakeTimer();
    this.#clearOwnerHandoffTimers();
    this.#setState("offline");
    this.#markAllStale();
    this.#tasksWithRunnableQueuedFollowUps.clear();
    this.#queuedFollowUpCountByTaskId.clear();
    this.#followedTaskIds.clear();
    this.#hydrationsInFlight.clear();
    this.#externalFollowingByClientId.clear();
    this.#setActiveTask(null);
    this.#clearQueuedFollowUpHandoffs();
    this.#connectionGeneration += 1;
    this.#socket?.destroy();
    this.#socket = null;
    this.#decoder = null;
    this.#clientId = null;
    this.#requestId = null;
    this.#rejectStart(new Error("desktop IPC connection failed"));
  }

  #rejectStart(error: Error): void {
    const reject = this.#startReject;
    this.#startResolve = null;
    this.#startReject = null;
    reject?.(error);
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer !== null) this.#options.clearTimer(this.#handshakeTimer);
    this.#handshakeTimer = null;
  }

  #scheduleOwnerHandoff(taskId: TaskId, ownerClientId: string): void {
    if (this.#ownerHandoffTimers.has(taskId)) return;
    const connectionGeneration = this.#connectionGeneration;
    const timer = this.#options.setTimer(() => {
      this.#ownerHandoffTimers.delete(taskId);
      if (connectionGeneration !== this.#connectionGeneration || this.#state !== "online") return;
      const owner = this.#owners.get(taskId);
      if (owner === undefined || owner.ownerClientId !== ownerClientId || owner.record.freshness === "stale") return;
      const record = immutableRecord(
        taskId,
        owner.ownerClientId,
        owner.revision,
        owner.projection,
        "stale",
        this.#tasksWithRunnableQueuedFollowUps.has(taskId) || this.#queuedFollowUpHandoffs.has(taskId),
        this.#queuedFollowUpCountByTaskId.get(taskId) ?? 0,
      );
      this.#owners.set(taskId, Object.freeze({ ...owner, record }));
      this.#emitTask(record);
    }, OWNER_HANDOFF_GRACE_MS);
    this.#ownerHandoffTimers.set(taskId, timer);
  }

  #cancelOwnerHandoff(taskId: TaskId): void {
    const timer = this.#ownerHandoffTimers.get(taskId);
    if (timer !== undefined) this.#options.clearTimer(timer);
    this.#ownerHandoffTimers.delete(taskId);
  }

  #clearOwnerHandoffTimers(): void {
    for (const timer of this.#ownerHandoffTimers.values()) this.#options.clearTimer(timer);
    this.#ownerHandoffTimers.clear();
  }

  #scheduleQueuedFollowUpHandoff(taskId: TaskId): void {
    if (this.#queuedFollowUpHandoffs.has(taskId)) return;
    this.#queuedFollowUpHandoffs.add(taskId);
    const connectionGeneration = this.#connectionGeneration;
    const timer = this.#options.setTimer(() => {
      this.#queuedFollowUpHandoffTimers.delete(taskId);
      this.#queuedFollowUpHandoffs.delete(taskId);
      if (connectionGeneration !== this.#connectionGeneration || this.#state !== "online") return;
      const current = this.#owners.get(taskId);
      if (current !== undefined) {
        this.#publish(taskId, current.ownerClientId, current.revision, current.projection);
      }
    }, QUEUED_FOLLOW_UP_HANDOFF_GRACE_MS);
    this.#queuedFollowUpHandoffTimers.set(taskId, timer);
  }

  #clearQueuedFollowUpHandoff(taskId: TaskId): void {
    const timer = this.#queuedFollowUpHandoffTimers.get(taskId);
    if (timer !== undefined) this.#options.clearTimer(timer);
    this.#queuedFollowUpHandoffTimers.delete(taskId);
    this.#queuedFollowUpHandoffs.delete(taskId);
  }

  #clearQueuedFollowUpHandoffs(): void {
    for (const timer of this.#queuedFollowUpHandoffTimers.values()) this.#options.clearTimer(timer);
    this.#queuedFollowUpHandoffTimers.clear();
    this.#queuedFollowUpHandoffs.clear();
  }

  #markAllStale(): void {
    for (const [taskId, owner] of this.#owners) {
      if (owner.record.freshness === "stale") continue;
      const record = immutableRecord(
        taskId,
        owner.ownerClientId,
        owner.revision,
        owner.projection,
        "stale",
        this.#tasksWithRunnableQueuedFollowUps.has(taskId) || this.#queuedFollowUpHandoffs.has(taskId),
        this.#queuedFollowUpCountByTaskId.get(taskId) ?? 0,
      );
      this.#owners.set(taskId, Object.freeze({ ...owner, record }));
      this.#emitTask(record);
    }
  }

  #setState(state: "connecting" | "online" | "offline" | "incompatible"): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#healthListeners) listener(state);
  }

  #emitTask(record: LiveTaskRecord): void {
    for (const listener of this.#taskListeners) listener(record);
  }

  #emitCatalogHint(taskId: TaskId): void {
    for (const listener of this.#catalogHintListeners) listener(taskId);
  }
}
