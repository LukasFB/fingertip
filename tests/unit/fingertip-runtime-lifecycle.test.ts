import assert from "node:assert/strict";
import test from "node:test";

import type { ChatGptBundleResolver } from "../../src/chatgpt/chatgpt-bundle-resolver.ts";
import type { ChatGptNavigationPort } from "../../src/chatgpt/chatgpt-navigation-port.ts";
import type {
  ChatGptDesktopIpcAdapter,
  LiveTaskRecord,
} from "../../src/desktop-ipc/chatgpt-desktop-ipc-adapter.ts";
import { parseTaskId } from "../../src/catalog/catalog-projection.ts";
import {
  computeRetryDelayMs,
  FingertipRuntime,
  type CatalogClientLifecyclePort,
} from "../../src/runtime/fingertip-runtime.ts";
import { projectWorkspaceMetadata } from "../../src/catalog/project-label-resolver.ts";
import { normalizeTaskKeySettings } from "../../src/settings/task-key-settings.ts";

test("IPC and catalog reconnect backoff is 1/2/5/10 seconds with bounded jitter", () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, attempt) => computeRetryDelayMs(attempt, () => 0.5)), [
    1_000, 2_000, 5_000, 10_000, 10_000, 10_000,
  ]);
  assert.equal(computeRetryDelayMs(0, () => 0), 900);
  assert.equal(computeRetryDelayMs(0, () => 1), 1_100);
});

test("IPC reconnects are limited to once per minute", async () => {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    timers.push({ callback, delay, cleared: false });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    const entry = timers[Number(timer) - 1];
    if (entry !== undefined) entry.cleared = true;
  }) as typeof clearTimeout;
  let starts = 0;
  const healthListeners = new Set<(state: "connecting" | "online" | "offline" | "incompatible") => void>();
  const runtime = new FingertipRuntime({
    desktopIpc: {
      onHealth(listener: (state: "connecting" | "online" | "offline" | "incompatible") => void) {
        healthListeners.add(listener);
        return () => healthListeners.delete(listener);
      },
      onTaskRecord() { return () => undefined; },
      onCatalogHint() { return () => undefined; },
      start() { starts += 1; return Promise.reject(new Error("socket unavailable")); },
      stop() {},
    } as unknown as ChatGptDesktopIpcAdapter,
    propertyInspector: { async send() {} },
    setTimer,
    clearTimer,
  });

  runtime.attachAction({ id: "one", async setImage() {}, async showAlert() {} }, normalizeTaskKeySettings(undefined));
  await Promise.resolve();
  assert.equal(starts, 1);
  const retry = timers.find((timer) => timer.delay === 60_000 && !timer.cleared);
  assert.ok(retry);
  for (const listener of healthListeners) listener("offline");
  assert.equal(timers.filter((timer) => timer.delay === 60_000 && !timer.cleared).length, 1);
  runtime.shutdown();
});

