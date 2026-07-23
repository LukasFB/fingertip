import assert from "node:assert/strict";
import test from "node:test";

import { projectThreadListResult } from "../../src/catalog/catalog-projection.ts";
import { projectWorkspaceMetadata } from "../../src/catalog/project-label-resolver.ts";
import { rankTasksLikeSidebar } from "../../src/catalog/sidebar-task-ranker.ts";

const task = (
  id: string,
  cwd: string,
  recencyAt: number,
  name = id,
): Record<string, unknown> => ({
  id,
  cwd,
  name,
  createdAt: recencyAt - 20,
  updatedAt: recencyAt - 10,
  recencyAt,
  parentThreadId: null,
  ephemeral: false,
});

test("Sidebar ranking flattens pinned Tasks, ordered projects, and projectless Tasks", () => {
  const pinned = "00000000-0000-4000-8000-000000000001";
  const alphaOld = "00000000-0000-4000-8000-000000000002";
  const alphaNew = "00000000-0000-4000-8000-000000000003";
  const beta = "00000000-0000-4000-8000-000000000004";
  const projectless = "00000000-0000-4000-8000-000000000005";
  const tasks = projectThreadListResult({
    data: [
      task(alphaNew, "/work/alpha", 500),
      task(projectless, "/scratch", 450),
      task(beta, "/work/beta", 400),
      task(alphaOld, "/work/alpha", 300),
      task(pinned, "/scratch", 100),
    ],
    nextCursor: null,
  }).tasks;
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/work/beta", "/work/alpha"],
    "project-order": ["/work/alpha", "/work/beta"],
    "pinned-thread-ids": [pinned],
    "projectless-thread-ids": [projectless, pinned],
    "sidebar-project-thread-orders": {
      "/work/alpha": { threadIds: [alphaOld, alphaNew] },
    },
    "electron-persisted-atom-state": {
      "flat-project-sidebar-preferences-v1": {
        mode: "project",
        projectSortMode: "manual",
      },
      "codex-sidebar-sort-mode-v1": "manual",
    },
  });

  assert.deepEqual(
    rankTasksLikeSidebar(tasks, metadata, new Map()).map(({ id }) => id),
    [pinned, alphaOld, alphaNew, beta, projectless],
  );
});

test("Tasks in pinned projects follow pinned Tasks and precede normal projects", () => {
  const pinnedTask = "00000000-0000-4000-8000-000000000031";
  const pinnedProjectTask = "00000000-0000-4000-8000-000000000032";
  const normalTask = "00000000-0000-4000-8000-000000000033";
  const tasks = projectThreadListResult({
    data: [
      task(normalTask, "/work/normal", 300),
      task(pinnedProjectTask, "/work/pinned", 200),
      task(pinnedTask, "/scratch", 100),
    ],
    nextCursor: null,
  }).tasks;
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/work/normal", "/work/pinned"],
    "pinned-thread-ids": [pinnedTask],
    "pinned-project-ids": ["/work/pinned"],
    "projectless-thread-ids": [pinnedTask],
  });

  assert.deepEqual(
    rankTasksLikeSidebar(tasks, metadata, new Map()).map(({ id }) => id),
    [pinnedTask, pinnedProjectTask, normalTask],
  );
});

test("stored project order overlays project recency in priority mode like the ChatGPT sidebar", () => {
  const fingertip = "00000000-0000-4000-8000-000000000051";
  const rental = "00000000-0000-4000-8000-000000000052";
  const tasks = projectThreadListResult({
    data: [
      task(fingertip, "/work/fingertip", 500),
      task(rental, "/work/rental", 400),
    ],
    nextCursor: null,
  }).tasks;
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/work/rental", "/work/fingertip"],
    "project-order": ["/work/rental", "/work/fingertip"],
    "electron-persisted-atom-state": {
      "flat-project-sidebar-preferences-v1": {
        mode: "project",
        projectSortMode: "priority",
      },
      "codex-sidebar-sort-mode-v1": "manual",
    },
  });

  assert.deepEqual(
    rankTasksLikeSidebar(tasks, metadata, new Map()).map(({ id }) => id),
    [rental, fingertip],
  );
});

