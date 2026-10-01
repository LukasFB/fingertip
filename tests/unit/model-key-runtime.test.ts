import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskId, type TaskId } from "../../src/catalog/catalog-projection.ts";
import { projectWorkspaceMetadata } from "../../src/catalog/project-label-resolver.ts";
import type { ChatGptBundleResolver } from "../../src/chatgpt/chatgpt-bundle-resolver.ts";
import type { ChatGptNavigationPort } from "../../src/chatgpt/chatgpt-navigation-port.ts";
import type { ChatGptDesktopIpcAdapter, LiveTaskRecord } from "../../src/desktop-ipc/chatgpt-desktop-ipc-adapter.ts";
import { FingertipRuntime } from "../../src/runtime/fingertip-runtime.ts";
import { normalizeModelKeySettings } from "../../src/settings/model-key-settings.ts";
import type { ChatGptWindowTarget } from "../../src/settings/task-key-settings.ts";

const firstThread = parseTaskId("00000000-0000-4000-8000-000000000001");
const secondThread = parseTaskId("00000000-0000-4000-8000-000000000002");
const futureModel = "future-model-12";
const futureEffort = "adaptive-next";

function modelResponse(model = futureModel, efforts = [futureEffort, "ultra-next"]): unknown {
  return {
    data: [{
      model,
      displayName: "Future Model",
      defaultReasoningEffort: futureEffort,
      supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: "A future effort level" })),
      isDefault: true,
      hidden: false,
    }],
    nextCursor: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function modelKeyHarness() {
  type Health = "connecting" | "online" | "offline" | "incompatible";
  const healthListeners = new Set<(health: Health) => void>();
  const activeListeners = new Set<(taskId: TaskId | null) => void>();
  const recordListeners = new Set<(record: LiveTaskRecord) => void>();
  let revision = 0;
  let activeThreadId: TaskId | null = firstThread;
  let health: Health = "online";
  let clock = 0;
  let windowTarget: ChatGptWindowTarget = "last-active";
  let activateWindow = async () => true;
  let initializeCatalog = async (_connection: number) => undefined;
  let listModels: (connection: number) => Promise<unknown> = async () => modelResponse();
  let clients = 0;
  const modelQueries: number[] = [];
  const stoppedClients: number[] = [];
  const changes: { threadId: string; model: string; effort: string | null }[] = [];
  const inspectors: Record<string, unknown>[] = [];
  const images = new Map<string, string[]>();
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const setHealth = (next: Health) => {
    health = next;
    for (const listener of healthListeners) listener(next);
  };
  const runtime = new FingertipRuntime({
    bundleResolver: {
      async resolve() {
        return {
          bundlePath: "/validated/ChatGPT.app", binaryPath: "/validated/codex",
          appVersion: "1", appBuild: "2", codexVersion: "3", fingerprint: "current",
        };
      },
    } as unknown as ChatGptBundleResolver,
    desktopIpc: {
      get state() { return health; },
      get activeTaskId() { return activeThreadId; },
      onHealth(listener: (value: Health) => void) {
        healthListeners.add(listener);
        return () => healthListeners.delete(listener);
      },
      onActiveTask(listener: (value: TaskId | null) => void) {
        activeListeners.add(listener);
        return () => activeListeners.delete(listener);
      },
      onTaskRecord(listener: (record: LiveTaskRecord) => void) {
        recordListeners.add(listener);
        return () => recordListeners.delete(listener);
      },
      onCatalogHint() { return () => undefined; },
      setCatalogTaskIds() {},
      setCompatibilityFingerprint() {},
      async start() { setHealth("online"); },
      stop() { setHealth("offline"); },
      async setModelSelection(threadId: string, selection: { model: string; effort: string | null }) {
        changes.push({ threadId, ...selection });
        return true;
      },
    } as unknown as ChatGptDesktopIpcAdapter,
    navigation: {
      get windowTarget() { return windowTarget; },
      async activateTargetWindow() { return activateWindow(); },
    } as unknown as ChatGptNavigationPort,
    catalogClientFactory: () => {
      const connection = ++clients;
      return {
        async start() { await initializeCatalog(connection); },
        async stop() { stoppedClients.push(connection); },
        async listThreads() { return { data: [], nextCursor: null }; },
        async listModels() {
          modelQueries.push(connection);
          return listModels(connection);
        },
      };
    },
    readWorkspaceMetadata: async () => projectWorkspaceMetadata({}),
    watchWorkspaceMetadata: () => () => undefined,
    propertyInspector: {
      async send(payload) { inspectors.push(payload as Record<string, unknown>); },
    },
    now: () => clock,
    random: () => 0.5,
    setTimer: ((callback: () => void, delay = 0) => {
      timers.push({ callback, delay, cleared: false });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: ((timer: ReturnType<typeof setTimeout>) => {
      const entry = timers[Number(timer) - 1];
      if (entry !== undefined) entry.cleared = true;
    }) as typeof clearTimeout,
  });
  return {
    runtime, changes, inspectors, images, modelQueries, stoppedClients, timers,
    configure(actionId: string, settings: Record<string, unknown> = {}) {
      const captured: string[] = [];
      images.set(actionId, captured);
      const action = {
        id: actionId,
        async setImage(image: string) { captured.push(decodeURIComponent(image)); },
        async showAlert() {},
      };
      runtime.attachModelKeyAction(action, normalizeModelKeySettings({ model: futureModel, effort: futureEffort, ...settings }));
      return {
        update(next: Record<string, unknown>) {
          runtime.updateModelKeySettings(action, normalizeModelKeySettings({ model: futureModel, effort: futureEffort, ...next }));
        },
      };
    },
    active(threadId: TaskId | null) {
      activeThreadId = threadId;
      for (const listener of activeListeners) listener(threadId);
    },
    record(threadId: TaskId, selection: { model?: string | null; effort?: string | null }, freshness: "fresh" | "stale" = "fresh") {
      const record: LiveTaskRecord = {
        taskId: threadId, ownerClientId: "owner", revision: ++revision, status: "idle", freshness,
        facts: { isActive: false, waitingOnApproval: false, waitingOnUserInput: false, hasUnreadTurn: false, ...selection },
      };
      for (const listener of recordListeners) listener(record);
    },
    health: setHealth,
    time(value: number) { clock = value; },
    queryModels(query: (connection: number) => Promise<unknown>) { listModels = query; },
    initializeCatalogWith(initialize: (connection: number) => Promise<undefined>) { initializeCatalog = initialize; },
    targetWindow(target: ChatGptWindowTarget, activate: () => Promise<boolean>) {
      windowTarget = target;
      activateWindow = activate;
    },
  };
}

function assertMarked(harness: ReturnType<typeof modelKeyHarness>, key: string, expected: boolean): void {
  const image = harness.images.get(key)?.at(-1);
  assert.ok(image, `rendered image for ${key}`);
  assert.equal(image.includes('data-active="true"'), expected, key);
}

test("model key borders follow the active thread's exact model and thinking combination", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.configure("same");
  h.configure("duplicate");
  h.configure("different-effort", { effort: "ultra-next" });
  h.configure("different-model", { model: "another-model" });
  await settle();
  assertMarked(h, "same", false);

  h.record(firstThread, { model: futureModel, effort: futureEffort });
  h.runtime.modelPropertyInspectorDidAppear("same");
  await settle();
  assertMarked(h, "same", true);
  assertMarked(h, "duplicate", true);
  assertMarked(h, "different-effort", false);
  assertMarked(h, "different-model", false);
  const preview = decodeURIComponent(String(h.inspectors.findLast((state) => state.actionId === "same")?.preview));
  assert.equal(preview.includes('data-active="true"'), true);

  h.record(firstThread, { model: futureModel, effort: "ultra-next" });
  await settle();
  assertMarked(h, "same", false);
  assertMarked(h, "duplicate", false);
  assertMarked(h, "different-effort", true);

  h.active(secondThread);
  await settle();
  for (const key of h.images.keys()) assertMarked(h, key, false);
  h.record(secondThread, { model: "another-model", effort: futureEffort });
  await settle();
  assertMarked(h, "different-model", true);
  h.active(null);
  await settle();
  for (const key of h.images.keys()) assertMarked(h, key, false);
});

test("model key borders require fresh thread settings and disappear immediately when IPC goes offline", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.configure("model");
  await settle();
  assert.equal(await h.runtime.pressModelKey("model"), true);
  await settle();
  assertMarked(h, "model", false);

  h.record(firstThread, { model: futureModel });
  await settle();
  assertMarked(h, "model", false);
  h.record(firstThread, { model: futureModel, effort: futureEffort });
  await settle();
  assertMarked(h, "model", true);
  h.record(firstThread, { model: futureModel, effort: futureEffort }, "stale");
  await settle();
  assertMarked(h, "model", false);
  h.record(firstThread, { model: futureModel, effort: futureEffort });
  await settle();
  assertMarked(h, "model", true);
  h.health("offline");
  await settle();
  assertMarked(h, "model", false);
});