test("brief desktop IPC reconnects retain the online key image while a real outage still warns", async () => {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    timers.push({ callback, delay, cleared: false });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    const entry = timers[Number(timer) - 1];
    if (entry !== undefined) entry.cleared = true;
  }) as typeof clearTimeout;
  const healthListeners = new Set<(state: "connecting" | "online" | "offline" | "incompatible") => void>();
  const taskListeners = new Set<(record: LiveTaskRecord) => void>();
  const fastWrites: Array<{ taskId: string; enabled: boolean }> = [];
  const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  const desktopIpc = {
    activeTaskId: taskId,
    onHealth(listener: (state: "connecting" | "online" | "offline" | "incompatible") => void) {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    onTaskRecord(listener: (record: LiveTaskRecord) => void) {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    },
    onCatalogHint() { return () => undefined; },
    async setFastMode(targetTaskId: string, enabled: boolean) {
      fastWrites.push({ taskId: targetTaskId, enabled });
      return true;
    },
    async start() {},
    stop() {},
  } as unknown as ChatGptDesktopIpcAdapter;
  const runtime = new FingertipRuntime({
    desktopIpc,
    bundleResolver: { resolve: () => new Promise<never>(() => undefined) } as unknown as ChatGptBundleResolver,
    propertyInspector: { async send() {} },
    setTimer,
    clearTimer,
  });
  let fastAlerts = 0;
  runtime.attachFastModeAction({
    id: "fast",
    async setImage() {},
    async showAlert() { fastAlerts += 1; },
  });

  for (const listener of healthListeners) listener("online");
  const liveRecord = Object.freeze({
    taskId,
    ownerClientId: "window-1",
    revision: 1,
    facts: Object.freeze({
      isActive: false,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      hasUnreadTurn: false,
    }),
    status: "idle" as const,
    freshness: "fresh" as const,
  });
  for (const listener of taskListeners) listener(liveRecord);
  await runtime.pressFastMode("fast");
  assert.deepEqual(fastWrites, [{ taskId, enabled: true }]);
  assert.equal(fastAlerts, 0);

  for (const listener of healthListeners) listener("offline");
  for (const listener of taskListeners) listener(Object.freeze({ ...liveRecord, freshness: "stale" as const }));
  const firstWarning = timers.find((timer) => timer.delay === 2_500 && !timer.cleared);
  assert.ok(firstWarning);
  for (const listener of healthListeners) listener("online");
  assert.equal(firstWarning.cleared, true);

  for (const listener of healthListeners) listener("offline");
  const lastingWarning = timers.findLast((timer) => timer.delay === 2_500 && !timer.cleared);
  assert.ok(lastingWarning);
  lastingWarning.callback();
  await Promise.resolve();
  runtime.shutdown();
});

test("Fast Mode acknowledges a successful write immediately and never falls back to a project Thread", async () => {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    timers.push({ callback, delay, cleared: false });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    const entry = timers[Number(timer) - 1];
    if (entry !== undefined) entry.cleared = true;
  }) as typeof clearTimeout;
  const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  const healthListeners = new Set<(state: "connecting" | "online" | "offline" | "incompatible") => void>();
  const taskListeners = new Set<(record: LiveTaskRecord) => void>();
  const writes: Array<{ taskId: string; enabled: boolean }> = [];
  const desktopIpc = {
    activeTaskId: taskId,
    onHealth(listener: (state: "connecting" | "online" | "offline" | "incompatible") => void) {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    onTaskRecord(listener: (record: LiveTaskRecord) => void) {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    },
    onCatalogHint() { return () => undefined; },
    async setFastMode(targetTaskId: string, enabled: boolean) {
      writes.push({ taskId: targetTaskId, enabled });
      return true;
    },
    async start() {},
    stop() {},
  } as unknown as ChatGptDesktopIpcAdapter;
  const images: string[] = [];
  let alerts = 0;
  const runtime = new FingertipRuntime({
    desktopIpc,
    bundleResolver: { resolve: () => new Promise<never>(() => undefined) } as unknown as ChatGptBundleResolver,
    propertyInspector: { async send() {} },
    setTimer,
    clearTimer,
  });
  runtime.attachFastModeAction({
    id: "fast",
    async setImage(image: string) { images.push(image); },
    async showAlert() { alerts += 1; },
  });
  for (const listener of healthListeners) listener("online");
  const standard = Object.freeze({
    taskId,
    ownerClientId: "window-1",
    revision: 1,
    facts: Object.freeze({
      isActive: false,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      hasUnreadTurn: false,
      serviceTier: "default",
    }),
    status: "idle" as const,
    freshness: "fresh" as const,
  });
  for (const listener of taskListeners) listener(standard);
  await runtime.pressFastMode("fast");
  await Promise.resolve();
  assert.deepEqual(writes, [{ taskId, enabled: true }]);
  assert.equal(decodeURIComponent(images.at(-1) ?? "").includes('data-animation="fast-electric"'), true);

  // A stale settings replay must not undo a successful write while ChatGPT is
  // still converging on the requested tier.
  for (const listener of taskListeners) listener(standard);
  await Promise.resolve();
  assert.equal(decodeURIComponent(images.at(-1) ?? "").includes('data-animation="fast-electric"'), true);

  const fast = Object.freeze({
    ...standard,
    revision: 2,
    facts: Object.freeze({ ...standard.facts, serviceTier: "priority" }),
  });
  for (const listener of taskListeners) listener(fast);
  for (const listener of taskListeners) listener(Object.freeze({ ...standard, revision: 3 }));
  await Promise.resolve();
  assert.equal(decodeURIComponent(images.at(-1) ?? "").includes("STANDARD"), true);

  (desktopIpc as unknown as { activeTaskId: string | null }).activeTaskId = null;
  await runtime.pressFastMode("fast");
  assert.equal(alerts, 1);
  assert.deepEqual(writes, [{ taskId, enabled: true }]);
  runtime.shutdown();
});

