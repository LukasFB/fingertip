import assert from "node:assert/strict";
import test from "node:test";

import { createKeySnapshot } from "../../src/runtime/key-snapshot.ts";
import { TaskKeyRegistry } from "../../src/runtime/task-key-registry.ts";
import { DEFAULT_TASK_KEY_APPEARANCE, normalizeTaskKeySettings } from "../../src/settings/task-key-settings.ts";

test("an approval-blocked key keeps the exact displayed Task as its press target", async () => {
  const navigated: string[] = [];
  let alerts = 0;
  const registry = new TaskKeyRegistry();
  registry.upsert({
    id: "action-1",
    async setImage() {},
    async showAlert() { alerts += 1; },
  }, normalizeTaskKeySettings(undefined));
  registry.render((settings) => createKeySnapshot({
    settings,
    appearance: DEFAULT_TASK_KEY_APPEARANCE,
    now: 1_000,
    catalog: {
      state: "fresh",
      feed: [{ id: "00000000-0000-4000-8000-000000000001", createdAt: 1, activityAt: 1, title: "Task", source: "pinned-projects" }],
    },
    desktopState: "online",
    liveByTaskId: new Map([[
      "00000000-0000-4000-8000-000000000001",
      { freshness: "fresh", status: "confirmation" },
    ]]),
  }));
  await registry.get("action-1")?.queue.whenIdle();
  const displayed = registry.get("action-1")?.queue.displayedSnapshot;
  if (displayed?.kind !== "task") assert.fail("expected a displayed Task");
  assert.equal(displayed.status, "confirmation");
  assert.equal(
    displayed.pressTarget,
    "codex://threads/00000000-0000-4000-8000-000000000001",
  );

  const activatedTaskId = await registry.press("action-1", {
    async openTask(taskId) { navigated.push(taskId); return true; },
  });

  assert.equal(activatedTaskId, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(navigated, ["00000000-0000-4000-8000-000000000001"]);
  assert.equal(alerts, 0);
});

test("an unoccupied or failed key press alerts and never auto-retries navigation", async () => {
  let launches = 0;
  let alerts = 0;
  const registry = new TaskKeyRegistry();
  registry.upsert(
    { id: "action-1", async setImage() {}, async showAlert() { alerts += 1; } },
    normalizeTaskKeySettings(undefined),
  );
  const navigation = { async openTask() { launches += 1; return false; } };

  assert.equal(await registry.press("action-1", navigation), null);
  assert.equal(launches, 0);
  assert.equal(alerts, 1);
});

test("navigation failure retains the displayed snapshot and retries only on the next press", async () => {
  let launches = 0;
  let alerts = 0;
  const registry = new TaskKeyRegistry();
  registry.upsert(
    { id: "action-1", async setImage() {}, async showAlert() { alerts += 1; } },
    normalizeTaskKeySettings(undefined),
  );
  registry.render((settings) => createKeySnapshot({
    settings,
    appearance: DEFAULT_TASK_KEY_APPEARANCE,
    now: 1_000,
    catalog: { state: "fresh", feed: [{
      id: "00000000-0000-4000-8000-000000000001", createdAt: 1, activityAt: 1, title: "Displayed", source: "pinned-projects",
    }] },
    desktopState: "online",
    liveByTaskId: new Map(),
  }));
  const entry = registry.get("action-1");
  await entry?.queue.whenIdle();
  const displayed = entry?.queue.displayedSnapshot;
  const navigation = { async openTask() { launches += 1; return false; } };

  assert.equal(await registry.press("action-1", navigation), null);
  assert.equal(entry?.queue.displayedSnapshot, displayed);
  assert.equal(launches, 1);
  assert.equal(await registry.press("action-1", navigation), null);
  assert.equal(launches, 2);
  assert.equal(alerts, 2);
});