test("an explicit default effort is marked only when the active thread reports null rather than unknown", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.queryModels(async () => modelResponse(futureModel, []));
  h.configure("default", { effort: "" });
  await settle();
  h.record(firstThread, { model: futureModel });
  await settle();
  assertMarked(h, "default", false);
  h.record(firstThread, { model: futureModel, effort: null });
  await settle();
  assertMarked(h, "default", true);
});

test("the active model key keeps thread settings outside the task catalog while other records expire", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.configure("model");
  await settle();
  h.record(firstThread, { model: futureModel, effort: futureEffort });
  await settle();
  assertMarked(h, "model", true);
  assert.equal(h.timers.some((timer) => timer.delay === 30_000 && !timer.cleared), false);

  h.record(secondThread, { model: futureModel, effort: futureEffort });
  await settle();
  const expiry = h.timers.find((timer) => timer.delay === 30_000 && !timer.cleared);
  assert.ok(expiry);
  h.time(31_000);
  expiry.callback();
  await settle();
  assertMarked(h, "model", true);
  h.active(secondThread);
  await settle();
  assertMarked(h, "model", false);
});

test("configured future models and effort levels apply to the active thread at each press", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.configure("model");
  await settle();

  assert.equal(await h.runtime.pressModelKey("model"), true);
  h.active(secondThread);
  assert.equal(await h.runtime.pressModelKey("model"), true);
  assert.deepEqual(h.changes, [
    { threadId: firstThread, model: futureModel, effort: futureEffort },
    { threadId: secondThread, model: futureModel, effort: futureEffort },
  ]);
  assert.deepEqual(h.modelQueries, [1]);
});

