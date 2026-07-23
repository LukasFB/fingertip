import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const MAXIMUM_JSONL_BYTES = 16 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 5_000;

export type AppServerProtocolSignature = "initialize" | "jsonl" | "message";

export class AppServerProtocolError extends Error {
  readonly signature: AppServerProtocolSignature;

  constructor(signature: AppServerProtocolSignature) {
    super("catalog protocol is incompatible");
    this.name = "AppServerProtocolError";
    this.signature = signature;
  }
}

export interface AppServerChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

interface AppServerSpawnOptions {
  readonly shell: false;
  readonly detached: false;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly env: Readonly<Record<string, string>>;
}

export type SpawnAppServer = (
  command: string,
  args: readonly ["--enable", "goals", "app-server"],
  options: AppServerSpawnOptions,
) => AppServerChild;

interface AppServerCatalogClientOptions {
  readonly spawn: SpawnAppServer;
  readonly environment: NodeJS.ProcessEnv;
  readonly setTimer: typeof setTimeout;
  readonly clearTimer: typeof clearTimeout;
  readonly reapWaitMs: number;
}

interface PendingRequest {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForExit(exit: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    void exit.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const defaultSpawn: SpawnAppServer = (command, args, options) =>
  nodeSpawn(command, [...args], options as unknown as Parameters<typeof nodeSpawn>[2]) as ChildProcess as AppServerChild;

export function sanitizeAppServerEnvironment(source: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const allowed = new Set(["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG"]);
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && (allowed.has(key) || key.startsWith("LC_"))) projected[key] = value;
  }
  return Object.freeze(projected);
}

export class AppServerCatalogClient {
  readonly #binaryPath: string;
  readonly #options: AppServerCatalogClientOptions;
  #child: AppServerChild | null = null;
  #pending: PendingRequest | null = null;
  #nextRequestId = 1;
  #accumulator = Buffer.alloc(0);
  #exit: Promise<void> | null = null;
  #resolveExit: (() => void) | null = null;
  #stopPromise: Promise<void> | null = null;
  #invalidReason: Error | null = null;
  #state: "stopped" | "starting" | "ready" | "invalid" = "stopped";

