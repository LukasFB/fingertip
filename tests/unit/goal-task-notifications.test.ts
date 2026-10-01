import assert from "node:assert/strict";
import test from "node:test";

import { AppServerRequestError } from "../../src/catalog/app-server-catalog-client.ts";
import { parseTaskId, type TaskId } from "../../src/catalog/catalog-projection.ts";
import { projectWorkspaceMetadata } from "../../src/catalog/project-label-resolver.ts";
import type { ChatGptBundleResolver } from "../../src/chatgpt/chatgpt-bundle-resolver.ts";
import type {
  ChatGptDesktopIpcAdapter,
  LiveTaskRecord,
} from "../../src/desktop-ipc/chatgpt-desktop-ipc-adapter.ts";
import type { TaskNotification } from "../../src/notifications/mac-task-notifier.ts";
import { FingertipRuntime } from "../../src/runtime/fingertip-runtime.ts";
import {
  normalizeTaskKeySettings,
  type TaskNotificationMode,
} from "../../src/settings/task-key-settings.ts";

const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
const hiddenTaskId = parseTaskId("00000000-0000-4000-8000-000000000002");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushRuntime(): Promise<void> {
  for (let iteration = 0; iteration < 5; iteration += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function notificationHarness(options: {
  readonly mode?: TaskNotificationMode;
  readonly showGoalBadge?: boolean;
  readonly readGoal?: () => Promise<unknown>;
  readonly omitGoalReader?: boolean;
  readonly sortMode?: "priority" | "updated_at";
  readonly taskPosition?: number;
} = {}) {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const goalReads: string[] = [];
  const notifications: TaskNotification[] = [];
  const images: string[] = [];
  let readGoal = options.readGoal ?? (async () => ({ goal: null }));
  let taskRecordListener: ((record: LiveTaskRecord) => void) | null = null;
  let revision = 0;
  const action = { id: "one", async setImage(image: string) { images.push(image); }, async showAlert() {} };
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
      onTaskRecord(listener: (record: LiveTaskRecord) => void) {
        taskRecordListener = listener;
        return () => undefined;
      },
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
          data: [taskId, hiddenTaskId].map((id, index) => ({
            id,
            name: index === 0 ? "Goal Task" : "Hidden Task",
            cwd: "/work/project",
            createdAt: 2 - index,
            updatedAt: 2 - index,
            recencyAt: 2 - index,
            ephemeral: false,
            parentThreadId: null,
          })),
          nextCursor: null,
        };
      },
      ...(!options.omitGoalReader ? {
        readThreadGoal(input: { readonly threadId: string }) {
          goalReads.push(input.threadId);
          return readGoal();
        },
      } : {}),
    }),
    readWorkspaceMetadata: async () => projectWorkspaceMetadata({
      "electron-persisted-atom-state": { "codex-sidebar-sort-mode-v1": options.sortMode ?? "updated_at" },
    }),
    watchWorkspaceMetadata: () => () => undefined,
    propertyInspector: { async send() {} },
    notifier: {
      notify(notification) { notifications.push(notification); },
      async importCustomSound() { return false; },
      async customSoundAvailable() { return false; },
    },
    setTimer: ((callback: () => void, delay = 0) => {
      timers.push({ callback, delay, cleared: false });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: ((timer: ReturnType<typeof setTimeout>) => {
      const entry = timers[Number(timer) - 1];
      if (entry !== undefined) entry.cleared = true;
    }) as typeof clearTimeout,
  });
  runtime.updateAppearance({
    doneNotification: options.mode ?? "both",
    confirmationNotification: "sound",
    showGoalBadge: options.showGoalBadge ?? false,
  });
  return {
    runtime,
    goalReads,
    notifications,
    images,
    async start() {
      runtime.attachAction(action, normalizeTaskKeySettings({
        taskSource: "tasks", taskPosition: options.taskPosition ?? 1,
      }));
      await flushRuntime();
    },
    setGoalReader(reader: () => Promise<unknown>) { readGoal = reader; },
    showOtherTask() {
      runtime.updateSettings(action, normalizeTaskKeySettings({ taskSource: "tasks", taskPosition: 2 }));
    },
    emit(
      status: LiveTaskRecord["status"],
      freshness: LiveTaskRecord["freshness"] = "fresh",
      id: TaskId = taskId,
    ) {
      assert.ok(taskRecordListener);
      taskRecordListener({
        taskId: id,
        ownerClientId: "owner",
        revision: ++revision,
        facts: {
          isActive: status === "working",
          waitingOnApproval: status === "confirmation",
          waitingOnUserInput: status === "waiting",
          hasUnreadTurn: status === "done",
        },
        status,
        freshness,
      });
    },
  };
}