test("unsupported settings, missing active threads and offline IPC do not change thread settings", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.configure("unknown-model", { model: "not-in-catalog" });
  h.configure("unknown-effort", { effort: "not-supported" });
  h.configure("empty-model", { model: "" });
  h.configure("empty-effort", { effort: "" });
  h.configure("valid");
  await settle();

  for (const key of ["unknown-model", "unknown-effort", "empty-model", "empty-effort", "missing-key"]) {
    assert.equal(await h.runtime.pressModelKey(key), false, key);
  }
  h.active(null);
  assert.equal(await h.runtime.pressModelKey("valid"), false);
  h.active(firstThread);
  h.health("offline");
  assert.equal(await h.runtime.pressModelKey("valid"), false);
  assert.deepEqual(h.changes, []);
});

test("a press captures its thread and selection while model discovery is still loading", async (t) => {
  const catalog = deferred<unknown>();
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.queryModels(async () => catalog.promise);
  const key = h.configure("model");
  await settle();

  const press = h.runtime.pressModelKey("model");
  await settle();
  h.active(secondThread);
  key.update({ effort: "ultra-next" });
  catalog.resolve(modelResponse());

  assert.equal(await press, true);
  assert.deepEqual(h.changes, [{ threadId: firstThread, model: futureModel, effort: futureEffort }]);
  assert.equal(await h.runtime.pressModelKey("model"), true);
  assert.deepEqual(h.changes[1], { threadId: secondThread, model: futureModel, effort: "ultra-next" });
  assert.deepEqual(h.modelQueries, [1]);
});

