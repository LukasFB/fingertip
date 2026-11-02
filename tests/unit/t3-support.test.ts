import assert from "node:assert/strict";
import test from "node:test";
import { activeThread, modelOptions, modelsFromConfig, taskFeed, thread, threadLink, threadStatus } from "../../src/t3/t3-projection.ts";
import { pairT3, record, serverOrigin, T3Client } from "../../src/t3/t3-client.ts";
import { T3Runtime, type T3RuntimeClient } from "../../src/t3/t3-runtime.ts";
import { normalizeTaskKeySettings, taskKeySettingsNeedWriteback } from "../../src/settings/task-key-settings.ts";
import { normalizeModelKeySettings } from "../../src/settings/model-key-settings.ts";
import type { TaskNotifier } from "../../src/notifications/mac-task-notifier.ts";

const older = "2026-10-28T12:00:00.000Z";
const newer = "2026-10-28T13:00:00.000Z";
const shell = (id: string, overrides = {}) => thread({ id, title: id, projectId: "project", createdAt: older,
  updatedAt: newer, lastVisitedAt: older, latestRunCompletedAt: newer, status: "completed", ...overrides });
const config = { providers: [{ instanceId: "codex-local", displayName: "Codex", models: [{ slug: "model-a", name: "Model A",
  capabilities: { optionDescriptors: [
    { id: "reasoningEffort", type: "select", currentValue: "low", options: [{ id: "low" }, { id: "high" }] },
    { id: "serviceTier", type: "select", options: [{ id: "default" }, { id: "priority" }] },
  ] } }] }] };
const selection = { instanceId: "codex-local", model: "model-a", options: [{ id: "reasoningEffort", value: "low" }] };

test("T3 targets the latest visited eligible thread, never latest activity or an unvisited thread", () => {
  assert.equal(activeThread([shell("old"), shell("recent", { lastVisitedAt: newer }),
    shell("unvisited", { lastVisitedAt: null, updatedAt: "2099-01-01" }),
    shell("archived", { archivedAt: newer, lastVisitedAt: "2099-01-01" }),
    shell("child", { lineage: { relationshipToParent: "subagent" }, lastVisitedAt: "2099-01-01" }),
  ])?.id, "recent");
  assert.equal(activeThread([shell("none", { lastVisitedAt: null })]), null);
});

test("T3 maps approvals, questions, runs and read completion independently", () => {
  for (const kind of ["command", "file-read", "file-change", "permission"]) {
    assert.equal(threadStatus(shell("a", { pendingRuntimeRequest: { kind } })), "confirmation");
  }
  assert.equal(threadStatus(shell("a", { pendingRuntimeRequest: { kind: "user_input", blocking: false }, status: "running" })), "waiting");
  assert.equal(threadStatus(shell("a", { status: "running" })), "working");
  assert.equal(threadStatus(shell("a")), "done");
  assert.equal(threadStatus(shell("a", { lastVisitedAt: newer })), "idle");
  assert.equal(threadStatus(shell("a", { status: "failed" })), "waiting");
});

test("T3 queued and waiting runtimes stay working, including active goals, unless user action is pending", () => {
  for (const status of ["preparing", "queued", "starting", "running", "waiting"]) {
    for (const goal of [undefined, { status: "active" }]) {
      const item = shell("working", { status, goal });
      assert.equal(threadStatus(item), "working", `${status} with goal ${goal?.status}`);
      assert.equal(threadStatus({ ...item, pendingRuntimeRequest: { kind: "user_input" } }), "waiting");
      assert.equal(threadStatus({ ...item, pendingRuntimeRequest: { kind: "command" } }), "confirmation");
      assert.deepEqual(taskFeed([item, shell("inbox")], new Map(), "env", "tasks").map(item => item.title),
        ["inbox", "working"]);
    }
  }
});

test("T3 background waits stay working and sort by send time until the background work finishes", () => {
  for (const task of [{ kind: "subagent" }, { kind: "background_task" },
    { kind: "command", awaited: true }, { kind: "monitor", awaited: true }]) {
    const item = shell("waiting", { pendingBackgroundTasks: [{ taskId: "bg", ...task }],
      latestUserAuthoredMessageAt: older });
    assert.equal(threadStatus(item), "working");
    assert.deepEqual(taskFeed([item, shell("running", { status: "running", latestUserAuthoredMessageAt: newer }),
      shell("inbox")], new Map(), "env", "tasks").map(item => item.title), ["inbox", "running", "waiting"]);
    assert.equal(threadStatus({ ...item, pendingRuntimeRequest: { kind: "user_input" } }), "waiting");
    assert.equal(threadStatus({ ...item, pendingRuntimeRequest: { kind: "command" } }), "confirmation");
    assert.equal(threadStatus({ ...item, pendingBackgroundTasks: [] }), "done");
  }
  for (const kind of ["command", "monitor"]) {
    assert.equal(threadStatus(shell("done", { pendingBackgroundTasks: [{ taskId: "bg", kind }] })), "done");
  }
});

