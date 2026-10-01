import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  projectWorkspaceMetadata,
  resolveProjectLabel,
} from "../../src/catalog/project-label-resolver.ts";
import { projectThreadListResult } from "../../src/catalog/catalog-projection.ts";
import { rankTasksLikeSidebar } from "../../src/catalog/sidebar-task-ranker.ts";

test("project labels follow projectless, hint, longest-root, custom-label precedence", () => {
  const metadata = projectWorkspaceMetadata({
    "projectless-thread-ids": ["00000000-0000-4000-8000-000000000001"],
    "thread-workspace-root-hints": {
      "00000000-0000-4000-8000-000000000002": "/Users/test/Projects/fingertip",
    },
    "electron-saved-workspace-roots": [
      "/Users/test/Projects",
      "/Users/test/Projects/fingertip",
      "/Users/test/Other",
    ],
    "electron-workspace-root-labels": {
      "/Users/test/Projects/fingertip": "Fingertip Plugin",
    },
    unrelated: "PRIVATE_GLOBAL_STATE",
  });

  assert.equal(resolveProjectLabel({
    id: "00000000-0000-4000-8000-000000000001",
    cwd: "/Users/test/Projects/fingertip",
  }, metadata), undefined);
  assert.equal(resolveProjectLabel({
    id: "00000000-0000-4000-8000-000000000002",
    cwd: "/tmp",
  }, metadata), "Fingertip Plugin");
  assert.equal(resolveProjectLabel({
    id: "00000000-0000-4000-8000-000000000003",
    cwd: "/Users/test/Other/subdir",
  }, metadata), "Other");
  assert.equal(resolveProjectLabel({
    id: "00000000-0000-4000-8000-000000000004",
    cwd: "/Unknown/path",
  }, metadata), undefined);
  assert.equal(JSON.stringify(metadata).includes("PRIVATE"), false);
});

test("local project IDs resolve project order, pins, and Task order to their root paths", () => {
  const alphaOld = "00000000-0000-4000-8000-000000000010";
  const alphaNew = "00000000-0000-4000-8000-000000000011";
  const beta = "00000000-0000-4000-8000-000000000012";
  const metadata = projectWorkspaceMetadata({
    "electron-saved-workspace-roots": ["/Projects/alpha", "/Projects/beta"],
    "local-projects": {
      "local-alpha": { id: "local-alpha", rootPaths: ["/Projects/alpha"] },
      "local-beta": { id: "local-beta", rootPaths: ["/Projects/beta"] },
    },
    "pinned-project-ids": ["local-beta"],
    "project-order": ["local-beta", "local-alpha"],
    "sidebar-project-thread-orders": {
      "local-alpha": { threadIds: [alphaOld, alphaNew] },
    },
    "electron-persisted-atom-state": {
      "flat-project-sidebar-preferences-v1": { mode: "project", projectSortMode: "manual" },
      "codex-sidebar-sort-mode-v1": "manual",
    },
  });
  const tasks = projectThreadListResult({
    data: [
      { id: alphaNew, name: "Alpha new", cwd: "/Projects/alpha", createdAt: 30, parentThreadId: null, ephemeral: false },
      { id: beta, name: "Beta", cwd: "/Projects/beta", createdAt: 20, parentThreadId: null, ephemeral: false },
      { id: alphaOld, name: "Alpha old", cwd: "/Projects/alpha", createdAt: 10, parentThreadId: null, ephemeral: false },
    ],
    nextCursor: null,
  }).tasks;

  assert.deepEqual(metadata.pinnedProjectIds, ["/Projects/beta"]);
  assert.deepEqual(metadata.projectOrder, ["/Projects/beta", "/Projects/alpha"]);
  assert.deepEqual(metadata.projectThreadOrders.get("/Projects/alpha")?.threadIds, [alphaOld, alphaNew]);
  assert.deepEqual(rankTasksLikeSidebar(tasks, metadata, new Map()).map(({ id }) => id), [beta, alphaOld, alphaNew]);
});

test("current local-project assignments classify a newly created project Thread without legacy roots", () => {
  const assigned = "00000000-0000-4000-8000-000000000020";
  const projectless = "00000000-0000-4000-8000-000000000021";
  const metadata = projectWorkspaceMetadata({
    "local-projects": {
      "local-party": {
        id: "local-party",
        name: "partyausrichter.com",
        rootPaths: ["/Projects/partyausrichter.com"],
      },
    },
    "thread-project-assignments": {
      [assigned]: {
        projectKind: "local",
        projectId: "local-party",
        cwd: "/Projects/partyausrichter.com",
        pendingCoreUpdate: false,
      },
    },
  });

  assert.equal(resolveProjectLabel({ id: assigned, cwd: "/elsewhere" }, metadata), "partyausrichter.com");
  assert.equal(resolveProjectLabel({ id: projectless, cwd: "/elsewhere" }, metadata), undefined);
  assert.deepEqual(metadata.savedRoots, ["/Projects/partyausrichter.com"]);
});

test("current unified project order and custom sections project only local sidebar items", () => {
  const fixture: unknown = JSON.parse(readFileSync(new URL("../fixtures/sidebar-custom-sections.json", import.meta.url), "utf8"));
  const metadata = projectWorkspaceMetadata(fixture);

  assert.deepEqual(metadata.projectOrder, ["/work/normal", "/work/current", "/work/secondary"]);
  assert.deepEqual(metadata.sidebarSectionItems, [
    { kind: "project", roots: ["/work/current"] },
    { kind: "task", taskId: "00000000-0000-4000-8000-000000000105" },
    { kind: "task", taskId: "00000000-0000-4000-8000-000000000102" },
    { kind: "project", roots: ["/work/pinned"] },
    { kind: "project", roots: ["/work/secondary"] },
    { kind: "projects" },
    { kind: "tasks" },
  ]);
  assert.deepEqual(metadata.pinnedProjectIds, ["/work/pinned"]);
});

test("custom sidebar state from several accounts is not combined", () => {
  const metadata = projectWorkspaceMetadata({
    "project-order": ["/work/normal"],
    "electron-persisted-atom-state": {
      "sidebar-custom-sections-v3": {
        first: { sections: [{ id: "first", itemKeys: [] }] },
        second: { sections: [{ id: "second", itemKeys: [] }] },
      },
    },
  });

  assert.deepEqual(metadata.projectOrder, ["/work/normal"]);
  assert.deepEqual(metadata.sidebarSectionItems, []);
});

test("unified chat order supersedes the old atom and skips composer placeholders and other sources", () => {
  const earlier = "00000000-0000-4000-8000-000000000121";
  const later = "00000000-0000-4000-8000-000000000122";
  const metadata = projectWorkspaceMetadata({
    "electron-persisted-atom-state": {
      "codex-sidebar-chat-order-v1": { threadIds: [earlier, later] },
      "unified-sidebar-chat-order-v1": [
        "codex:thread:local:client-new-thread:00000000-0000-4000-8000-000000000123",
        "chatgpt:thread:unrelated",
        `codex:thread:remote:${earlier}`,
        `codex:thread:local:${later}`,
        `codex:thread:local:${earlier}`,
      ],
    },
  });

  assert.deepEqual(metadata.projectlessThreadOrder, { threadIds: [later, earlier] });
});
