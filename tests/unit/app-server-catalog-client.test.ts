import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AppServerCatalogClient,
  AppServerProtocolError,
  AppServerRequestError,
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

test("catalog client discovers visible models with cursor pagination and no thread mutation", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method === "model/list") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`);
    }
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  await client.start();

  assert.deepEqual(await client.listModels({ limit: 100 }), { data: [], nextCursor: null });
  await client.listModels({ limit: 100, cursor: "next-page" });

  assert.deepEqual(server.messages.slice(2), [
    { id: 2, method: "model/list", params: { limit: 100, includeHidden: false } },
    { id: 3, method: "model/list", params: { limit: 100, includeHidden: false, cursor: "next-page" } },
  ]);
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

test("an optional goal request failure leaves the catalog transport ready for the next query", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === "thread/goal/get") {
      child.stdout.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32600, message: "thread is not loaded", data: { threadId: "private" } },
      })}\n`);
    }
    if (message.method === "thread/list") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`);
    }
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  await client.start();

  await assert.rejects(client.readThreadGoal({ threadId: "00000000-0000-4000-8000-000000000001" }), (error: unknown) => {
    assert.equal(error instanceof AppServerRequestError, true);
    assert.equal((error as AppServerRequestError).code, -32600);
    assert.equal((error as Error).message, "catalog request failed");
    return true;
  });

  assert.equal(client.state, "ready");
  assert.equal(server.child.stdin.writableEnded, false);
  assert.deepEqual(await client.listThreads({ limit: 50 }), { data: [], nextCursor: null });
  await client.stop();
});

test("malformed application error responses invalidate the catalog transport", async (context) => {
  for (const error of [null, {}, { code: "-32600", message: "failed" }, { code: -32600.5, message: "failed" }, { code: -32600 }]) {
    await context.test(JSON.stringify(error), async () => {
      const server = fakeServer((message, child) => {
        if (message.method === "initialize") {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
        if (message.method === "thread/goal/get") {
          child.stdout.write(`${JSON.stringify({ id: message.id, error })}\n`);
        }
      });
      const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
      await client.start();

      await assert.rejects(client.readThreadGoal({ threadId: "00000000-0000-4000-8000-000000000001" }), AppServerProtocolError);

      assert.equal(client.state, "invalid");
      await client.stop();
    });
  }
});

test("an oversized fragmented optional history drains before the next catalog query", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === "thread/read") {
      child.stdout.write(`{"id":${String(message.id)},"result":{"history":"`);
      child.stdout.write("x".repeat(8 * 1024 * 1024));
      child.stdout.write("x".repeat(8 * 1024 * 1024));
    }
    if (message.method === "thread/list") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`);
    }
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  await client.start();
  let rejected = false;
  const oversized = assert.rejects(client.readThread({ threadId: "00000000-0000-4000-8000-000000000001" }),
    /catalog history response exceeds limit/).then(() => { rejected = true; });

  await Promise.resolve();
  assert.equal(rejected, false);
  const queued = client.listThreads({ limit: 50 });
  assert.equal(server.messages.at(-1)?.method, "thread/read");
  server.child.stdout.write("x".repeat(1024));
  server.child.stdout.write('"}}\n');
  await oversized;
  assert.deepEqual(await queued, { data: [], nextCursor: null });

  assert.equal(client.state, "ready");
  assert.equal(server.child.stdin.writableEnded, false);
  assert.deepEqual(await client.listThreads({ limit: 50 }), { data: [], nextCursor: null });
  await client.stop();
});

test("concurrent model and thread queries are serialized in FIFO order", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  await client.start();

  const models = client.listModels({ limit: 100 });
  const threads = client.listThreads({ limit: 50 });
  const history = client.readThread({ threadId: "00000000-0000-4000-8000-000000000001" });
  assert.deepEqual(server.messages.slice(2).map((message) => message.method), ["model/list"]);

  server.child.stdout.write(`${JSON.stringify({ id: 2, result: { data: [], nextCursor: null } })}\n`);
  assert.deepEqual(await models, { data: [], nextCursor: null });
  assert.deepEqual(server.messages.slice(2).map((message) => message.method), ["model/list", "thread/list"]);
  server.child.stdout.write(`${JSON.stringify({ id: 3, result: { data: [], nextCursor: null } })}\n`);
  await threads;
  assert.deepEqual(server.messages.slice(2).map((message) => message.method), ["model/list", "thread/list", "thread/read"]);
  server.child.stdout.write(`${JSON.stringify({ id: 4, result: { thread: { turns: [] } } })}\n`);
  assert.deepEqual(await history, { thread: { turns: [] } });
  await client.stop();
});

test("queued catalog request deadlines begin after the previous request completes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  await client.start();
  const models = client.listModels({ limit: 100 });
  const threads = client.listThreads({ limit: 50 });
  context.mock.timers.tick(4_000);
  server.child.stdout.write(`${JSON.stringify({ id: 2, result: { data: [], nextCursor: null } })}\n`);
  await models;
  context.mock.timers.tick(4_000);
  assert.equal(client.state, "ready");
  server.child.stdout.write(`${JSON.stringify({ id: 3, result: { data: [], nextCursor: null } })}\n`);
  await threads;
  await client.stop();
});

test("stopping rejects active and queued queries and reconnect never sends old queued work", async () => {
  const first = fakeServer((message, child) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  });
  const second = fakeServer((message, child) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    if (message.method === "thread/list") child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [] } })}\n`);
  });
  let starts = 0;
  const client = new AppServerCatalogClient("/validated/codex", {
    spawn: (command, args, options) => (++starts === 1 ? first : second).spawn(command, args, options),
  });
  await client.start();
  const active = assert.rejects(client.listModels({ limit: 100 }), /client stopped/);
  const queued = assert.rejects(client.readThread({ threadId: "00000000-0000-4000-8000-000000000001" }), /client stopped/);
  await client.stop();
  await Promise.all([active, queued]);
  assert.deepEqual(first.messages.slice(2).map((message) => message.method), ["model/list"]);

  await client.start();
  assert.deepEqual(await client.listThreads({ limit: 50 }), { data: [] });
  assert.deepEqual(second.messages.map((message) => message.method), ["initialize", "initialized", "thread/list"]);
  await client.stop();
});

