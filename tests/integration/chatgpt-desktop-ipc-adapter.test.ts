import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTaskId } from "../../src/catalog/catalog-projection.ts";
import { ChatGptDesktopIpcAdapter } from "../../src/desktop-ipc/chatgpt-desktop-ipc-adapter.ts";
import { encodeIpcFrame, IpcFrameDecoder } from "../../src/desktop-ipc/ipc-framer.ts";

function withTimeout<T>(promise: Promise<T>, message: () => string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message())), 1_000);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("desktop IPC prefers the secure current home endpoint over a legacy endpoint", async (context) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "fingertip-ipc-endpoint-"));
  await chmod(temp, 0o700);
  const home = path.join(temp, "home");
  const codexDirectory = path.join(home, ".codex");
  const ipcDirectory = path.join(codexDirectory, "ipc");
  const legacyDirectory = path.join(temp, "codex-ipc");
  await mkdir(ipcDirectory, { recursive: true, mode: 0o700 });
  await chmod(ipcDirectory, 0o700);
  await mkdir(legacyDirectory, { mode: 0o700 });
  const getuid = process.getuid;
  assert.ok(getuid);
  const currentSocketPath = path.join(ipcDirectory, "ipc.sock");
  const legacySocketPath = path.join(legacyDirectory, `ipc-${getuid()}.sock`);
  let legacyConnections = 0;
  const legacyServer = net.createServer(() => { legacyConnections += 1; });
  const currentServer = net.createServer((socket) => {
    const decoder = new IpcFrameDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.type === "request" && message.method === "initialize") {
          socket.write(encodeIpcFrame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "initialize",
            handledByClientId: "current-desktop-client",
            result: { clientId: "current-desktop-client" },
          }));
          setImmediate(() => socket.write(encodeIpcFrame({
            type: "broadcast",
            method: "thread-stream-following-changed",
            version: 1,
            sourceClientId: "owner-client",
            targetClientIds: ["current-desktop-client"],
            params: {
              conversationId: "00000000-0000-4000-8000-000000000001",
              hostId: "local",
              following: true,
            },
          })));
        }
      }
    });
  });
  await Promise.all([
    new Promise<void>((resolve) => currentServer.listen(currentSocketPath, resolve)),
    new Promise<void>((resolve) => legacyServer.listen(legacySocketPath, resolve)),
  ]);
  const adapter = new ChatGptDesktopIpcAdapter({ tempDirectory: temp, homeDirectory: home });
  context.after(async () => {
    adapter.stop();
    await Promise.all([
      new Promise<void>((resolve) => currentServer.close(() => resolve())),
      new Promise<void>((resolve) => legacyServer.close(() => resolve())),
    ]);
    await rm(temp, { recursive: true, force: true });
  });

  await withTimeout(adapter.start(), () => `current endpoint handshake timeout state=${adapter.state}`);
  assert.equal(adapter.state, "online");
  assert.equal(legacyConnections, 0);
});

