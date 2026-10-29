import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
export interface T3Credentials { origin: string; token: string }
export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Use HTTPS or a local HTTP server.");
  return url.origin;
}
const credentialFile = path.join(os.homedir(), ".config", "fingertip", "t3-session.json");
export async function loadCredentials(): Promise<T3Credentials | null> {
  try {
    const value = record(JSON.parse(await readFile(credentialFile, "utf8")));
    return typeof value.origin === "string" && typeof value.token === "string"
      ? { origin: serverOrigin(value.origin), token: value.token } : null;
  } catch { return null; }
}
export async function saveCredentials(value: T3Credentials): Promise<void> {
  await mkdir(path.dirname(credentialFile), { recursive: true, mode: 0o700 });
  const temporary = `${credentialFile}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, credentialFile);
}
export async function pairT3(link: string, request: typeof fetch = fetch, serverAddress?: string): Promise<T3Credentials> {
  const url = new URL(link.trim());
  const desktop = url.protocol === "t3code:" || url.protocol === "t3code-dev:";
  if (desktop && (url.hostname !== "app" || url.pathname !== "/pair" || url.username || url.password)) {
    throw new Error("Unsupported T3 pairing link. Copy the link from Connections.");
  }
  if (desktop && !serverAddress?.trim()) {
    throw new Error("Enter the HTTP server address shown under T3 Settings → Connections → Version.");
  }
  // Desktop links carry a code but no backend host. Never guess a server for a credential.
  const origin = serverOrigin(desktop ? serverAddress!.trim() : url.href);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("Paste a T3 pairing link containing #token=…");
  const response = await request(`${origin}/oauth/token`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: token,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read orchestration:operate",
      client_label: "Fingertip Stream Deck", client_device_type: "desktop", client_os: "macOS",
    }),
  });
  if (!response.ok) throw new Error(`T3 pairing failed (HTTP ${response.status}). Create a fresh pairing link.`);
  const value = record(await response.json());
  if (typeof value.access_token !== "string" || value.token_type !== "Bearer") throw new Error("Unsupported T3 session.");
  return { origin, token: value.access_token };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
/** Small Effect RPC JSON transport. No provider CLI or agent-session credentials are used. */
export class T3Client {
  #socket: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #streams = new Map<string, (value: unknown) => void>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #lastFrame = 0;
  #generation = 0;
  environmentId = "";
  version = "";
  readonly credentials: T3Credentials;
  readonly onDisconnect: () => void;
  readonly request: typeof fetch;
  readonly socketFactory: (url: string) => WebSocket;
  constructor(credentials: T3Credentials, onDisconnect: () => void,
    request: typeof fetch = fetch, socketFactory = (url: string) => new WebSocket(url)) {
    this.credentials = credentials; this.onDisconnect = onDisconnect; this.request = request; this.socketFactory = socketFactory;
  }

  async http(route: string, method = "GET"): Promise<unknown> {
    const response = await this.request(`${this.credentials.origin}${route}`, {
      method, headers: { Authorization: `Bearer ${this.credentials.token}`,
        ...(route.startsWith("/api/orchestration/") ? { "x-t3-orchestration-protocol": "2" } : {}),
      },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? "T3 access denied. Pair again with read and operate access." : `T3 request failed (HTTP ${response.status}).`);
    return response.json();
  }
  async connect(): Promise<void> {
    const generation = ++this.#generation;
    const descriptor = record(await this.http("/.well-known/t3/environment"));
    if (descriptor.orchestrationProtocolVersion !== 2 || typeof descriptor.environmentId !== "string") {
      throw new Error("Unsupported T3 orchestration protocol. Version 2 is required.");
    }
    this.environmentId = descriptor.environmentId;
    this.version = String(descriptor.serverVersion ?? "");
    const ticket = record(await this.http("/api/auth/websocket-ticket/rpc", "POST"));
    if (typeof ticket.ticket !== "string") throw new Error("Invalid T3 WebSocket ticket.");
    if (generation !== this.#generation) throw new Error("Connection cancelled.");
    const url = new URL("/ws", this.credentials.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    const socket = this.socketFactory(url.href);
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.#lastFrame = Date.now();
      try { this.#receive(JSON.parse(String(event.data))); } catch { this.#lost(socket); }
    });
    socket.addEventListener("close", () => this.#lost(socket));
    socket.addEventListener("error", () => this.#lost(socket));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.#lost(socket); reject(new Error("T3 connection timed out.")); }, 10_000);
      const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      socket.addEventListener("open", () => finish(), { once: true });
      socket.addEventListener("error", () => finish(new Error("T3 connection failed.")), { once: true });
      socket.addEventListener("close", () => finish(new Error("T3 connection closed.")), { once: true });
    });
    if (this.#socket !== socket) throw new Error("Connection cancelled.");
    this.#lastFrame = Date.now();
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastFrame > 15_000) this.#lost(socket);
      else this.#send({ _tag: "Ping" });
    }, 5_000);
  }
  #send(message: unknown): void {
    if (this.#socket?.readyState !== 1) throw new Error("T3 is offline.");
    this.#socket.send(JSON.stringify(message));
  }
  rpc(tag: string, payload: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("T3 request timed out."));
      }, 10_000);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#send({ _tag: "Request", id, tag, payload, headers: [] }); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }
  subscribe(tag: string, payload: unknown, receive: (value: unknown) => void): void {
    const id = randomUUID();
    this.#streams.set(id, receive);
    this.#send({ _tag: "Request", id, tag, payload, headers: [] });
  }
  #receive(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value) this.#receive(item); return; }
    const message = record(value);
    if (message._tag === "Ping") { this.#send({ _tag: "Pong" }); return; }
    const id = String(message.requestId);
    if (message._tag === "Chunk") {
      const listener = this.#streams.get(id);
      if (listener && Array.isArray(message.values)) for (const item of message.values) listener(item);
      this.#send({ _tag: "Ack", requestId: id });
    } else if (message._tag === "Exit") {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer); this.#pending.delete(id);
        const exit = record(message.exit);
        if (exit._tag === "Success") pending.resolve(exit.value);
        else pending.reject(new Error("T3 rejected the operation. Check permissions and provider availability."));
      } else if (this.#streams.has(id) && this.#socket) this.#lost(this.#socket);
    }
  }
  #lost(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.close(); this.onDisconnect();
  }
  close(): void {
    ++this.#generation;
    const socket = this.#socket; this.#socket = null;
    socket?.close();
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("T3 disconnected.")); }
    this.#pending.clear(); this.#streams.clear();
  }
}