  constructor(binaryPath: string, options?: Partial<AppServerCatalogClientOptions>) {
    this.#binaryPath = binaryPath;
    this.#options = {
      spawn: options?.spawn ?? defaultSpawn,
      environment: options?.environment ?? process.env,
      setTimer: options?.setTimer ?? setTimeout,
      clearTimer: options?.clearTimer ?? clearTimeout,
      reapWaitMs: options?.reapWaitMs ?? 2_000,
    };
  }

  get state(): "stopped" | "starting" | "ready" | "invalid" {
    return this.#state;
  }

  async start(): Promise<void> {
    if (this.#state !== "stopped") throw new Error("catalog client already started");
    this.#stopPromise = null;
    this.#invalidReason = null;
    this.#state = "starting";
    try {
      this.#child = this.#options.spawn(this.#binaryPath, ["--enable", "goals", "app-server"], {
        shell: false,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizeAppServerEnvironment(this.#options.environment),
      });
    } catch {
      this.#invalidate();
      throw new Error("catalog process spawn failed");
    }
    this.#child.stdout.on("data", (chunk: Buffer | string) => this.#receive(Buffer.from(chunk)));
    this.#child.stderr.resume();
    this.#exit = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.#child.once("error", () => this.#invalidate());
    this.#child.once("exit", () => {
      this.#resolveExit?.();
      this.#resolveExit = null;
      this.#invalidate();
    });
    const result = await this.#request("initialize", {
      clientInfo: { name: "fingertip", title: "Fingertip Stream Deck Plugin", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    if (!isRecord(result)) {
      const error = new AppServerProtocolError("initialize");
      this.#invalidate(error);
      throw error;
    }
    this.#write({ method: "initialized", params: {} });
    if (this.#state !== "starting") {
      throw this.#invalidReason ?? new AppServerProtocolError("initialize");
    }
    this.#state = "ready";
  }

  async listThreads(input: { readonly limit: number; readonly cursor?: string }): Promise<unknown> {
    if (this.#state === "invalid" && this.#invalidReason !== null) throw this.#invalidReason;
    if (this.#state !== "ready") throw new Error("catalog client is not ready");
    const params: Record<string, unknown> = {
      limit: input.limit,
      // ChatGPT's current sidebar translates its "updated_at" UI preference
      // to the App Server's stable recency key. `updated_at` also changes for
      // bookkeeping updates and therefore makes manual-order gaps jump around.
      sortKey: "recency_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
    };
    if (input.cursor !== undefined) params.cursor = input.cursor;
    return this.#request("thread/list", params);
  }

  async readThread(input: { readonly threadId: string }): Promise<unknown> {
    if (this.#state === "invalid" && this.#invalidReason !== null) throw this.#invalidReason;
    if (this.#state !== "ready") throw new Error("catalog client is not ready");
    return this.#request("thread/read", { threadId: input.threadId, includeTurns: true });
  }

  async readThreadGoal(input: { readonly threadId: string }): Promise<unknown> {
    if (this.#state === "invalid" && this.#invalidReason !== null) throw this.#invalidReason;
    if (this.#state !== "ready") throw new Error("catalog client is not ready");
    return this.#request("thread/goal/get", { threadId: input.threadId });
  }

  stop(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    const child = this.#child;
    const exit = this.#exit;
    this.#rejectPending(new Error("catalog client stopped"));
    this.#stopPromise = (async () => {
      if (child !== null && exit !== null) {
        child.stdin.end();
        if (!await waitForExit(exit, this.#options.reapWaitMs)) {
          child.kill("SIGTERM");
          if (!await waitForExit(exit, this.#options.reapWaitMs)) {
            child.kill("SIGKILL");
            await waitForExit(exit, this.#options.reapWaitMs);
          }
        }
      }
      if (this.#child === child) this.#child = null;
      this.#exit = null;
      this.#resolveExit = null;
      this.#accumulator = Buffer.alloc(0);
      this.#invalidReason = null;
      this.#state = "stopped";
    })();
    return this.#stopPromise;
  }

  #request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.#pending !== null) return Promise.reject(new Error("catalog request already in flight"));
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = this.#options.setTimer(
        () => this.#invalidate(new Error("catalog response timeout")),
        RESPONSE_TIMEOUT_MS,
      );
      this.#pending = { id, resolve, reject, timer };
      try {
        this.#write({ id, method, params });
      } catch {
        this.#invalidate(new Error("catalog process write failed"));
      }
    });
  }

  #write(value: Readonly<Record<string, unknown>>): void {
    if (this.#child === null || this.#child.stdin.destroyed) throw new Error("catalog process write failed");
    this.#child.stdin.write(`${JSON.stringify(value)}\n`, "utf8");
  }

  #receive(chunk: Buffer): void {
    if (this.#state === "invalid" || this.#state === "stopped") return;
    if (this.#accumulator.length + chunk.length > MAXIMUM_JSONL_BYTES) {
      this.#invalidate(new AppServerProtocolError("jsonl"));
      return;
    }
    this.#accumulator = Buffer.concat([this.#accumulator, chunk]);
    let newline = this.#accumulator.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.#accumulator.subarray(0, newline);
      this.#accumulator = this.#accumulator.subarray(newline + 1);
      if (line.length === 0 || line.length > MAXIMUM_JSONL_BYTES) {
        this.#invalidate(new AppServerProtocolError("jsonl"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown;
      } catch {
        this.#invalidate(new AppServerProtocolError("jsonl"));
        return;
      }
      if (!isRecord(parsed)) {
        this.#invalidate(new AppServerProtocolError("jsonl"));
        return;
      }
      if (!this.#handleMessage(parsed)) return;
      newline = this.#accumulator.indexOf(0x0a);
    }
  }

  #handleMessage(message: Record<string, unknown>): boolean {
    if ("id" in message && typeof message.method === "string") {
      const validId = (typeof message.id === "number" && Number.isSafeInteger(message.id))
        || (typeof message.id === "string" && Buffer.byteLength(message.id, "utf8") <= 128);
      if (!validId || Buffer.byteLength(message.method, "utf8") > 128) {
        this.#invalidate(new AppServerProtocolError("message"));
        return false;
      }
      try {
        this.#write({ id: message.id, error: { code: -32601, message: "Method not found" } });
      } catch {
        this.#invalidate(new Error("catalog process write failed"));
        return false;
      }
      return true;
    }
    if (!("id" in message)) return true;
    const pending = this.#pending;
    if (pending === null || message.id !== pending.id
      || (("result" in message) === ("error" in message))) {
      this.#invalidate(new AppServerProtocolError("message"));
      return false;
    }
    this.#pending = null;
    this.#options.clearTimer(pending.timer);
    if ("error" in message) {
      const error = new AppServerProtocolError("message");
      pending.reject(error);
      this.#invalidate(error);
      return false;
    }
    pending.resolve(message.result);
    return true;
  }

  #rejectPending(error: Error): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#options.clearTimer(pending.timer);
    pending.reject(error);
  }

  #invalidate(error: Error = new Error("catalog generation invalidated")): void {
    if (this.#state === "invalid" || this.#state === "stopped") return;
    this.#state = "invalid";
    this.#invalidReason = error;
    this.#accumulator = Buffer.alloc(0);
    this.#rejectPending(error);
    this.#child?.stdin.end();
  }
}