test("shared services start once, PI counts as a consumer, grace cancels, and final shutdown disposes", async () => {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    timers.push({ callback, delay, cleared: false });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    const index = Number(timer) - 1;
    const entry = timers[index];
    if (entry !== undefined) entry.cleared = true;
  }) as typeof clearTimeout;
  let bundleStarts = 0;
  const bundleResolver = {
    resolve() {
      bundleStarts += 1;
      return new Promise<never>(() => undefined);
    },
  } as unknown as ChatGptBundleResolver;
  let ipcStarts = 0;
  let ipcStops = 0;
  const desktopIpc = {
    state: "offline",
    onHealth() { return () => undefined; },
    onTaskRecord() { return () => undefined; },
    onCatalogHint() { return () => undefined; },
    setCatalogTaskIds() {},
    setCompatibilityFingerprint() {},
    clearCompatibilityLatch() {},
    start() { ipcStarts += 1; return new Promise<void>(() => undefined); },
    stop() { ipcStops += 1; },
  } as unknown as ChatGptDesktopIpcAdapter;
  const runtime = new FingertipRuntime({
    bundleResolver,
    desktopIpc,
    navigation: { async openTask() { return true; } } as unknown as ChatGptNavigationPort,
    propertyInspector: { async send() {} },
    setTimer,
    clearTimer,
    now: () => 1_000,
  });
  const images: string[] = [];
  const action = (id: string) => ({ id, async setImage(image: string) { images.push(image); }, async showAlert() {} });
  const settings = normalizeTaskKeySettings(undefined);

  runtime.attachAction(action("one"), settings);
  runtime.attachAction(action("two"), settings);
  assert.equal(bundleStarts, 1);
  assert.equal(ipcStarts, 1);

  runtime.propertyInspectorDidAppear("one");
  runtime.detachAction("one");
  runtime.detachAction("two");
  assert.equal(timers.some((timer) => timer.delay === 30_000 && !timer.cleared), false);

  runtime.propertyInspectorDidDisappear("one");
  const firstGrace = timers.find((timer) => timer.delay === 30_000 && !timer.cleared);
  assert.ok(firstGrace);
  runtime.attachAction(action("three"), settings);
  assert.equal(firstGrace.cleared, true);
  assert.equal(bundleStarts, 1);
  assert.equal(ipcStarts, 1);

  runtime.detachAction("three");
  const finalGrace = timers.findLast((timer) => timer.delay === 30_000 && !timer.cleared);
  assert.ok(finalGrace);
  finalGrace.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ipcStops, 1);

  images.length = 0;
  runtime.attachAction(action("four"), settings);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bundleStarts, 2);
  assert.equal(ipcStarts, 2);
  assert.equal(decodeURIComponent(images.at(-1) ?? "").includes("Loading…"), true);
  runtime.shutdown();
});