test("T3 feed keeps opaque thread IDs, encodes navigation and filters hidden threads", () => {
  const items = [shell("thread:a/b", { pinnedAt: newer }), shell("normal"), shell("archived", { archivedAt: newer }),
    shell("child", { lineage: { relationshipToParent: "subagent" } }), shell("settled", { settledAt: newer })];
  const feed = taskFeed(items, new Map([["project", { title: "Project" }]]), "environment", "pinned-projects");
  assert.equal(feed.length, 2);
  assert.equal(feed[0]?.id, "t3:environment:thread%3Aa%2Fb");
  assert.equal(feed[0]?.projectLabel, "Project");
  assert.equal(taskFeed(items, new Map(), "environment", "tasks").length, 1);
  assert.equal(threadLink("environment", "thread:a/b"), "t3code://threads/environment/thread%3Aa%2Fb");
});

test("T3 settings round trip without writeback loops and Codex defaults remain unchanged", () => {
  const settings = normalizeTaskKeySettings({ backend: "t3" });
  assert.equal(settings.backend, "t3");
  assert.equal(taskKeySettingsNeedWriteback(settings), false);
  assert.equal(taskKeySettingsNeedWriteback(normalizeTaskKeySettings({})), false);
  assert.equal(normalizeTaskKeySettings({ backend: "unexpected" }).backend, undefined);
  assert.equal(normalizeModelKeySettings({ backend: "t3" }).backend, "t3");
});

test("T3 side chats cannot displace the four inbox threads and two working keys", () => {
  const inbox = [shell("done"), ...[1, 2, 3].map(id => shell(`read-${id}`, { lastVisitedAt: newer }))];
  const working = [shell("working-1", { status: "running" }), shell("working-2", { status: "running" })];
  const sideChats = ["completed", "running"].map(status => shell(`side-${status}`, {
    status, pinnedAt: newer, lineage: { relationshipToParent: "fork", sideChat: true },
  }));
  const hidden = [shell("settled", { settledOverride: "settled" }), shell("settled-at", { settledAt: newer })];
  for (const source of ["tasks", "pinned-projects"]) {
    const feed = taskFeed([...sideChats, ...working, ...hidden, ...inbox], new Map(), "env", source);
    assert.deepEqual(feed.map(item => item.title), ["done", "read-1", "read-2", "read-3", "working-1", "working-2"]);
  }
  assert.deepEqual([...inbox, ...working].map(threadStatus), ["done", "idle", "idle", "idle", "working", "working"]);
  const fork = shell("regular-fork", { lineage: { relationshipToParent: "fork", sideChat: false } });
  assert.equal(taskFeed([fork], new Map(), "env", "tasks").length, 1, "regular forks remain independent sidebar threads");
});

test("T3 inbox returns precede working threads regardless of old send and manual order", () => {
  const items = [
    shell("working-new", { status: "running", latestUserAuthoredMessageAt: newer, activeOrderKey: "a" }),
    shell("done-old", { latestRunCompletedAt: older, latestUserAuthoredMessageAt: newer, activeOrderKey: "b" }),
    shell("done-new", { latestUserAuthoredMessageAt: older, activeOrderKey: "z" }),
    shell("working-old", { status: "running", latestUserAuthoredMessageAt: older, latestRunStartedAt: newer }),
    shell("pinned", { pinnedAt: newer }),
  ];
  const titles = (source: string) => taskFeed(items, new Map(), "env", source).map(item => item.title);
  assert.deepEqual(titles("pinned-projects"), ["pinned", "done-new", "done-old", "working-new", "working-old"]);
  assert.deepEqual(titles("tasks"), ["done-new", "done-old", "working-new", "working-old"]);
});