test("desktop IPC performs the exact handshake and publishes only sanitized owner snapshots", async (context) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "fingertip-ipc-"));
  await chmod(temp, 0o700);
  const ipcDirectory = path.join(temp, "codex-ipc");
  await mkdir(ipcDirectory, { mode: 0o700 });
  const getuid = process.getuid;
  assert.ok(getuid);
  const socketPath = path.join(ipcDirectory, `ipc-${getuid()}.sock`);
  const clientMessages: Record<string, unknown>[] = [];
  const hydrationTaskId = parseTaskId("00000000-0000-4000-8000-000000000003");
  let hydrationAnnouncementCount = 0;
  let discoveryResolve!: () => void;
  const discoveryReceived = new Promise<void>((resolve) => { discoveryResolve = resolve; });
  let directResolve!: () => void;
  const directReceived = new Promise<void>((resolve) => { directResolve = resolve; });
  const serverSockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    serverSockets.add(socket);
    socket.once("close", () => serverSockets.delete(socket));
    const decoder = new IpcFrameDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        clientMessages.push(message);
        if (message.type === "client-discovery-response") discoveryResolve();
        if (message.type === "response" && message.error === "no-handler-for-request") directResolve();
        if (message.type === "request" && message.method === "thread-follower-update-thread-settings") {
          socket.write(encodeIpcFrame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "thread-follower-update-thread-settings",
            handledByClientId: "owner-client",
            result: { ok: true },
          }));
        }
        if (message.type === "broadcast" && message.method === "thread-stream-following-changed"
          && (message.params as { following?: unknown } | undefined)?.following === true) {
          hydrationAnnouncementCount += 1;
          const conversationId = (message.params as { conversationId?: unknown } | undefined)?.conversationId;
          if (conversationId === hydrationTaskId) {
            socket.write(encodeIpcFrame({
              type: "broadcast",
              method: "thread-stream-state-changed",
              version: 11,
              sourceClientId: "owner-client",
              params: {
                hostId: "local",
                conversationId: hydrationTaskId,
                change: {
                  type: "snapshot",
                  revision: 1,
                  conversationState: {
                    threadRuntimeStatus: { type: "idle" },
                    hasUnreadTurn: true,
                    requests: [],
                  },
                },
              },
            }));
          }
        }
        if (message.type === "request" && message.method === "initialize") {
          socket.write(encodeIpcFrame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "initialize",
            handledByClientId: "desktop-client",
            result: { clientId: "desktop-client" },
          }));
          setImmediate(() => {
            socket.write(encodeIpcFrame({
              type: "broadcast",
              method: "thread-stream-following-changed",
              version: 1,
              sourceClientId: "composer-client",
              targetClientIds: ["desktop-client"],
              params: {
                conversationId: "00000000-0000-4000-8000-000000000001",
                hostId: "local",
                following: true,
              },
            }));
            socket.write(encodeIpcFrame({
              type: "broadcast",
              method: "thread-stream-state-changed",
              version: 11,
              sourceClientId: "owner-client",
              params: {
                hostId: "local",
                conversationId: "00000000-0000-4000-8000-000000000001",
                change: {
                  type: "snapshot",
                  revision: 7,
                  conversationState: {
                    threadRuntimeStatus: { type: "active", activeFlags: [] },
                    hasUnreadTurn: false,
                    requests: [],
                    privateTitle: "must-not-cross",
                  },
                },
              },
            }));
            socket.write(encodeIpcFrame({
              type: "broadcast",
              method: "thread-stream-state-changed",
              version: 11,
              sourceClientId: "owner-client",
              params: {
                hostId: "local",
                conversationId: "00000000-0000-4000-8000-000000000001",
                change: {
                  type: "patches",
                  baseRevision: 7,
                  revision: 8,
                  patches: [
                    { op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } },
                    { op: "replace", path: ["hasUnreadTurn"], value: true },
                  ],
                },
              },
            }));
            socket.write(encodeIpcFrame({
              type: "client-discovery-request",
              requestId: "discovery-1",
              request: { method: "private", version: 0, params: { secret: "ignore" } },
            }));
            socket.write(encodeIpcFrame({
              type: "request",
              requestId: "direct-1",
              method: "private/direct",
              version: 0,
              params: { secret: "ignore" },
            }));
          });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const adapter = new ChatGptDesktopIpcAdapter({
    tempDirectory: temp,
    homeDirectory: path.join(temp, "home-without-ipc"),
  });
  const catalogHints: string[] = [];
  const activeTaskIds: Array<string | null> = [];
  adapter.onCatalogHint((taskId) => catalogHints.push(taskId));
  adapter.onActiveTask((taskId) => activeTaskIds.push(taskId));
  context.after(async () => {
    adapter.stop();
    for (const socket of serverSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  });
  const records: unknown[] = [];
  let nextRecordResolve: ((record: unknown) => void) | null = null;
  const taskEvent = new Promise<unknown>((resolve) => adapter.onTaskRecord((record) => {
    records.push(record);
    nextRecordResolve?.(record);
    nextRecordResolve = null;
    if (records.length === 2) resolve(record);
  }));
  const nextRecord = (): Promise<unknown> => new Promise((resolve) => { nextRecordResolve = resolve; });

  await withTimeout(adapter.start(), () => `start timeout state=${adapter.state} messages=${clientMessages.length}`);
  const record = await withTimeout(taskEvent, () => `snapshot timeout state=${adapter.state} messages=${clientMessages.length}`);
  await discoveryReceived;
  await directReceived;
  const unreadTaskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  assert.equal(adapter.markTaskUnread(unreadTaskId), true);
  for (let iteration = 0; iteration < 3; iteration += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(clientMessages[0], {
    type: "request",
    requestId: clientMessages[0]?.requestId,
    sourceClientId: "initializing-client",
    version: 0,
    method: "initialize",
    params: { clientType: "fingertip-stream-deck" },
  });
  assert.deepEqual(clientMessages.find((message) => message.type === "client-discovery-response"), {
    type: "client-discovery-response",
    requestId: "discovery-1",
    response: { canHandle: false },
  });
  assert.deepEqual(clientMessages.find((message) => message.type === "response" && message.requestId === "direct-1"), {
    type: "response",
    requestId: "direct-1",
    resultType: "error",
    error: "no-handler-for-request",
  });
  assert.deepEqual(clientMessages.find((message) =>
    message.type === "broadcast" && message.method === "thread-read-state-changed"
      && (message.params as { hasUnreadTurn?: unknown } | undefined)?.hasUnreadTurn === true), {
    type: "broadcast",
    sourceClientId: "desktop-client",
    version: 2,
    method: "thread-read-state-changed",
    params: { conversationId: unreadTaskId, hostId: "local", hasUnreadTurn: true },
  });
  assert.equal(JSON.stringify(clientMessages).includes("secret"), false);
  assert.deepEqual(records[0], {
    taskId: "00000000-0000-4000-8000-000000000001",
    ownerClientId: "owner-client",
    revision: 7,
    facts: {
      isActive: true,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      hasUnreadTurn: false,
    },
    status: "working",
    freshness: "fresh",
  });
  assert.equal(adapter.activeTaskId, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(activeTaskIds, ["00000000-0000-4000-8000-000000000001"]);
  assert.deepEqual(record, {
    taskId: "00000000-0000-4000-8000-000000000001",
    ownerClientId: "owner-client",
    revision: 8,
    facts: {
      isActive: false,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      hasUnreadTurn: true,
    },
    status: "done",
    freshness: "fresh",
  });
  const activeSocketForQueue = [...serverSockets][0];
  assert.ok(activeSocketForQueue);
  const newlySelectedSnapshot = nextRecord();
  activeSocketForQueue.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-following-changed",
    version: 1,
    sourceClientId: "composer-client",
    params: {
      conversationId: "00000000-0000-4000-8000-000000000002",
      hostId: "local",
      following: true,
    },
  }));
  activeSocketForQueue.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId: "owner-client",
    params: {
      hostId: "local",
      conversationId: "00000000-0000-4000-8000-000000000002",
      change: {
        type: "snapshot",
        revision: 1,
        conversationState: {
          threadRuntimeStatus: { type: "idle" },
          hasUnreadTurn: false,
          requests: [],
        },
      },
    },
  }));
  await newlySelectedSnapshot;
  assert.equal(adapter.activeTaskId, "00000000-0000-4000-8000-000000000002");
  assert.deepEqual(activeTaskIds, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ]);

  adapter.selectActiveTask(parseTaskId("00000000-0000-4000-8000-000000000001"));
  assert.equal(adapter.activeTaskId, "00000000-0000-4000-8000-000000000001");

  const queuedTransition = nextRecord();
  activeSocketForQueue.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-queued-followups-changed",
    version: 1,
    sourceClientId: "owner-client",
    params: {
      conversationId: "00000000-0000-4000-8000-000000000001",
      messages: [{ id: "queued-1", text: "must-not-cross" }],
    },
  }));
  assert.deepEqual(await queuedTransition, {
    taskId: "00000000-0000-4000-8000-000000000001",
    ownerClientId: "owner-client",
    revision: 8,
    facts: {
      isActive: false,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      hasUnreadTurn: true,
      hasQueuedFollowUp: true,
    },
    status: "working",
    freshness: "fresh",
    queuedFollowUpCount: 1,
  });
  const queueHandoffTransition = nextRecord();
  activeSocketForQueue.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-queued-followups-changed",
    version: 1,
    sourceClientId: "owner-client",
    params: {
      conversationId: "00000000-0000-4000-8000-000000000001",
      messages: [],
    },
  }));
  assert.equal((await queueHandoffTransition as { status: string }).status, "working");

  const nextTurnActive = nextRecord();
  activeSocketForQueue.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId: "owner-client",
    params: {
      hostId: "local",
      conversationId: "00000000-0000-4000-8000-000000000001",
      change: {
        type: "patches",
        baseRevision: 8,
        revision: 9,
        patches: [{ op: "replace", path: ["threadRuntimeStatus"], value: { type: "active", activeFlags: [] } }],
      },
    },
  }));
  assert.equal((await nextTurnActive as { status: string }).status, "working");

  const pausedQueueTransition = nextRecord();
  activeSocketForQueue.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-queued-followups-changed",
    version: 1,
    sourceClientId: "owner-client",
    params: {
      conversationId: "00000000-0000-4000-8000-000000000001",
      messages: [{ id: "queued-2", pausedReason: "interrupted", text: "must-not-cross" }],
    },
  }));
  assert.equal((await pausedQueueTransition as { status: string }).status, "working");

  const nextTurnDone = nextRecord();
  activeSocketForQueue.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId: "owner-client",
    params: {
      hostId: "local",
      conversationId: "00000000-0000-4000-8000-000000000001",
      change: {
        type: "patches",
        baseRevision: 9,
        revision: 10,
        patches: [{ op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } }],
      },
    },
  }));
  assert.equal((await nextTurnDone as { status: string }).status, "done");
  assert.equal(JSON.stringify(adapter.getRecord(parseTaskId("00000000-0000-4000-8000-000000000001")))
    .includes("must-not-cross"), false);
  const catalogTaskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  adapter.setCatalogTaskIds(new Set([catalogTaskId, hydrationTaskId]));
  catalogHints.length = 0;
  const readTransition = nextRecord();
  const activeSocketForRead = [...serverSockets][0];
  assert.ok(activeSocketForRead);
  activeSocketForRead.write(Buffer.concat([
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-read-state-changed",
      version: 2,
      params: { conversationId: catalogTaskId, hasUnreadTurn: false },
    }),
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-read-state-changed",
      version: 1,
      params: { conversationId: "00000000-0000-4000-8000-000000000099", hasUnreadTurn: true },
    }),
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-archived",
      version: 99,
      params: { hostId: "local", conversationId: catalogTaskId },
    }),
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-archived",
      version: 2,
      params: { hostId: "local", conversationId: catalogTaskId },
    }),
  ]));
  assert.equal((await readTransition as { status: string }).status, "idle");
  const optimisticUnreadTransition = nextRecord();
  assert.equal(adapter.markTaskUnread(catalogTaskId), true);
  assert.equal((await optimisticUnreadTransition as { status: string }).status, "done");
  const legacyReadTransition = nextRecord();
  activeSocketForRead.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-read-state-changed",
    version: 1,
    params: { conversationId: catalogTaskId, hasUnreadTurn: true },
  }));
  assert.equal((await legacyReadTransition as { facts: { hasUnreadTurn: boolean } }).facts.hasUnreadTurn, true);
  const hydratedRecord = nextRecord();
  await adapter.hydrateTaskIds([hydrationTaskId]);
  assert.equal((await hydratedRecord as { status: string }).status, "done");
  assert.equal(adapter.activeTaskId, catalogTaskId);
  const hydrationRequest = clientMessages.find((message) =>
    message.type === "broadcast" && message.method === "thread-stream-following-changed"
      && (message.params as { conversationId?: unknown } | undefined)?.conversationId === hydrationTaskId);
  assert.deepEqual(hydrationRequest, {
    type: "broadcast",
    sourceClientId: "desktop-client",
    version: 1,
    method: "thread-stream-following-changed",
    params: { conversationId: hydrationTaskId, hostId: "local", following: true },
  });
  const activeSocketForFollowerReplay = [...serverSockets][0];
  assert.ok(activeSocketForFollowerReplay);
  const hydrationPatch = nextRecord();
  activeSocketForFollowerReplay.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId: "owner-client",
    params: {
      hostId: "local",
      conversationId: hydrationTaskId,
      change: {
        type: "patches",
        baseRevision: 1,
        revision: 2,
        patches: [{ op: "replace", path: ["privateState"], value: "ignored" }],
      },
    },
  }));
  assert.equal("privateState" in (await hydrationPatch as { facts: object }).facts, false);
  assert.equal(adapter.activeTaskId, catalogTaskId);
  activeSocketForFollowerReplay.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-following-status-requested",
    version: 1,
    sourceClientId: "owner-reconnected",
    params: { conversationId: hydrationTaskId, hostId: "local" },
  }));
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const followerStatusReplay = clientMessages.find((message) => message.type === "broadcast"
    && message.method === "thread-stream-following-changed"
    && Array.isArray(message.targetClientIds)
    && message.targetClientIds.includes("owner-reconnected"));
  assert.deepEqual(followerStatusReplay, {
    type: "broadcast",
    sourceClientId: "desktop-client",
    version: 1,
    method: "thread-stream-following-changed",
    targetClientIds: ["owner-reconnected"],
    params: { conversationId: hydrationTaskId, hostId: "local", following: true },
  });
  assert.deepEqual(catalogHints, [catalogTaskId]);
  assert.equal(adapter.state, "online");
  assert.equal(JSON.stringify(record).includes("privateTitle"), false);
  assert.equal(adapter.state, "online");
  const activeServerSocket = [...serverSockets][0];
  assert.ok(activeServerSocket);
  const newEpoch = nextRecord();
  activeServerSocket.write(Buffer.concat([
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: "owner-client",
      params: {
        hostId: "local",
        conversationId: "00000000-0000-4000-8000-000000000001",
        change: { type: "patches", baseRevision: 8, revision: 8, patches: [] },
      },
    }),
    encodeIpcFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: "owner-two",
      params: {
        hostId: "local",
        conversationId: "00000000-0000-4000-8000-000000000001",
        change: {
          type: "snapshot",
          revision: 0,
          conversationState: {
            threadRuntimeStatus: { type: "idle" },
            hasUnreadTurn: false,
            requests: [],
          },
        },
      },
    }),
  ]));
  assert.deepEqual(await newEpoch, {
    taskId: "00000000-0000-4000-8000-000000000001",
    ownerClientId: "owner-two",
    revision: 0,
    facts: { isActive: false, waitingOnApproval: false, waitingOnUserInput: false, hasUnreadTurn: false },
    status: "idle",
    freshness: "fresh",
  });
  assert.equal(records.length, 15);

  const recordCountBeforeOwnerHandoff = records.length;
  activeServerSocket.write(encodeIpcFrame({
    type: "broadcast",
    method: "client-status-changed",
    version: 0,
    params: { clientId: "owner-two", clientType: "chatgpt", status: "disconnected" },
  }));
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(records.length, recordCountBeforeOwnerHandoff);

  const recovered = nextRecord();
  activeServerSocket.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId: "owner-two",
    params: {
      hostId: "local",
      conversationId: "00000000-0000-4000-8000-000000000001",
      change: {
        type: "snapshot",
        revision: 1,
        conversationState: {
          threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
          hasUnreadTurn: false,
          requests: [],
        },
      },
    },
  }));
  assert.equal((await recovered as { status: string }).status, "confirmation");

  const hydrationAnnouncementsBeforeGap = hydrationAnnouncementCount;
  activeServerSocket.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId: "intruder-owner",
    params: {
      hostId: "local",
      conversationId: "00000000-0000-4000-8000-000000000001",
      change: { type: "patches", baseRevision: 1, revision: 2, patches: [] },
    },
  }));
  await withTimeout(new Promise<void>((resolve) => {
    const poll = (): void => {
      if (hydrationAnnouncementCount > hydrationAnnouncementsBeforeGap) resolve();
      else setImmediate(poll);
    };
    poll();
  }), () => "revision gap did not request a fresh snapshot");
  assert.equal(adapter.state, "online");
  assert.equal(adapter.getRecord(catalogTaskId)?.freshness, "fresh");
  assert.equal(adapter.getRecord(catalogTaskId)?.status, "confirmation");

  const incompatible = new Promise<void>((resolve) => adapter.onHealth((state) => {
    if (state === "incompatible") resolve();
  }));
  activeServerSocket.write(encodeIpcFrame({
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 12,
    sourceClientId: "owner-client",
    params: {},
  }));
  await incompatible;
  assert.equal(adapter.state, "incompatible");
  adapter.stop();
  assert.equal(adapter.state, "incompatible");
  adapter.clearCompatibilityLatch();
  assert.equal(adapter.state, "offline");
});
