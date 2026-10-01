import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("custom sidebar sections precede remaining projects and preserve pins and project Thread order", () => {
  const fixture: unknown = JSON.parse(readFileSync(new URL("../fixtures/sidebar-custom-sections.json", import.meta.url), "utf8"));
  const metadata = projectWorkspaceMetadata(fixture);
  const normal = "00000000-0000-4000-8000-000000000101";
  const pinned = "00000000-0000-4000-8000-000000000102";
  const currentOld = "00000000-0000-4000-8000-000000000103";
  const currentNew = "00000000-0000-4000-8000-000000000104";
  const movedThread = "00000000-0000-4000-8000-000000000105";
  const secondary = "00000000-0000-4000-8000-000000000106";
  const pinnedProject = "00000000-0000-4000-8000-000000000107";
  const projectless = "00000000-0000-4000-8000-000000000108";
  const tasks = projectThreadListResult({
    data: [
      task(normal, "/work/normal", 800),
      task(currentNew, "/work/current", 700),
      task(secondary, "/work/secondary", 600),
      task(movedThread, "/work/normal", 500),
      task(currentOld, "/work/current", 400),
      task(pinnedProject, "/work/pinned", 300),
      task(projectless, "/scratch", 200),
      task(pinned, "/scratch", 100),
    ],
    nextCursor: null,
  }).tasks;

  assert.deepEqual(rankTasksLikeSidebar(tasks, metadata, new Map()).map(({ id }) => id), [
    pinned, pinnedProject, currentOld, currentNew, movedThread, secondary, normal, projectless,
  ]);
});

test("an explicit built-in section position and section moves apply on the next metadata projection", () => {
  const current = "00000000-0000-4000-8000-000000000111";
  const normal = "00000000-0000-4000-8000-000000000112";
  const tasks = projectThreadListResult({
    data: [task(current, "/work/current", 200), task(normal, "/work/normal", 100)],
    nextCursor: null,
  }).tasks;
  const metadata = (sectionOrder: readonly string[]) => projectWorkspaceMetadata({
    "local-projects": {
      current: { rootPaths: ["/work/current"] },
      normal: { rootPaths: ["/work/normal"] },
    },
    "project-order": ["normal"],
    "electron-persisted-atom-state": {
      "sidebar-custom-sections-v3": {
        account: { sections: [{ id: "current", itemKeys: ["codex:project:current"] }], sectionOrder },
      },
    },
  });

  assert.deepEqual(rankTasksLikeSidebar(tasks, metadata(["custom:current"]), new Map()).map(({ id }) => id), [current, normal]);
  assert.deepEqual(rankTasksLikeSidebar(tasks, metadata(["projects", "custom:current"]), new Map()).map(({ id }) => id), [normal, current]);
});

test("current unified project and chat order replace the stale legacy order without custom sections", () => {
  const projectAlpha = "00000000-0000-4000-8000-000000000131";
  const projectBeta = "00000000-0000-4000-8000-000000000132";
  const taskAlpha = "00000000-0000-4000-8000-000000000133";
  const taskBeta = "00000000-0000-4000-8000-000000000134";
  const tasks = projectThreadListResult({
    data: [
      task(projectAlpha, "/work/alpha", 400), task(taskAlpha, "/scratch", 300),
      task(projectBeta, "/work/beta", 200), task(taskBeta, "/scratch", 100),
    ],
    nextCursor: null,
  }).tasks;
  const metadata = projectWorkspaceMetadata({
    "local-projects": { alpha: { rootPaths: ["/work/alpha"] }, beta: { rootPaths: ["/work/beta"] } },
    "project-order": ["alpha", "beta"],
    "electron-persisted-atom-state": {
      "codex-sidebar-sort-mode-v1": "manual",
      "codex-sidebar-chat-order-v1": { threadIds: [taskAlpha, taskBeta] },
      "unified-sidebar-project-order-v1": ["codex:project:beta", "codex:project:alpha"],
      "unified-sidebar-chat-order-v1": [`codex:thread:local:${taskBeta}`, `codex:thread:local:${taskAlpha}`],
    },
  });

  assert.deepEqual(rankTasksLikeSidebar(tasks, metadata, new Map()).map(({ id }) => id), [projectBeta, projectAlpha, taskBeta, taskAlpha]);
});