test("a fatal transport error rejects the active query and all queued work", async () => {
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  await client.start();
  const active = assert.rejects(client.listModels({ limit: 100 }), AppServerProtocolError);
  const queued = assert.rejects(client.listThreads({ limit: 50 }), AppServerProtocolError);
  server.child.stdout.write("invalid json\n");
  await Promise.all([active, queued]);
  assert.equal(client.state, "invalid");
  assert.deepEqual(server.messages.slice(2).map((message) => message.method), ["model/list"]);
  await client.stop();
});

test("an oversized optional history that never finishes still times out", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
    if (message.method === "thread/read") {
      child.stdout.write("x".repeat(16 * 1024 * 1024 + 1));
    }
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  await client.start();
  const timedOut = assert.rejects(client.readThread({ threadId: "00000000-0000-4000-8000-000000000001" }),
    /catalog response timeout/);

  context.mock.timers.tick(5_000);
  await timedOut;

  assert.equal(client.state, "invalid");
  assert.equal(server.child.stdin.writableEnded, true);
  await client.stop();
});

test("oversized initialize and core catalog responses still invalidate the transport", async (context) => {
  for (const method of ["initialize", "thread/list"]) {
    await context.test(method, async () => {
      const server = fakeServer((message, child) => {
        if (message.method === method) {
          child.stdout.write("x".repeat(16 * 1024 * 1024 + 1));
        } else if (message.method === "initialize") {
          child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
      });
      const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });

      if (method === "initialize") {
        await assert.rejects(client.start(), AppServerProtocolError);
      } else {
        await client.start();
        await assert.rejects(client.listThreads({ limit: 50 }), AppServerProtocolError);
      }

      assert.equal(client.state, "invalid");
      await client.stop();
    });
  }
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

test("catalog initialization accepts startup taking longer than ordinary requests", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const server = fakeServer();
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  const starting = client.start();

  context.mock.timers.tick(8_000);
  assert.equal(client.state, "starting");
  server.child.stdout.write(`${JSON.stringify({ id: server.messages[0]?.id, result: {} })}\n`);
  await starting;

  assert.equal(client.state, "ready");
  await client.stop();
});

test("ordinary catalog requests still time out after five seconds", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const server = fakeServer((message, child) => {
    if (message.method === "initialize") {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
  });
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  await client.start();
  const timedOut = assert.rejects(client.listThreads({ limit: 50 }), /catalog response timeout/);

  context.mock.timers.tick(4_999);
  assert.equal(client.state, "ready");
  context.mock.timers.tick(1);
  await timedOut;

  assert.equal(client.state, "invalid");
  await client.stop();
});

test("catalog initialization times out after thirty seconds and invalidates a silent generation", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const server = fakeServer();
  const client = new AppServerCatalogClient("/validated/codex", { spawn: server.spawn });
  const timedOut = assert.rejects(client.start(), /catalog response timeout/);

  context.mock.timers.tick(29_999);
  assert.equal(client.state, "starting");
  context.mock.timers.tick(1);
  await timedOut;

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
