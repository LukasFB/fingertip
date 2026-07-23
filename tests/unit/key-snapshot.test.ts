import assert from "node:assert/strict";
import test from "node:test";

import { createKeySnapshot } from "../../src/runtime/key-snapshot.ts";
import { DEFAULT_TASK_KEY_APPEARANCE, normalizeTaskKeySettings } from "../../src/settings/task-key-settings.ts";

const settings = normalizeTaskKeySettings(undefined);
const appearance = DEFAULT_TASK_KEY_APPEARANCE;
const now = 200_000 * 1_000;

test("a Key Snapshot atomically pairs the ranked Task image fields and deep-link target", () => {
  const snapshot = createKeySnapshot({
    settings,
    appearance,
    now,
    catalog: {
      state: "fresh",
      feed: [{
        id: "00000000-0000-4000-8000-000000000100",
        createdAt: 100,
        activityAt: 200_000 - 17 * 60,
        title: "Implement Fingertip",
        source: "pinned-projects",
        projectLabel: "Fingertip",
      }],
    },
    desktopState: "online",
    liveByTaskId: new Map([["00000000-0000-4000-8000-000000000100", {
      freshness: "fresh",
      status: "working",
    }]]),
  });

  assert.deepEqual(snapshot, {
    kind: "task",
    settings,
    appearance,
    taskId: "00000000-0000-4000-8000-000000000100",
    title: "Implement Fingertip",
    projectLabel: "Fingertip",
    status: "working",
    activityLabel: "17 minutes ago",
    liveFreshness: "fresh",
    offlineWarning: false,
    pressTarget: "codex://threads/00000000-0000-4000-8000-000000000100",
    renderSignature: JSON.stringify({
      kind: "task",
      position: 1,
      source: "pinned-projects",
      appearance,
      taskId: "00000000-0000-4000-8000-000000000100",
      title: "Implement Fingertip",
      project: "Fingertip",
      status: "working",
      freshness: "fresh",
      activityLabel: "17 minutes ago",
      offline: false,
    }),
  });
});

test("Key Snapshot rejects catalog states that could confuse cold, failed, and empty feeds", () => {
  const common = {
    settings,
    appearance,
    now,
    desktopState: "offline" as const,
    liveByTaskId: new Map(),
  };
  assert.throws(() => createKeySnapshot({ ...common, catalog: { state: "cold", feed: [] } }));
  assert.throws(() => createKeySnapshot({ ...common, catalog: { state: "unavailable", feed: [] } }));
  assert.throws(() => createKeySnapshot({ ...common, catalog: { state: "fresh", feed: null } }));
  assert.doesNotThrow(() => createKeySnapshot({ ...common, catalog: { state: "incompatible", feed: null } }));
});

test("changing a state color invalidates the render signature", () => {
  const input = {
    catalog: {
      state: "fresh" as const,
      feed: [{
        id: "00000000-0000-4000-8000-000000000100",
        createdAt: 100,
        activityAt: 100,
        title: "Color-aware Task",
        source: "pinned-projects" as const,
      }],
    },
    desktopState: "online" as const,
    liveByTaskId: new Map<string, { freshness: "fresh"; status: "idle" }>([[
      "00000000-0000-4000-8000-000000000100",
      { freshness: "fresh", status: "idle" },
    ]]),
  };
  const defaultSnapshot = createKeySnapshot({ ...input, settings, appearance, now });
  const customizedSnapshot = createKeySnapshot({
    ...input,
    settings,
    appearance: { ...appearance, idleColor: "#123456" },
    now,
  });
  assert.notEqual(defaultSnapshot.renderSignature, customizedSnapshot.renderSignature);
});

test("Task Change Stats replace only the Task footer when the shared option is enabled", () => {
  const taskId = "00000000-0000-4000-8000-000000000100";
  const snapshot = createKeySnapshot({
    settings,
    appearance: { ...appearance, showGitDiffStats: true },
    now,
    catalog: { state: "fresh", feed: [{ id: taskId, createdAt: 100, activityAt: 100, title: "Changed", source: "pinned-projects" }] },
    desktopState: "online",
    liveByTaskId: new Map(),
    taskChangeStatsByTaskId: new Map([[taskId, { added: 12, deleted: 3, files: 2 }]]),
  });

  assert.equal(snapshot.kind, "task");
  if (snapshot.kind !== "task") return;
  assert.deepEqual(snapshot.taskChangeStats, { added: 12, deleted: 3, files: 2 });
  assert.equal(snapshot.activityLabel, "2 days ago");
});