test("visible Task Change footers are read from their own App Server thread", async () => {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    timers.push({ callback, delay, cleared: false });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    const entry = timers[Number(timer) - 1];
    if (entry !== undefined) entry.cleared = true;
  }) as typeof clearTimeout;
  const taskId = "00000000-0000-4000-8000-000000000001";
  const threadReads: string[] = [];
  const runtime = new FingertipRuntime({
    bundleResolver: {
      async resolve() {
        return {
          bundlePath: "/validated/ChatGPT.app",
          binaryPath: "/validated/codex",
          appVersion: "1",
          appBuild: "2",
          codexVersion: "codex 3",
          fingerprint: "bundle-a",
        };
      },
    } as ChatGptBundleResolver,
    desktopIpc: {
      state: "offline",
      onHealth() { return () => undefined; },
      onTaskRecord() { return () => undefined; },
      onCatalogHint() { return () => undefined; },
      setCatalogTaskIds() {},
      setCompatibilityFingerprint() {},
      clearCompatibilityLatch() {},
      async start() {},
      stop() {},
    } as unknown as ChatGptDesktopIpcAdapter,
    catalogClientFactory: () => ({
      async start() {},
      async stop() {},
      async listThreads() {
        return {
          data: [{
            id: taskId,
            name: "Task-owned changes",
            cwd: "/work/project",
            createdAt: 1,
            updatedAt: 1,
            recencyAt: 1,
            ephemeral: false,
            parentThreadId: null,
          }],
          nextCursor: null,
        };
      },
      async readThread(input: { readonly threadId: string }) {
        threadReads.push(input.threadId);
        return {
          thread: {
            turns: [{
              items: [{
                type: "fileChange",
                changes: [{ path: "src/owned.ts", diff: "@@ -0,0 +1 @@\n+owned\n" }],
              }],
            }],
          },
        };
      },
    }),
    readWorkspaceMetadata: async () => projectWorkspaceMetadata({}),
    navigation: { async openTask() { return true; } } as unknown as ChatGptNavigationPort,
    propertyInspector: { async send() {} },
    setTimer,
    clearTimer,
  });

  runtime.updateAppearance({ showGitDiffStats: true });
  runtime.attachAction(
    { id: "one", async setImage() {}, async showAlert() {} },
    normalizeTaskKeySettings({ taskSource: "tasks" }),
  );
  for (let iteration = 0; iteration < 5; iteration += 1) await new Promise((resolve) => setImmediate(resolve));
  const taskChangeRefresh = timers.find((timer) => timer.delay === 0 && !timer.cleared);
  assert.ok(taskChangeRefresh);
  taskChangeRefresh.callback();
  for (let iteration = 0; iteration < 5; iteration += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(threadReads, [taskId]);
  runtime.shutdown();
});

test("ongoing Goals are queried for every visible key when the shared Goal badge is enabled", async () => {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    timers.push({ callback, delay, cleared: false });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    const entry = timers[Number(timer) - 1];
    if (entry !== undefined) entry.cleared = true;
  }) as typeof clearTimeout;
  const taskId = "00000000-0000-4000-8000-000000000001";
  const goalReads: string[] = [];
  const images: string[] = [];
  const runtime = new FingertipRuntime({
    bundleResolver: {
      async resolve() {
        return {
          bundlePath: "/validated/ChatGPT.app",
          binaryPath: "/validated/codex",
          appVersion: "1",
          appBuild: "2",
          codexVersion: "codex 3",
          fingerprint: "bundle-a",
        };
      },
    } as ChatGptBundleResolver,
    desktopIpc: {
      state: "offline",
      onHealth() { return () => undefined; },
      onTaskRecord() { return () => undefined; },
      onCatalogHint() { return () => undefined; },
      setCatalogTaskIds() {},
      setCompatibilityFingerprint() {},
      clearCompatibilityLatch() {},
      async start() {},
      stop() {},
    } as unknown as ChatGptDesktopIpcAdapter,
    catalogClientFactory: () => ({
      async start() {},
      async stop() {},
      async listThreads() {
        return {
          data: [{
            id: taskId,
            name: "Goal Task",
            cwd: "/work/project",
            createdAt: 1,
            updatedAt: 1,
            recencyAt: 1,
            ephemeral: false,
            parentThreadId: null,
          }],
          nextCursor: null,
        };
      },
      async readThreadGoal(input: { readonly threadId: string }) {
        goalReads.push(input.threadId);
        return { goal: { status: "usageLimited", objective: "must-not-cross" } };
      },
    }),
    readWorkspaceMetadata: async () => projectWorkspaceMetadata({}),
    navigation: { async openTask() { return true; } } as unknown as ChatGptNavigationPort,
    propertyInspector: { async send() {} },
    setTimer,
    clearTimer,
  });

  runtime.updateAppearance({ showGoalBadge: true });

  runtime.attachAction(
    { id: "hidden", async setImage() {}, async showAlert() {} },
    normalizeTaskKeySettings({ taskSource: "tasks" }),
  );
  runtime.attachAction(
    { id: "visible", async setImage(image: string) { images.push(image); }, async showAlert() {} },
    normalizeTaskKeySettings({ taskSource: "tasks" }),
  );
  for (let iteration = 0; iteration < 8; iteration += 1) await new Promise((resolve) => setImmediate(resolve));

  const svg = decodeURIComponent(images.at(-1) ?? "");
  assert.deepEqual(goalReads, [taskId]);
  assert.equal(svg.includes('data-badge="goal"'), true);
  assert.equal(svg.includes("must-not-cross"), false);
  runtime.shutdown();
});