test("an active Goal suppresses every Done notification mode with the Goal badge hidden", async (t) => {
  for (const mode of ["sound", "toast", "both"] as const) {
    await t.test(mode, async (t) => {
      const harness = notificationHarness({ mode, readGoal: async () => ({ goal: { status: "active" } }) });
      t.after(() => harness.runtime.shutdown());
      await harness.start();
      assert.deepEqual(harness.goalReads, []);

      for (let turn = 0; turn < 2; turn += 1) {
        harness.emit("working");
        harness.emit("done");
        await flushRuntime();
      }

      assert.deepEqual(harness.goalReads, [taskId, taskId]);
      assert.deepEqual(harness.notifications, []);
    });
  }
});

test("a finished turn can notify when its Goal is absent or no longer active", async (t) => {
  for (const status of [null, "complete", "paused", "blocked", "budgetLimited", "usageLimited"]) {
    await t.test(status ?? "no Goal", async (t) => {
      const harness = notificationHarness({
        readGoal: async () => ({ goal: status === null ? null : { status } }),
      });
      t.after(() => harness.runtime.shutdown());
      await harness.start();
      harness.emit("working");
      harness.emit("done");
      await flushRuntime();

      assert.deepEqual(harness.goalReads, [taskId]);
      assert.deepEqual(harness.notifications.map(({ status, mode, taskTitle }) => ({ status, mode, taskTitle })), [
        { status: "done", mode: "both", taskTitle: "Goal Task" },
      ]);
    });
  }
});

test("each Done transition checks fresh Goal state despite the cached Goal badge", async (t) => {
  const harness = notificationHarness({ showGoalBadge: true, readGoal: async () => ({ goal: { status: "complete" } }) });
  t.after(() => harness.runtime.shutdown());
  await harness.start();
  assert.deepEqual(harness.goalReads, [taskId]);
  harness.setGoalReader(async () => ({ goal: { status: "active" } }));
  harness.emit("working");
  harness.emit("done");
  await flushRuntime();
  assert.deepEqual(harness.goalReads, [taskId, taskId]);
  assert.deepEqual(harness.notifications, []);

  harness.setGoalReader(async () => ({ goal: { status: "complete" } }));
  harness.emit("working");
  harness.emit("done");
  await flushRuntime();
  assert.deepEqual(harness.goalReads, [taskId, taskId, taskId]);
  assert.equal(harness.notifications.length, 1);
});

test("approval notifications remain immediate and do not query the Goal", async (t) => {
  const harness = notificationHarness({ readGoal: () => new Promise<never>(() => undefined) });
  t.after(() => harness.runtime.shutdown());
  await harness.start();
  harness.emit("working");
  harness.emit("confirmation");

  assert.deepEqual(harness.goalReads, []);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.status, "confirmation");
  assert.equal(harness.notifications[0]?.mode, "sound");
});

test("hydration, duplicate, stale, hidden and disabled Done records do not query Goals", async (t) => {
  const cases: {
    readonly name: string;
    readonly mode?: TaskNotificationMode;
    readonly records: readonly [LiveTaskRecord["status"], LiveTaskRecord["freshness"]?][];
    readonly id?: TaskId;
  }[] = [
    { name: "hydration and duplicate", records: [["done"], ["done"]] },
    { name: "stale previous", records: [["working", "stale"], ["done"]] },
    { name: "stale current", records: [["working"], ["done", "stale"]] },
    { name: "hidden task", records: [["working"], ["done"]], id: hiddenTaskId },
    { name: "disabled", records: [["working"], ["done"]], mode: "off" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const harness = notificationHarness({ mode: scenario.mode ?? "both" });
      t.after(() => harness.runtime.shutdown());
      await harness.start();
      for (const [status, freshness] of scenario.records) harness.emit(status, freshness, scenario.id);
      await flushRuntime();
      assert.deepEqual(harness.goalReads, []);
      assert.deepEqual(harness.notifications, []);
    });
  }
});

test("a delayed Done notification is discarded after the task changes state or becomes stale", async (t) => {
  for (const status of ["working", "waiting", "confirmation", "stale"] as const) {
    await t.test(status, async (t) => {
      const pending = deferred<unknown>();
      const harness = notificationHarness({ readGoal: () => pending.promise });
      t.after(() => harness.runtime.shutdown());
      await harness.start();
      harness.emit("working");
      harness.emit("done");
      assert.deepEqual(harness.goalReads, [taskId]);
      assert.deepEqual(harness.notifications, []);
      harness.emit(status === "stale" ? "done" : status, status === "stale" ? "stale" : "fresh");
      pending.resolve({ goal: null });
      await flushRuntime();

      assert.deepEqual(harness.notifications.map(({ status }) => status), status === "confirmation" ? ["confirmation"] : []);
    });
  }
});