test("projects absent from the stored order precede configured projects by recency", () => {
  const newest = "00000000-0000-4000-8000-000000000071";
  const fingertip = "00000000-0000-4000-8000-000000000072";
  const rental = "00000000-0000-4000-8000-000000000073";
  const tasks = projectThreadListResult({
    data: [
      task(fingertip, "/work/fingertip", 500),
      task(rental, "/work/rental", 400),
      task(newest, "/work/new", 600),
    ],
    nextCursor: null,
  }).tasks;
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/work/new", "/work/fingertip", "/work/rental"],
    "project-order": ["/work/rental"],
    "electron-persisted-atom-state": {
      "flat-project-sidebar-preferences-v1": {
        mode: "project",
        projectSortMode: "priority",
      },
    },
  });

  assert.deepEqual(
    rankTasksLikeSidebar(tasks, metadata, new Map()).map(({ id }) => id),
    [newest, fingertip, rental],
  );
});

test("manual project order remains independent from manual Task order inside each project", () => {
  const alphaNew = "00000000-0000-4000-8000-000000000061";
  const alphaOld = "00000000-0000-4000-8000-000000000062";
  const beta = "00000000-0000-4000-8000-000000000063";
  const tasks = projectThreadListResult({
    data: [
      task(alphaNew, "/work/alpha", 500),
      task(beta, "/work/beta", 400),
      task(alphaOld, "/work/alpha", 300),
    ],
    nextCursor: null,
  }).tasks;
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/work/alpha", "/work/beta"],
    "project-order": ["/work/beta", "/work/alpha"],
    "sidebar-project-thread-orders": {
      "/work/alpha": { threadIds: [alphaOld, alphaNew] },
    },
    "electron-persisted-atom-state": {
      "flat-project-sidebar-preferences-v1": {
        mode: "project",
        projectSortMode: "manual",
      },
      "codex-sidebar-sort-mode-v1": "manual",
    },
  });

  assert.deepEqual(
    rankTasksLikeSidebar(tasks, metadata, new Map()).map(({ id }) => id),
    [beta, alphaOld, alphaNew],
  );
});

test("priority mode follows ChatGPT waiting, unread, active, idle precedence then recency", () => {
  const waiting = "00000000-0000-4000-8000-000000000011";
  const done = "00000000-0000-4000-8000-000000000012";
  const working = "00000000-0000-4000-8000-000000000013";
  const idleNew = "00000000-0000-4000-8000-000000000014";
  const idleOld = "00000000-0000-4000-8000-000000000015";
  const tasks = projectThreadListResult({
    data: [
      task(idleNew, "/work/alpha", 500),
      task(working, "/work/alpha", 400),
      task(done, "/work/alpha", 300),
      task(waiting, "/work/alpha", 200),
      task(idleOld, "/work/alpha", 100),
    ],
    nextCursor: null,
  }).tasks;
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/work/alpha"],
    "electron-persisted-atom-state": {
      "flat-project-sidebar-preferences-v1": { mode: "project", projectSortMode: "priority" },
    },
  });
  const statuses = new Map([
    [waiting, "confirmation"],
    [done, "done"],
    [working, "working"],
    [idleNew, "idle"],
    [idleOld, "idle"],
  ] as const);

  assert.deepEqual(
    rankTasksLikeSidebar(tasks, metadata, statuses).map(({ id }) => id),
    [waiting, done, working, idleNew, idleOld],
  );
});

test("manual mode ignores a transient prior sort key and applies stored Task IDs", () => {
  const older = "00000000-0000-4000-8000-000000000041";
  const newer = "00000000-0000-4000-8000-000000000042";
  const tasks = projectThreadListResult({
    data: [task(newer, "/work/alpha", 500), task(older, "/work/alpha", 100)],
    nextCursor: null,
  }).tasks;
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/work/alpha"],
    "sidebar-project-thread-orders": {
      "/work/alpha": { threadIds: [older, newer], sortKey: "updated_at" },
    },
    "electron-persisted-atom-state": { "codex-sidebar-sort-mode-v1": "manual" },
  });

  assert.deepEqual(
    rankTasksLikeSidebar(tasks, metadata, new Map()).map(({ id }) => id),
    [older, newer],
  );
});

test("invalid sidebar state fails the metadata projection atomically", () => {
  assert.throws(() => projectWorkspaceMetadata({ "pinned-thread-ids": ["not-a-task-id"] }));
  assert.throws(() => projectWorkspaceMetadata({
    "sidebar-project-thread-orders": { "/work/alpha": { threadIds: "wrong" } },
  }));
});