test("T3 read inbox threads and requests remain above Working, with returns sorted by time", () => {
  const items = [
    shell("working", { status: "running" }),
    shell("read", { lastVisitedAt: newer }),
    shell("approval", { status: "running", latestRunCompletedAt: null, latestRunRequestedAt: older,
      pendingRuntimeRequest: { kind: "command" } }),
    shell("returned", { lastVisitedAt: newer, unsettledAt: "2026-10-28T14:00:00.000Z" }),
  ];
  assert.deepEqual(taskFeed(items, new Map(), "env", "tasks").map(item => item.title),
    ["returned", "read", "approval", "working"]);
});

test("model options are provider scoped and unsupported old options are dropped", () => {
  const models = modelsFromConfig(config);
  const model = models[0]!;
  assert.equal(model.instanceId, "codex-local");
  assert.deepEqual(modelOptions(model, [{ id: "serviceTier", value: "priority" }, { id: "other", value: true },
    { id: "reasoningEffort", value: "low" }], "high"), [{ id: "serviceTier", value: "priority" }, { id: "reasoningEffort", value: "high" }]);
});

test("pairing exchanges a bootstrap link without redirects and requests only orchestration scopes", async () => {
  const request = (async (url, init) => {
    assert.equal(url, "http://127.0.0.1:3773/oauth/token");
    assert.equal(init?.redirect, "error");
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("subject_token"), "test-only");
    assert.equal(body.get("scope"), "orchestration:read orchestration:operate");
    return Response.json({ access_token: "session-only", token_type: "Bearer" });
  }) as typeof fetch;
  assert.deepEqual(await pairT3("http://127.0.0.1:3773/pair#token=test-only", request), { origin: "http://127.0.0.1:3773", token: "session-only" });
  assert.throws(() => serverOrigin("http://remote.example.com"));
  assert.throws(() => serverOrigin("https://user:password@example.com"));
  await assert.rejects(pairT3("http://127.0.0.1:3773/pair", request), /pairing link/);
});

test("desktop pairing links use the explicit local server and never the app origin", async () => {
  let calls = 0;
  const request = (async (url, init) => {
    calls++;
    assert.equal(url, "http://127.0.0.1:3774/oauth/token");
    assert.equal((init?.body as URLSearchParams).get("subject_token"), "test-only");
    return Response.json({ access_token: "session-only", token_type: "Bearer" });
  }) as typeof fetch;
  const link = "t3code://app/pair#token=test-only";
  await assert.rejects(pairT3(link, request), /server address/i);
  assert.equal(calls, 0);
  assert.deepEqual(await pairT3(link, request, "http://127.0.0.1:3774/"), {
    origin: "http://127.0.0.1:3774", token: "session-only",
  });
  await assert.rejects(pairT3(link, request, "http://remote.example.com"), /HTTPS/);
  await assert.rejects(pairT3("t3code://app/other#token=test-only", request, "http://127.0.0.1:3774"), /pairing link/i);
  assert.equal(calls, 1);
});