test("main-key physical window preferences do not redirect a model key from the active thread", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.configure("model");
  await settle();
  let activations = 0;
  h.targetWindow("leftmost", async () => { activations += 1; h.active(secondThread); return true; });

  assert.equal(await h.runtime.pressModelKey("model"), true);
  assert.equal(activations, 0);
  assert.deepEqual(h.changes, [{ threadId: firstThread, model: futureModel, effort: futureEffort }]);

  h.active(secondThread);
  assert.equal(await h.runtime.pressModelKey("model"), true);
  assert.equal(activations, 0);
  assert.deepEqual(h.changes[1], { threadId: secondThread, model: futureModel, effort: futureEffort });
});

test("a press refreshes an aged catalog so newly available models work without a plugin update", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  const key = h.configure("model");
  await settle();
  h.queryModels(async () => modelResponse("future-model-13", ["brand-new-effort"]));
  key.update({ model: "future-model-13", effort: "brand-new-effort" });
  h.time(60_000);

  assert.equal(await h.runtime.pressModelKey("model"), true);
  assert.deepEqual(h.modelQueries, [1, 1]);
  assert.deepEqual(h.changes, [{ threadId: firstThread, model: "future-model-13", effort: "brand-new-effort" }]);
});

test("models with no selectable effort use the server default and reject configured effort levels", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.queryModels(async () => modelResponse(futureModel, []));
  h.configure("default-effort", { effort: "" });
  h.configure("explicit-effort", { effort: futureEffort });
  await settle();

  assert.equal(await h.runtime.pressModelKey("default-effort"), true);
  assert.equal(await h.runtime.pressModelKey("explicit-effort"), false);
  assert.deepEqual(h.changes, [{ threadId: firstThread, model: futureModel, effort: null }]);
});

test("model inspectors receive their own action IDs and appearance previews with discovered options", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.configure("left-key", { backgroundColor: "#eeaa22", modelFontSize: 12, effortFontSize: 7, textAlignment: "left" });
  h.configure("right-key", { backgroundColor: "#122334", textAlignment: "right" });
  await settle();
  h.runtime.modelPropertyInspectorDidAppear("left-key");
  h.runtime.modelPropertyInspectorDidAppear("right-key");
  await settle();

  for (const key of ["left-key", "right-key"]) {
    const state = h.inspectors.findLast((payload) => payload.actionId === key && payload.loading === false);
    assert.ok(state);
    assert.equal(state.type, "fingertip-model-state");
    assert.equal(state.activeThreadId, firstThread);
    assert.equal(state.error, null);
    assert.deepEqual((state.models as { model: string }[]).map((model) => model.model), [futureModel]);
    const preview = decodeURIComponent(String(state.preview));
    assert.equal(preview.includes(`fill="${key === "left-key" ? "#eeaa22" : "#122334"}"`), true);
    assert.equal(preview.includes(`text-anchor="${key === "left-key" ? "start" : "end"}"`), true);
  }
  const leftPreview = decodeURIComponent(String(h.inspectors.findLast((payload) => payload.actionId === "left-key")?.preview));
  assert.equal(leftPreview.includes('font-size="12"'), true);
  assert.equal(leftPreview.includes('font-size="7"'), true);
});

test("a failed model refresh keeps the saved selection and key appearance for a later retry", async (t) => {
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.configure("model", { backgroundColor: "#abcdef", modelFontSize: 13, textAlignment: "right" });
  await settle();
  h.runtime.modelPropertyInspectorDidAppear("model");
  await settle();
  h.queryModels(async () => { throw new Error("temporary discovery failure"); });
  await h.runtime.refreshModelCatalog();

  assert.equal(await h.runtime.pressModelKey("model"), false);
  assert.deepEqual(h.changes, []);
  const failed = h.inspectors.findLast((payload) => payload.actionId === "model" && payload.loading === false);
  assert.ok(failed);
  assert.equal(typeof failed.error, "string");
  const preview = decodeURIComponent(String(failed.preview));
  assert.equal(preview.includes('fill="#abcdef"'), true);
  assert.equal(preview.includes('font-size="13"'), true);
  assert.equal(preview.includes('text-anchor="end"'), true);

  h.queryModels(async () => modelResponse());
  await h.runtime.refreshModelCatalog();
  assert.equal(await h.runtime.pressModelKey("model"), true);
  assert.deepEqual(h.changes, [{ threadId: firstThread, model: futureModel, effort: futureEffort }]);
});

