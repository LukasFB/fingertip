import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AppServerCatalogClient,
  AppServerProtocolError,
  type AppServerChild,
  type SpawnAppServer,
} from "../../src/catalog/app-server-catalog-client.ts";

class FakeChild extends EventEmitter implements AppServerChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor() {
    super();
    this.stdin.once("finish", () => queueMicrotask(() => this.emit("exit", 0, null)));
  }
  kill(): boolean { queueMicrotask(() => this.emit("exit", 0, null)); return true; }
}

function fakeServer(onMessage?: (message: Record<string, unknown>, child: FakeChild) => void): {
  child: FakeChild;
  messages: Record<string, unknown>[];
  spawn: SpawnAppServer;
  call: unknown[];
} {
  const child = new FakeChild();
  const messages: Record<string, unknown>[] = [];
  const call: unknown[] = [];
  let accumulator = "";
  child.stdin.on("data", (chunk: Buffer) => {
    accumulator += chunk.toString("utf8");
    while (accumulator.includes("\n")) {
      const index = accumulator.indexOf("\n");
      const line = accumulator.slice(0, index);
      accumulator = accumulator.slice(index + 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      onMessage?.(message, child);
    }
  });
  const spawn: SpawnAppServer = (command, args, options) => {
    call.push(command, args, options);
    return child;
  };
  return { child, messages, spawn, call };
}

test("catalog client requests ChatGPT's stable sidebar recency order", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      const response = Buffer.from(`${JSON.stringify({ id: message.id, result: { serverInfo: {} } })}\n`);
      child.stdout.write(response.subarray(0, 3));
      queueMicrotask(() => child.stdout.write(response.subarray(3)));
    }
    if (message.method === "thread/list") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`);
    }
  });
  const client = new AppServerCatalogClient("/validated/ChatGPT.app/Contents/Resources/codex", {
    spawn: server.spawn,
    environment: { HOME: "/Users/test", PATH: "/usr/bin", CODEX_HOME: "/forbidden", OPENAI_API_KEY: "secret" },
  });

  await client.start();
  const result = await client.listThreads({ limit: 109 });

  assert.deepEqual(server.messages, [
    {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "fingertip", title: "Fingertip Stream Deck Plugin", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    },
    { method: "initialized", params: {} },
    {
      id: 2,
      method: "thread/list",
      params: { limit: 109, sortKey: "recency_at", sortDirection: "desc", archived: false, useStateDbOnly: true },
    },
  ]);
  assert.deepEqual(result, { data: [], nextCursor: null });
  assert.equal(server.call[0], "/validated/ChatGPT.app/Contents/Resources/codex");
  assert.deepEqual(server.call[1], ["--enable", "goals", "app-server"]);
  const options = server.call[2] as { shell: boolean; detached: boolean; stdio: string[]; env: Record<string, string> };
  assert.equal(options.shell, false);
  assert.equal(options.detached, false);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(options.env, { HOME: "/Users/test", PATH: "/usr/bin" });
  assert.equal(JSON.stringify(server.messages).includes("thread/read"), false);
  await client.stop();
});

test("catalog client reads one thread with its turn history for task-owned changes", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === "thread/read") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { turns: [] } } })}\n`);
    }
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });

  await client.start();
  const result = await client.readThread({ threadId: "00000000-0000-4000-8000-000000000001" });

  assert.deepEqual(result, { thread: { turns: [] } });
  assert.deepEqual(server.messages.at(-1), {
    id: 2,
    method: "thread/read",
    params: { threadId: "00000000-0000-4000-8000-000000000001", includeTurns: true },
  });
  await client.stop();
});

test("catalog client reads only the sanitized goal state for one thread", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === "thread/goal/get") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { goal: { status: "active" } } })}\n`);
    }
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });

  await client.start();
  const result = await client.readThreadGoal({ threadId: "00000000-0000-4000-8000-000000000001" });

  assert.deepEqual(result, { goal: { status: "active" } });
  assert.deepEqual(server.messages.at(-1), {
    id: 2,
    method: "thread/goal/get",
    params: { threadId: "00000000-0000-4000-8000-000000000001" },
  });
  await client.stop();
});

test("catalog client answers server requests statically and invalidates malformed generations", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      child.stdout.write(`${JSON.stringify({ id: 99, method: "private/request", params: { secret: "ignore" } })}\n`);
    }
    if (message.method === "thread/list") child.stdout.write("not-json\n");
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });

  await client.start();
  await assert.rejects(client.listThreads({ limit: 50 }), (error: unknown) => {
    assert.equal(error instanceof AppServerProtocolError, true);
    assert.equal((error as AppServerProtocolError).signature, "jsonl");
    return true;
  });
  assert.deepEqual(server.messages.find((message) => message.id === 99), {
    id: 99,
    error: { code: -32601, message: "Method not found" },
  });
  assert.equal(client.state, "invalid");
  await client.stop();
});

test("catalog child shutdown escalates from EOF to TERM to KILL only when required", async () => {
  class StubbornChild extends EventEmitter implements AppServerChild {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly signals: NodeJS.Signals[] = [];
    kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
      this.signals.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => this.emit("exit", null, signal));
      return true;
    }
  }
  const child = new StubbornChild();
  let accumulator = "";
  child.stdin.on("data", (chunk: Buffer) => {
    accumulator += chunk.toString("utf8");
    while (accumulator.includes("\n")) {
      const newline = accumulator.indexOf("\n");
      const message = JSON.parse(accumulator.slice(0, newline)) as Record<string, unknown>;
      accumulator = accumulator.slice(newline + 1);
      if (typeof message.id === "number") {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
    }
  });
  const client = new AppServerCatalogClient("/validated/codex", {
    spawn: () => child,
    reapWaitMs: 1,
  });
  await client.start();

  await client.stop();

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(client.state, "stopped");
});

test("catalog initialization times out and invalidates a silent generation", async () => {
  const server = fakeServer();
  const immediateTimer = ((callback: () => void) => {
    queueMicrotask(callback);
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const client = new AppServerCatalogClient("/validated/codex", {
    spawn: server.spawn,
    setTimer: immediateTimer,
    clearTimer: (() => undefined) as typeof clearTimeout,
  });

  await assert.rejects(client.start());

  assert.equal(client.state, "invalid");
  await client.stop();
});

test("a protocol failure between requests is reported by the next catalog query", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === "initialized") {
      queueMicrotask(() => child.stdout.write("not-json\n"));
    }
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  await client.start();
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(client.listThreads({ limit: 50 }), (error: unknown) => {
    assert.equal(error instanceof AppServerProtocolError, true);
    assert.equal((error as AppServerProtocolError).signature, "jsonl");
    return true;
  });
  await client.stop();
});

test("a protocol failure during initialized notification cannot be overwritten by ready state", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === "initialized") child.stdout.write("not-json\n");
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });

  await assert.rejects(client.start(), AppServerProtocolError);
  assert.equal(client.state, "invalid");
  await client.stop();
});