class Socket extends EventTarget {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
test("Effect RPC handles stream acknowledgements, unary success/failure and disconnect cleanup", async (t) => {
  let socket!: Socket;
  let disconnected = 0;
  const request = (async (url, init) => {
    assert.equal(record(init?.headers).Authorization, "Bearer private-test-session");
    if (String(url).includes("/api/orchestration/")) assert.equal(record(init?.headers)["x-t3-orchestration-protocol"], "2");
    return Response.json(String(url).endsWith("/rpc") ? { ticket: "short-ticket" }
      : { environmentId: "env", orchestrationProtocolVersion: 2 });
  }) as typeof fetch;
  const client = new T3Client({ origin: "http://127.0.0.1:3773", token: "private-test-session" }, () => { disconnected++; }, request, (url) => {
    assert.equal(new URL(url).searchParams.get("wsTicket"), "short-ticket");
    assert.equal(url.includes("private-test-session"), false);
    assert.equal(new URL(url).searchParams.get("orchestrationProtocol"), "2");
    socket = new Socket(); return socket as unknown as WebSocket;
  });
  t.after(() => client.close());
  await client.connect();
  await client.http("/api/orchestration/threads/test/bounded");
  const values: unknown[] = [];
  client.subscribe("orchestration.subscribeShell", {}, (value) => values.push(value));
  const subscription = socket.sent.at(-1)!;
  socket.receive({ _tag: "Chunk", requestId: subscription.id, values: [{ kind: "snapshot" }] });
  assert.equal(values.length, 1);
  assert.deepEqual(socket.sent.at(-1), { _tag: "Ack", requestId: subscription.id });
  const success = client.rpc("server.getConfig", {});
  socket.receive({ _tag: "Exit", requestId: socket.sent.at(-1)!.id, exit: { _tag: "Success", value: config } });
  assert.deepEqual(await success, config);
  const failure = client.rpc("orchestration.dispatchCommand", {});
  socket.receive({ _tag: "Exit", requestId: socket.sent.at(-1)!.id, exit: { _tag: "Failure", cause: [] } });
  await assert.rejects(failure, /rejected/);
  const pending = client.rpc("server.getConfig", {});
  socket.close();
  await assert.rejects(pending, /disconnected/);
  assert.equal(disconnected, 1);
});

const notifier: TaskNotifier = { notify() {}, async importCustomSound() { return false; }, async customSoundAvailable() { return false; } };
test("T3 completion moves the green task from key 2 to key 1 on the live event", async (t) => {
  let receive!: (event: unknown) => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const previews = new Map<string, string>();
  const client: T3RuntimeClient = {
    environmentId: "env", version: "test", async connect() {}, close() {},
    subscribe(tag, _payload, listener) { if (tag === "orchestration.subscribeShell") { receive = listener; ready(); } },
    async rpc() { return config; }, async http() { return {}; },
  };
  const runtime = new T3Runtime(async value => {
    const state = record(value);
    if (state.type === "fingertip-state") {
      const preview = String(state.preview);
      previews.set(String(state.actionId), decodeURIComponent(preview.slice(preview.indexOf(",") + 1)));
    }
  }, notifier, { async loadCredentials() { return { origin: "http://localhost", token: "test" }; }, createClient() { return client; } });
  t.after(() => runtime.shutdown());
  for (const taskPosition of [1, 2]) {
    const id = String(taskPosition);
    runtime.attachAction({ id, async setImage() {}, async showAlert() {} }, normalizeTaskKeySettings({ backend: "t3", taskPosition }));
    runtime.propertyInspectorDidAppear(id);
  }
  await started;
  const working = shell("Recent", { status: "running", latestRunCompletedAt: null, latestUserAuthoredMessageAt: newer });
  const finishing = shell("Finishing", { status: "running", latestRunCompletedAt: null, latestUserAuthoredMessageAt: older });
  receive({ kind: "snapshot", snapshot: { threads: [working, finishing], projects: [] } });
  assert.match(previews.get("1")!, /Recent/);
  assert.match(previews.get("2")!, /Finishing/);
  const completed = { ...finishing, status: "completed", latestRunCompletedAt: newer };
  receive({ kind: "thread.updated", location: "active", thread: completed });
  for (const moveActiveUnreadThreadsToTop of [false, true]) {
    runtime.updateAppearance({ moveActiveUnreadThreadsToTop });
    assert.match(previews.get("1")!, /Finishing/);
    assert.match(previews.get("1")!, /Task 1: Finishing, done/);
    assert.match(previews.get("1")!, /#9bf396/);
    assert.match(previews.get("2")!, /Recent/);
    assert.match(previews.get("2")!, /#9cd5fe/);
  }
  receive({ kind: "thread.updated", location: "active", thread: { ...completed, lastVisitedAt: newer } });
  assert.match(previews.get("1")!, /Finishing/, "reading the inbox task does not move it below the Working shelf");
  receive({ kind: "thread.updated", location: "active", thread: { ...completed, settledOverride: "settled" } });
  assert.match(previews.get("1")!, /Recent/);
  assert.match(previews.get("2")!, /No Task/);
});

test("model key captures lastVisitedAt target, preserves options and requires server readback", async (t) => {
  const streams = new Map<string, (value: unknown) => void>();
  const commands: Record<string, unknown>[] = [];
  let confirmed: unknown = selection;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const client: T3RuntimeClient = {
    environmentId: "env", version: "test", async connect() {}, close() {},
    subscribe(tag, _payload, receive) {
      streams.set(tag, receive);
      if (tag === "orchestration.subscribeShell") receive({ kind: "snapshot", snapshot: { projects: [], threads: [
        shell("first", { modelSelection: selection }), shell("last-visited", { lastVisitedAt: newer, modelSelection: selection }),
      ] } });
    },
    async rpc(tag, payload) {
      if (tag === "server.getConfig") return config;
      commands.push(record(payload)); return {};
    },
    async http() { return { projection: { thread: { modelSelection: confirmed } } }; },
  };
  const runtime = new T3Runtime(async (value) => {
    const payload = record(value);
    if (payload.type === "fingertip-model-state" && Array.isArray(payload.models) && payload.models.length && payload.activeThreadId) ready();
  }, notifier, { async loadCredentials() { return { origin: "http://localhost", token: "test" }; }, createClient() { return client; } });
  t.after(() => { runtime.detachModelKeyAction("key"); runtime.shutdown(); });
  const settings = normalizeModelKeySettings({ backend: "t3", model: JSON.stringify(["codex-local", "model-a"]), effort: "high" });
  runtime.attachModelKeyAction({ id: "key", async setImage() {}, async showAlert() {} }, settings);
  runtime.modelPropertyInspectorDidAppear("key");
  await started;
  assert.equal(await runtime.pressModelKey("key"), false, "command acknowledgement alone is not success");
  assert.equal(commands[0]?.threadId, "last-visited");
  confirmed = { ...selection, options: [{ id: "reasoningEffort", value: "high" }] };
  assert.equal(await runtime.pressModelKey("key"), true);
  streams.get("orchestration.subscribeShell")!({ kind: "thread.updated", location: "active", thread: shell("first", { lastVisitedAt: "2026-10-28T14:00:00.000Z", modelSelection: selection }) });
  await runtime.pressModelKey("key");
  assert.equal(commands.at(-1)?.threadId, "first");
  runtime.shutdown();
  assert.equal(await runtime.pressModelKey("key"), false);
});

test("repository enrichment preserves running threads, projects and later status transitions", async (t) => {
  let receive!: (event: unknown) => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let preview = "";
  const client: T3RuntimeClient = {
    environmentId: "env", version: "test", async connect() {}, close() {},
    subscribe(tag, _payload, listener) { if (tag === "orchestration.subscribeShell") { receive = listener; ready(); } },
    async rpc() { return config; }, async http() { return {}; },
  };
  const runtime = new T3Runtime(async value => {
    const state = record(value);
    if (state.type === "fingertip-state") preview = String(state.preview);
  }, notifier, { async loadCredentials() { return { origin: "http://localhost", token: "test" }; }, createClient() { return client; } });
  t.after(() => runtime.shutdown());
  runtime.attachAction({ id: "task", async setImage() {}, async showAlert() {} }, normalizeTaskKeySettings({ backend: "t3" }));
  runtime.propertyInspectorDidAppear("task");
  await started;
  const working = shell("live", { status: "running", latestRunCompletedAt: null });
  receive({ kind: "snapshot", snapshot: { threads: [working], projects: [{ id: "project", title: "Fingertip" }] } });
  const blue = preview;
  assert.match(decodeURIComponent(blue.slice(blue.indexOf(",") + 1)), /#9cd5fe/);
  for (const status of ["queued", "waiting"]) {
    receive({ kind: "thread.updated", location: "active", thread: { ...working, status, goal: { status: "active" } } });
    assert.match(decodeURIComponent(preview.slice(preview.indexOf(",") + 1)), /#9cd5fe/,
      `${status} during an active goal must keep the blue working render`);
  }
  receive({ kind: "thread.updated", location: "active", thread: { ...working, status: "completed",
    pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor", awaited: true }] } });
  assert.match(decodeURIComponent(preview.slice(preview.indexOf(",") + 1)), /#9cd5fe/,
    "waiting on background work must keep the blue working render");
  receive({ kind: "thread.updated", location: "active", thread: working });
  receive({ kind: "snapshot", resolvedRepositoryIdentityRoots: [], snapshot: { threads: [], projects: [] } });
  assert.equal(preview, blue, "an enrichment snapshot cannot empty the thread list");
  receive({ kind: "snapshot", resolvedRepositoryIdentityRoots: ["/project"], snapshot: { threads: [], projects: [{ id: "other", title: "Other" }] } });
  receive({ kind: "thread.updated", location: "active", thread: { ...working, status: "completed", lastVisitedAt: newer } });
  const idle = decodeURIComponent(preview.slice(preview.indexOf(",") + 1));
  assert.match(idle, /Fingertip/);
  assert.notEqual(preview, blue);
  receive({ kind: "thread.updated", location: "active", thread: working });
  assert.equal(preview, blue, "a new running event must restore the blue working render");
  receive({ kind: "snapshot", snapshot: { threads: [], projects: [] } });
  assert.match(decodeURIComponent(preview.slice(preview.indexOf(",") + 1)), /No Task/);
});