test("global-state changes request an immediate catalog refresh and the watcher is disposed", () => {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    timers.push({ callback, delay, cleared: false });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    const entry = timers[Number(timer) - 1];
    if (entry !== undefined) entry.cleared = true;
  }) as typeof clearTimeout;
  const metadataWatcher: { notify: (() => void) | null } = { notify: null };
  let watcherStops = 0;
  const runtime = new FingertipRuntime({
    bundleResolver: {
      resolve() { return new Promise<never>(() => undefined); },
    } as unknown as ChatGptBundleResolver,
    desktopIpc: {
      state: "offline",
      onHealth() { return () => undefined; },
      onTaskRecord() { return () => undefined; },
      onCatalogHint() { return () => undefined; },
      setCatalogTaskIds() {},
      setCompatibilityFingerprint() {},
      clearCompatibilityLatch() {},
      start() { return new Promise<void>(() => undefined); },
      stop() {},
    } as unknown as ChatGptDesktopIpcAdapter,
    watchWorkspaceMetadata(onChange) {
      metadataWatcher.notify = onChange;
      return () => { watcherStops += 1; };
    },
    navigation: { async openTask() { return true; } } as unknown as ChatGptNavigationPort,
    propertyInspector: { async send() {} },
    setTimer,
    clearTimer,
  });

  runtime.attachAction(
    { id: "one", async setImage() {}, async showAlert() {} },
    normalizeTaskKeySettings(undefined),
  );
  assert.ok(metadataWatcher.notify);
  metadataWatcher.notify();
  assert.equal(timers.findLast((timer) => !timer.cleared)?.delay, 100);

  runtime.shutdown();
  assert.equal(watcherStops, 1);
});

test("three identical catalog schema failures expose an incompatible diagnosis", async () => {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const setTimer = ((callback: () => void, delay = 0) => {
    timers.push({ callback, delay, cleared: false });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    const entry = timers[Number(timer) - 1];
    if (entry !== undefined) entry.cleared = true;
  }) as typeof clearTimeout;
  const desktopIpc = {
    state: "offline",
    onHealth() { return () => undefined; },
    onTaskRecord() { return () => undefined; },
    onCatalogHint() { return () => undefined; },
    setCatalogTaskIds() {},
    setCompatibilityFingerprint() {},
    clearCompatibilityLatch() {},
    start() { return new Promise<void>(() => undefined); },
    stop() {},
  } as unknown as ChatGptDesktopIpcAdapter;
  let starts = 0;
  const catalogClientFactory = (): CatalogClientLifecyclePort => ({
    async start() { starts += 1; },
    async listThreads() { return { data: "PRIVATE TASK CONTENT", nextCursor: null }; },
    async stop() {},
  });
  const propertyInspectorMessages: unknown[] = [];
  const runtime = new FingertipRuntime({
    bundleResolver: {
      async resolve() {
        return {
          bundlePath: "/validated/ChatGPT.app",
          binaryPath: "/validated/codex",
          appVersion: "1",
          appBuild: "2",
          codexVersion: "codex 3",
          fingerprint: "bundle-a",
        };
      },
    } as ChatGptBundleResolver,
    desktopIpc,
    catalogClientFactory,
    readWorkspaceMetadata: async () => projectWorkspaceMetadata({}),
    navigation: { async openTask() { return true; } } as unknown as ChatGptNavigationPort,
    propertyInspector: { async send(payload) { propertyInspectorMessages.push(payload); } },
    random: () => 0.5,
    setTimer,
    clearTimer,
    now: () => 1_000,
  });
  const action = { id: "one", async setImage() {}, async showAlert() {} };
  runtime.attachAction(action, normalizeTaskKeySettings(undefined));
  runtime.propertyInspectorDidAppear(action.id);
  const flush = async (): Promise<void> => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await flush();
  for (let attempt = 1; attempt < 3; attempt += 1) {
    const retry = timers.findLast((timer) => !timer.cleared && timer.delay < 10_000);
    assert.ok(retry);
    retry.cleared = true;
    retry.callback();
    await flush();
  }

  const lastMessage = propertyInspectorMessages.at(-1) as { connection?: { code?: string } } | undefined;
  assert.equal(starts, 3);
  assert.equal(lastMessage?.connection?.code, "CATALOG_INCOMPATIBLE");
  assert.equal(timers.some((timer) => !timer.cleared && timer.delay === 10_000), true);
  assert.equal(JSON.stringify(propertyInspectorMessages).includes("PRIVATE TASK CONTENT"), false);
  runtime.shutdown();
});