test("detaching or shutting down a key during discovery cancels its pending press", async (t) => {
  for (const dispose of ["detach", "shutdown"] as const) {
    await t.test(dispose, async () => {
      const catalog = deferred<unknown>();
      const h = modelKeyHarness();
      t.after(() => h.runtime.shutdown());
      h.queryModels(async () => catalog.promise);
      h.configure("model");
      await settle();
      const press = h.runtime.pressModelKey("model");
      await settle();
      if (dispose === "detach") h.runtime.detachModelKeyAction("model");
      else h.runtime.shutdown();
      const before = h.images.get("model")?.length;
      catalog.resolve(modelResponse());

      assert.equal(await press, false);
      await settle();
      assert.deepEqual(h.changes, []);
      assert.equal(h.images.get("model")?.length, before);
    });
  }
});

test("a catalog response from before reconnect cannot overwrite replacement model options", async (t) => {
  const stale = deferred<unknown>();
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.queryModels(async (connection) => connection === 1 ? stale.promise : modelResponse("replacement-model"));
  h.configure("model");
  h.runtime.modelPropertyInspectorDidAppear("model");
  await settle();
  h.runtime.systemDidWake();
  await settle();
  assert.deepEqual(h.modelQueries, [1, 2]);
  const before = h.inspectors.length;
  stale.resolve(modelResponse("stale-model"));
  await settle();

  assert.equal(h.inspectors.length, before);
  const current = h.inspectors.findLast((payload) => payload.actionId === "model" && payload.loading === false);
  assert.deepEqual((current?.models as { model: string }[]).map((model) => model.model), ["replacement-model"]);
  assert.deepEqual(h.stoppedClients, [1]);
});

test("reconnecting while a press waits for discovery cancels that press", async (t) => {
  const stale = deferred<unknown>();
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.queryModels(async (connection) => connection === 1 ? stale.promise : modelResponse());
  h.configure("model");
  await settle();
  const press = h.runtime.pressModelKey("model");
  await settle();
  h.runtime.systemDidWake();
  await settle();
  stale.resolve(modelResponse());

  assert.equal(await press, false);
  assert.deepEqual(h.changes, []);
});

test("retained model options cannot authorize a press before the replacement catalog is ready", async (t) => {
  const initializing = deferred<undefined>();
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.configure("model");
  h.runtime.modelPropertyInspectorDidAppear("model");
  await settle();
  h.initializeCatalogWith(async () => initializing.promise);
  h.runtime.systemDidWake();
  await settle();

  assert.equal(await h.runtime.pressModelKey("model"), false);
  assert.deepEqual(h.changes, []);
  assert.deepEqual(h.modelQueries, [1]);
  const retained = h.inspectors.findLast((payload) => payload.actionId === "model");
  assert.ok(retained);
  assert.equal(retained.loading, true);
  assert.deepEqual((retained.models as { model: string }[]).map((model) => model.model), [futureModel]);

  initializing.resolve(undefined);
  await settle();
  assert.deepEqual(h.modelQueries, [1, 2]);
  assert.equal(await h.runtime.pressModelKey("model"), true);
  assert.deepEqual(h.changes, [{ threadId: firstThread, model: futureModel, effort: futureEffort }]);
});

test("going offline while a press waits for discovery cannot invoke the settings setter", async (t) => {
  const catalog = deferred<unknown>();
  const h = modelKeyHarness();
  t.after(() => h.runtime.shutdown());
  h.queryModels(async () => catalog.promise);
  h.configure("model");
  await settle();
  const press = h.runtime.pressModelKey("model");
  await settle();
  h.health("offline");
  catalog.resolve(modelResponse());

  assert.equal(await press, false);
  assert.deepEqual(h.changes, []);
});