test("a delayed Done notification is discarded after hiding the task, disabling notifications or changing runtime generation", async (t) => {
  const cases: { readonly name: string; readonly invalidate: (harness: ReturnType<typeof notificationHarness>) => void }[] = [
    { name: "key detached", invalidate: ({ runtime }) => runtime.detachAction("one") },
    { name: "key selects another task", invalidate: (harness) => harness.showOtherTask() },
    { name: "notifications disabled", invalidate: ({ runtime }) => runtime.updateAppearance({ doneNotification: "off" }) },
    { name: "shutdown", invalidate: ({ runtime }) => runtime.shutdown() },
    { name: "restart", invalidate: ({ runtime }) => runtime.systemDidWake() },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const pending = deferred<unknown>();
      const harness = notificationHarness({ readGoal: () => pending.promise });
      t.after(() => harness.runtime.shutdown());
      await harness.start();
      harness.emit("working");
      harness.emit("done");
      assert.deepEqual(harness.goalReads, [taskId]);
      assert.deepEqual(harness.notifications, []);
      scenario.invalidate(harness);
      await flushRuntime();
      pending.resolve({ goal: null });
      await flushRuntime();

      assert.deepEqual(harness.notifications, []);
    });
  }
});

test("duplicate fresh Done revisions preserve one pending notification", async (t) => {
  const pending = deferred<unknown>();
  const harness = notificationHarness({ readGoal: () => pending.promise });
  t.after(() => harness.runtime.shutdown());
  await harness.start();
  harness.emit("working");
  harness.emit("done");
  harness.emit("done");
  assert.deepEqual(harness.goalReads, [taskId]);
  assert.equal(harness.notifications.length, 0);
  pending.resolve({ goal: null });
  await flushRuntime();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.status, "done");
});

test("an older Goal response cannot notify for a later completed turn", async (t) => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const harness = notificationHarness({ readGoal: () => first.promise });
  t.after(() => harness.runtime.shutdown());
  await harness.start();
  harness.emit("working");
  harness.emit("done");
  harness.setGoalReader(() => second.promise);
  harness.emit("working");
  harness.emit("done");
  assert.deepEqual(harness.goalReads, [taskId, taskId]);
  first.resolve({ goal: null });
  await flushRuntime();
  assert.deepEqual(harness.notifications, []);
  second.resolve({ goal: null });
  await flushRuntime();
  assert.equal(harness.notifications.length, 1);
});

test("an unavailable Goal query suppresses the Done notification", async (t) => {
  const harness = notificationHarness({ readGoal: async () => { throw new Error("Goal query unavailable"); } });
  t.after(() => harness.runtime.shutdown());
  await harness.start();
  harness.emit("working");
  harness.emit("done");
  await flushRuntime();

  assert.deepEqual(harness.goalReads, [taskId]);
  assert.deepEqual(harness.notifications, []);
});

test("catalog clients without the optional Goal reader retain Done notifications", async (t) => {
  const harness = notificationHarness({ omitGoalReader: true });
  t.after(() => harness.runtime.shutdown());
  await harness.start();
  harness.emit("working");
  harness.emit("done");
  await flushRuntime();

  assert.deepEqual(harness.goalReads, []);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.status, "done");
});

test("an unsupported Goal RPC retains Done notifications for older App Servers", async (t) => {
  const harness = notificationHarness({ readGoal: async () => { throw new AppServerRequestError(-32601); } });
  t.after(() => harness.runtime.shutdown());
  await harness.start();
  harness.emit("working");
  harness.emit("done");
  await flushRuntime();

  assert.deepEqual(harness.goalReads, [taskId]);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.status, "done");
});

test("priority reranking after completion preserves the notification for the task visible at the transition", async (t) => {
  const pending = deferred<unknown>();
  const harness = notificationHarness({
    sortMode: "priority", taskPosition: 2, readGoal: () => pending.promise,
  });
  t.after(() => harness.runtime.shutdown());
  await harness.start();
  harness.emit("done", "fresh", hiddenTaskId);
  harness.emit("working");
  await flushRuntime();
  assert.equal(decodeURIComponent(harness.images.at(-1) ?? "").includes("Goal Task"), true);
  assert.deepEqual(harness.goalReads, []);

  harness.emit("done");
  await flushRuntime();
  assert.deepEqual(harness.goalReads, [taskId]);
  assert.equal(decodeURIComponent(harness.images.at(-1) ?? "").includes("Hidden Task"), true);
  assert.equal(harness.notifications.length, 0);
  pending.resolve({ goal: null });
  await flushRuntime();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.taskTitle, "Goal Task");
});
