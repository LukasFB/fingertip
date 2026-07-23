import assert from "node:assert/strict";
import test from "node:test";

import { projectWorkspaceMetadata } from "../../src/catalog/project-label-resolver.ts";
import { buildTaskFeed, taskAtPosition } from "../../src/catalog/task-feed.ts";

test("Task Feed preserves catalog order, resolves labels, and uses one-based positions", () => {
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/Projects/fingertip"],
    "electron-workspace-root-labels": { "/Projects/fingertip": "Fingertip" },
  });
  const feed = buildTaskFeed([
    {
      id: "00000000-0000-4000-8000-000000000010",
      createdAt: 10,
      recencyAt: 25,
      title: "Newest",
      cwd: "/Projects/fingertip",
    },
    {
      id: "00000000-0000-4000-8000-000000000009",
      createdAt: 9,
      title: "Older",
      cwd: "/Other",
    },
  ], metadata);

  assert.deepEqual(taskAtPosition(feed, 1), {
    id: "00000000-0000-4000-8000-000000000010",
    createdAt: 10,
    activityAt: 25,
    title: "Newest",
    source: "pinned-projects",
    projectLabel: "Fingertip",
  });
  assert.deepEqual(taskAtPosition(feed, 2), {
    id: "00000000-0000-4000-8000-000000000009",
    createdAt: 9,
    activityAt: 9,
    title: "Older",
    source: "tasks",
  });
  assert.equal(taskAtPosition(feed, 3), null);
  assert.equal(taskAtPosition(feed, 1, "pinned-projects")?.title, "Newest");
  assert.equal(taskAtPosition(feed, 1, "tasks")?.title, "Older");
});

test("Pinned projectless Tasks share one source with project Tasks while regular Tasks index independently", () => {
  const pinnedId = "00000000-0000-4000-8000-000000000021";
  const projectId = "00000000-0000-4000-8000-000000000022";
  const taskId = "00000000-0000-4000-8000-000000000023";
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/Projects/fingertip"],
    "pinned-thread-ids": [pinnedId],
    "projectless-thread-ids": [pinnedId, taskId],
  });
  const feed = buildTaskFeed([
    { id: pinnedId, createdAt: 30, title: "Pinned", cwd: "/Other" },
    { id: projectId, createdAt: 20, title: "Project", cwd: "/Projects/fingertip" },
    { id: taskId, createdAt: 10, title: "Standalone", cwd: "/Other" },
  ], metadata);

  assert.deepEqual(feed.map(({ title, source }) => [title, source]), [
    ["Pinned", "pinned-projects"],
    ["Project", "pinned-projects"],
    ["Standalone", "tasks"],
  ]);
  assert.equal(taskAtPosition(feed, 2, "pinned-projects")?.title, "Project");
  assert.equal(taskAtPosition(feed, 1, "tasks")?.title, "Standalone");
});

test("new Tasks shift ranks, removals shift forward, duplicate positions match, and position 99 is bounded", () => {
  const metadata = projectWorkspaceMetadata({});
  const raw = Array.from({ length: 99 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: 99 - index,
    title: `Task ${index + 1}`,
    cwd: "/Unresolved",
  }));
  const initial = buildTaskFeed(raw, metadata);
  const inserted = buildTaskFeed([{
    id: "10000000-0000-4000-8000-000000000000",
    createdAt: 100,
    title: "New Task",
    cwd: "/Unresolved",
  }, ...raw], metadata);
  const removed = buildTaskFeed(raw.slice(1), metadata);

  assert.equal(taskAtPosition(initial, 1)?.title, "Task 1");
  assert.equal(taskAtPosition(inserted, 1)?.title, "New Task");
  assert.equal(taskAtPosition(inserted, 2)?.id, taskAtPosition(initial, 1)?.id);
  assert.equal(taskAtPosition(removed, 1)?.id, taskAtPosition(initial, 2)?.id);
  assert.equal(taskAtPosition(initial, 5), taskAtPosition(initial, 5));
  assert.equal(taskAtPosition(initial, 99)?.title, "Task 99");
  assert.equal(taskAtPosition(initial, 100), null);
});