test("wake and app lifecycle reconnect without clearing compatibility latches, while manual retry does", () => {
  let clears = 0;
  const desktopIpc = {
    state: "incompatible",
    onHealth() { return () => undefined; },
    onTaskRecord() { return () => undefined; },
    onCatalogHint() { return () => undefined; },
    setCatalogTaskIds() {},
    setCompatibilityFingerprint() {},
    clearCompatibilityLatch() { clears += 1; },
    start() { return Promise.reject(new Error("latched")); },
    stop() {},
  } as unknown as ChatGptDesktopIpcAdapter;
  const runtime = new FingertipRuntime({
    desktopIpc,
    propertyInspector: { async send() {} },
  });

  runtime.systemDidWake();
  runtime.applicationDidLaunch();
  assert.equal(clears, 0);

  runtime.attachAction({ id: "one", async setImage() {}, async showAlert() {} }, normalizeTaskKeySettings(undefined));
  runtime.retryNow();
  assert.equal(clears, 1);
  runtime.shutdown();
});

test("wake starts a fresh catalog refresh even when the previous generation was still querying", async () => {
  const desktopIpc = {
    state: "offline",
    onHealth() { return () => undefined; },
    onTaskRecord() { return () => undefined; },
    onCatalogHint() { return () => undefined; },
    setCatalogTaskIds() {},
    setCompatibilityFingerprint() {},
    clearCompatibilityLatch() {},
    async start() {},
    stop() {},
  } as unknown as ChatGptDesktopIpcAdapter;
  let clientNumber = 0;
  const listCalls: number[] = [];
  const firstQuery = new Promise<never>(() => undefined);
  const runtime = new FingertipRuntime({
    bundleResolver: {
      async resolve() {
        return {
          bundlePath: "/validated/ChatGPT.app",
          binaryPath: "/validated/codex",
          appVersion: "1",
          appBuild: "2",
          codexVersion: "codex 3",
          fingerprint: "bundle-a",
        };
      },
    } as ChatGptBundleResolver,
    desktopIpc,
    catalogClientFactory: () => {
      const number = ++clientNumber;
      return {
        async start() {},
        async listThreads() {
          listCalls.push(number);
          return number === 1 ? firstQuery : { data: [], nextCursor: null };
        },
        async stop() {},
      };
    },
    readWorkspaceMetadata: async () => projectWorkspaceMetadata({}),
    navigation: { async openTask() { return true; } } as unknown as ChatGptNavigationPort,
    propertyInspector: { async send() {} },
  });
  runtime.attachAction(
    { id: "one", async setImage() {}, async showAlert() {} },
    normalizeTaskKeySettings(undefined),
  );
  for (let iteration = 0; iteration < 5; iteration += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(listCalls, [1]);

  runtime.systemDidWake();
  for (let iteration = 0; iteration < 5; iteration += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(listCalls, [1, 2]);
  runtime.shutdown();
});