test("Queue and Goal badges are projected from shared appearance", () => {
  const taskId = "00000000-0000-4000-8000-000000000100";
  const input = {
    appearance,
    now,
    catalog: {
      state: "fresh" as const,
      feed: [{ id: taskId, createdAt: 100, activityAt: 100, title: "Badged", source: "pinned-projects" as const }],
    },
    desktopState: "online" as const,
    liveByTaskId: new Map([[taskId, {
      freshness: "fresh" as const,
      status: "working" as const,
      queuedFollowUpCount: 5,
    }]]),
    ongoingGoalByTaskId: new Map([[taskId, true]]),
  };

  const hidden = createKeySnapshot({ ...input, settings });
  const visible = createKeySnapshot({
    ...input,
    appearance: { ...appearance, showQueueBadge: true, showGoalBadge: true },
    settings,
  });
  const moved = createKeySnapshot({
    ...input,
    appearance: {
      ...appearance,
      showQueueBadge: true,
      showGoalBadge: true,
      badgePosition: "bottom-left",
    },
    settings,
  });

  assert.equal(hidden.kind === "task" ? hidden.queuedMessageCount : undefined, undefined);
  assert.equal(hidden.kind === "task" ? hidden.hasOngoingGoal : undefined, undefined);
  assert.equal(visible.kind === "task" ? visible.queuedMessageCount : undefined, 5);
  assert.equal(visible.kind === "task" ? visible.hasOngoingGoal : undefined, true);
  assert.notEqual(hidden.renderSignature, visible.renderSignature);
  assert.notEqual(visible.renderSignature, moved.renderSignature);
});

test("Queue badge falls back to persisted counts until a live IPC count arrives", () => {
  const taskId = "00000000-0000-4000-8000-000000000100";
  const base = {
    settings,
    appearance: { ...appearance, showQueueBadge: true },
    now,
    catalog: {
      state: "fresh" as const,
      feed: [{ id: taskId, createdAt: 100, activityAt: 100, title: "Queued", source: "pinned-projects" as const }],
    },
    desktopState: "online" as const,
    queuedFollowUpCountByTaskId: new Map([[taskId, 3]]),
  };

  const hydrated = createKeySnapshot({ ...base, liveByTaskId: new Map() });
  const live = createKeySnapshot({
    ...base,
    liveByTaskId: new Map([[taskId, {
      freshness: "fresh" as const,
      status: "working" as const,
      queuedFollowUpCount: 5,
    }]]),
  });

  assert.equal(hydrated.kind === "task" ? hydrated.queuedMessageCount : undefined, 3);
  assert.equal(live.kind === "task" ? live.queuedMessageCount : undefined, 5);
});

test("a stale per-Task owner becomes quiet idle while the desktop IPC remains online", () => {
  const snapshot = createKeySnapshot({
    settings,
    appearance,
    now,
    catalog: {
      state: "fresh",
      feed: [{
        id: "00000000-0000-4000-8000-000000000100",
        createdAt: 100,
        activityAt: 100,
        title: "Unloaded Task",
        source: "pinned-projects",
      }],
    },
    desktopState: "online",
    liveByTaskId: new Map([["00000000-0000-4000-8000-000000000100", {
      freshness: "stale" as const,
      status: "working" as const,
    }]]),
  });

  assert.equal(snapshot.kind, "task");
  if (snapshot.kind !== "task") return;
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.offlineWarning, false);
  assert.equal(snapshot.liveFreshness, "stale");
});

test("Task source gives Pinned + Projects and Tasks independent one-based positions", () => {
  const feed = [
    {
      id: "00000000-0000-4000-8000-000000000201",
      createdAt: 20,
      activityAt: 20,
      title: "Project Task",
      source: "pinned-projects" as const,
    },
    {
      id: "00000000-0000-4000-8000-000000000202",
      createdAt: 10,
      activityAt: 10,
      title: "Standalone Task",
      source: "tasks" as const,
    },
  ];
  const taskSnapshot = createKeySnapshot({
    settings: normalizeTaskKeySettings({ taskSource: "tasks", taskPosition: 1 }),
    appearance,
    now,
    catalog: { state: "fresh", feed },
    desktopState: "online",
    liveByTaskId: new Map(),
  });
  const projectSnapshot = createKeySnapshot({
    settings: normalizeTaskKeySettings({ taskSource: "pinned-projects", taskPosition: 1 }),
    appearance,
    now,
    catalog: { state: "fresh", feed },
    desktopState: "online",
    liveByTaskId: new Map(),
  });

  assert.equal(taskSnapshot.kind === "task" ? taskSnapshot.title : null, "Standalone Task");
  assert.equal(projectSnapshot.kind === "task" ? projectSnapshot.title : null, "Project Task");
});
