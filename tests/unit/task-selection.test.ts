import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskId } from "../../src/catalog/catalog-projection.ts";
import { taskAtPositionForKey } from "../../src/runtime/task-selection.ts";
import { normalizeTaskKeySettings } from "../../src/settings/task-key-settings.ts";

const pinnedId = parseTaskId("00000000-0000-4000-8000-000000000001");
const settledId = parseTaskId("00000000-0000-4000-8000-000000000002");
const workingId = parseTaskId("00000000-0000-4000-8000-000000000003");
const projectlessId = parseTaskId("00000000-0000-4000-8000-000000000004");
const unreadId = parseTaskId("00000000-0000-4000-8000-000000000005");
const activeProjectlessId = parseTaskId("00000000-0000-4000-8000-000000000006");

const feed = [
  { id: pinnedId, createdAt: 1, activityAt: 1, title: "Pinned", source: "pinned-projects" as const, pinned: true as const },
  { id: settledId, createdAt: 1, activityAt: 1, title: "Settled project", source: "pinned-projects" as const },
  { id: unreadId, createdAt: 1, activityAt: 1, title: "Unread project", source: "pinned-projects" as const },
  { id: workingId, createdAt: 1, activityAt: 1, title: "Working project", source: "pinned-projects" as const },
  { id: projectlessId, createdAt: 1, activityAt: 1, title: "Projectless", source: "tasks" as const },
  { id: activeProjectlessId, createdAt: 1, activityAt: 1, title: "Active projectless", source: "tasks" as const },
];

const context = {
  catalogState: "fresh" as const,
  desktopState: "online" as const,
  liveByTaskId: new Map([
    [pinnedId, { freshness: "fresh" as const, status: "idle" as const }],
    [settledId, { freshness: "fresh" as const, status: "idle" as const }],
    [workingId, { freshness: "fresh" as const, status: "working" as const }],
    [unreadId, { freshness: "fresh" as const, status: "done" as const }],
    [projectlessId, { freshness: "fresh" as const, status: "idle" as const }],
    [activeProjectlessId, { freshness: "fresh" as const, status: "working" as const }],
  ]),
};

test("active and unread project Threads move ahead of idle Threads while pinned positions stay unchanged", () => {
  const settings = normalizeTaskKeySettings({
    taskSource: "pinned-projects",
    moveActiveUnreadThreadsToTop: true,
    taskPosition: 1,
  });

  assert.equal(taskAtPositionForKey(feed, settings, context)?.title, "Pinned");
  assert.equal(taskAtPositionForKey(feed, { ...settings, taskPosition: 2 }, context)?.title, "Unread project");
  assert.equal(taskAtPositionForKey(feed, { ...settings, taskPosition: 3 }, context)?.title, "Working project");
  assert.equal(taskAtPositionForKey(feed, { ...settings, taskPosition: 4 }, context)?.title, "Settled project");
});

test("active projectless Threads move ahead of idle projectless Threads", () => {
  const tasksSettings = normalizeTaskKeySettings({ taskSource: "tasks", moveActiveUnreadThreadsToTop: true });
  assert.equal(taskAtPositionForKey(feed, tasksSettings, context)?.title, "Active projectless");
  assert.equal(taskAtPositionForKey(feed, { ...tasksSettings, taskPosition: 2 }, context)?.title, "Projectless");

  const defaultSettings = normalizeTaskKeySettings({ taskSource: "pinned-projects" });
  assert.equal(taskAtPositionForKey(feed, { ...defaultSettings, taskPosition: 2 }, context)?.title, "Settled project");
});

test("pinned Threads retain their original slot while project Threads are reordered around them", () => {
  const middlePinnedFeed = [
    feed[1]!,
    feed[0]!,
    feed[2]!,
  ];
  const settings = normalizeTaskKeySettings({
    taskSource: "pinned-projects",
    moveActiveUnreadThreadsToTop: true,
    taskPosition: 1,
  });

  assert.equal(taskAtPositionForKey(middlePinnedFeed, settings, context)?.title, "Unread project");
  assert.equal(taskAtPositionForKey(middlePinnedFeed, { ...settings, taskPosition: 2 }, context)?.title, "Pinned");
  assert.equal(taskAtPositionForKey(middlePinnedFeed, { ...settings, taskPosition: 3 }, context)?.title, "Settled project");
});

test("stale working project Threads move with idle Threads while unread Threads remain prioritized", () => {
  const settings = normalizeTaskKeySettings({ taskSource: "pinned-projects", moveActiveUnreadThreadsToTop: true });
  const staleContext = {
    ...context,
    liveByTaskId: new Map([
      [settledId, { freshness: "stale" as const, status: "working" as const }],
      [workingId, { freshness: "fresh" as const, status: "done" as const }],
      [unreadId, { freshness: "fresh" as const, status: "done" as const }],
    ]),
  };

  assert.equal(taskAtPositionForKey(feed, settings, staleContext)?.title, "Pinned");
  assert.equal(taskAtPositionForKey(feed, { ...settings, taskPosition: 2 }, staleContext)?.title, "Unread project");
  assert.equal(taskAtPositionForKey(feed, { ...settings, taskPosition: 3 }, staleContext)?.title, "Working project");
});
