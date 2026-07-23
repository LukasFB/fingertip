import assert from "node:assert/strict";
import test from "node:test";

import {
  CatalogSchemaError,
  TaskCatalogService,
  type CatalogRpcPort,
} from "../../src/catalog/task-catalog-service.ts";
import { projectWorkspaceMetadata } from "../../src/catalog/project-label-resolver.ts";

function record(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    createdAt: 1_000 - index,
    name: `Task ${index}`,
    cwd: "/Users/test/Project",
    parentThreadId: null,
    ephemeral: false,
    ...overrides,
  };
}

test("Task catalog reads the bounded catalog and publishes ChatGPT Sidebar order", async () => {
  const calls: { limit: number; cursor?: string }[] = [];
  const client: CatalogRpcPort = {
    async listThreads(input) {
      calls.push(input);
      if (input.cursor === undefined) {
        return { data: Array.from({ length: 50 }, (_, index) => record(index + 1, index < 20 ? { ephemeral: true } : {})), nextCursor: "page-2" };
      }
      return { data: Array.from({ length: 40 }, (_, index) => record(index + 51)), nextCursor: null };
    },
  };
  const service = new TaskCatalogService(client, {
    readMetadata: async () => projectWorkspaceMetadata({
      "electron-saved-workspace-roots": ["/Users/test/Project"],
    }),
  });

  const feed = await service.refresh(60);

  assert.deepEqual(calls, [{ limit: 500 }, { limit: 450, cursor: "page-2" }]);
  assert.equal(feed.length, 70);
  assert.equal(feed[0]?.title, "Task 21");
  assert.equal(feed[0]?.projectLabel, "Project");
  assert.equal(service.workspacePath(feed[0]?.id ?? ""), "/Users/test/Project");
  assert.equal(service.view.state, "fresh");
});

test("a uniquely open Task in Codex's selected local project remains catalogued", async () => {
  const selectedTask = "00000000-0000-4000-8000-000000000061";
  const otherTask = "00000000-0000-4000-8000-000000000062";
  const service = new TaskCatalogService({
    async listThreads() {
      return {
        data: [
          record(61, { id: selectedTask, cwd: "/Users/test/Selected" }),
          record(62, { id: otherTask, cwd: "/Users/test/Other" }),
        ],
        nextCursor: null,
      };
    },
  }, {
    readMetadata: async () => projectWorkspaceMetadata({
      "electron-saved-workspace-roots": ["/Users/test/Selected", "/Users/test/Other"],
      "local-projects": {
        "local-selected": { id: "local-selected", rootPaths: ["/Users/test/Selected"] },
        "local-other": { id: "local-other", rootPaths: ["/Users/test/Other"] },
      },
      "selected-project": { type: "local", projectId: "local-selected" },
    }),
  });

  await service.refresh(2);

  assert.equal(service.selectedProjectTaskId(), selectedTask);
});

test("a bad later catalog page preserves the previously published immutable feed", async () => {
  let generation = 0;
  const client: CatalogRpcPort = {
    async listThreads(input) {
      if (generation === 0) return { data: [record(1)], nextCursor: null };
      if (input.cursor === undefined) return { data: [record(2, { ephemeral: true })], nextCursor: "bad" };
      return { data: "invalid", nextCursor: null };
    },
  };
  const service = new TaskCatalogService(client, {
    readMetadata: async () => projectWorkspaceMetadata({}),
  });
  const first = await service.refresh(1);
  generation = 1;

  await assert.rejects(service.refresh(1));

  assert.equal(service.view.state, "stale");
  assert.equal(service.view.feed, first);
  assert.equal(service.view.feed?.[0]?.title, "Task 1");
});

test("catalog refreshes never overlap and stop at exactly 500 examined raw records", async () => {
  let resolveFirst!: (value: unknown) => void;
  const firstResponse = new Promise<unknown>((resolve) => { resolveFirst = resolve; });
  let firstCall = true;
  const limits: number[] = [];
  const client: CatalogRpcPort = {
    async listThreads(input) {
      limits.push(input.limit);
      if (firstCall) {
        firstCall = false;
        return firstResponse;
      }
      return {
        data: Array.from({ length: input.limit }, (_, index) => record(index + 1, { ephemeral: true })),
        nextCursor: `cursor-${limits.length}`,
      };
    },
  };
  const service = new TaskCatalogService(client, { readMetadata: async () => projectWorkspaceMetadata({}) });
  const first = service.refresh(99);

  await assert.rejects(service.refresh(99), /already in flight/u);
  resolveFirst({
    data: Array.from({ length: 109 }, (_, index) => record(index + 1, { ephemeral: true })),
    nextCursor: "cursor-1",
  });
  const feed = await first;

  assert.equal(feed.length, 0);
  assert.deepEqual(limits, [500, 391]);
});

test("live status changes rerank the cached feed without another catalog query", async () => {
  const waiting = "00000000-0000-4000-8000-000000000021";
  const working = "00000000-0000-4000-8000-000000000022";
  let calls = 0;
  const service = new TaskCatalogService({
    async listThreads() {
      calls += 1;
      return {
        data: [
          record(21, { id: waiting, recencyAt: 100 }),
          record(22, { id: working, recencyAt: 200 }),
        ],
        nextCursor: null,
      };
    },
  }, {
    readMetadata: async () => projectWorkspaceMetadata({
      "electron-saved-workspace-roots": ["/Users/test/Project"],
      "electron-persisted-atom-state": {
        "flat-project-sidebar-preferences-v1": { mode: "project", projectSortMode: "priority" },
      },
    }),
  });
  await service.refresh(2, new Map([[working, "working"]]));

  const reranked = service.rerank(new Map([[waiting, "waiting"], [working, "working"]]));

  assert.equal(calls, 1);
  assert.deepEqual(reranked.feed?.map((task) => task.id), [waiting, working]);
});

test("manual project order stays materialized when updated_at changes without stored thread IDs", async () => {
  const alpha = "00000000-0000-4000-8000-000000000071";
  const beta = "00000000-0000-4000-8000-000000000072";
  const newcomer = "00000000-0000-4000-8000-000000000073";
  let generation = 0;
  const service = new TaskCatalogService({
    async listThreads() {
      const byGeneration = [
        [record(71, { id: alpha, recencyAt: 300 }), record(72, { id: beta, recencyAt: 200 })],
        [record(72, { id: beta, recencyAt: 400 }), record(71, { id: alpha, recencyAt: 300 })],
        [
          record(73, { id: newcomer, recencyAt: 500 }),
          record(72, { id: beta, recencyAt: 400 }),
          record(71, { id: alpha, recencyAt: 300 }),
        ],
      ];
      return { data: byGeneration[generation], nextCursor: null };
    },
  }, {
    readMetadata: async () => projectWorkspaceMetadata({
      "electron-saved-workspace-roots": ["/Users/test/Project"],
      "electron-persisted-atom-state": {
        "codex-sidebar-sort-mode-v1": "manual",
      },
    }),
  });

  assert.deepEqual((await service.refresh(3)).map(({ id }) => id), [alpha, beta]);
  generation = 1;
  assert.deepEqual((await service.refresh(3)).map(({ id }) => id), [alpha, beta]);
  service.rerank(new Map([[beta, "working"]]));
  assert.deepEqual(service.view.feed?.map(({ id }) => id), [alpha, beta]);
  generation = 2;
  assert.deepEqual((await service.refresh(3)).map(({ id }) => id), [newcomer, alpha, beta]);
});

test("a newly stored manual project order overrides the materialized fallback", async () => {
  const alpha = "00000000-0000-4000-8000-000000000074";
  const beta = "00000000-0000-4000-8000-000000000075";
  let storeOrder = false;
  const service = new TaskCatalogService({
    async listThreads() {
      return {
        data: [
          record(74, { id: alpha, recencyAt: 300 }),
          record(75, { id: beta, recencyAt: 200 }),
        ],
        nextCursor: null,
      };
    },
  }, {
    readMetadata: async () => projectWorkspaceMetadata({
      "electron-saved-workspace-roots": ["/Users/test/Project"],
      ...(storeOrder ? {
        "sidebar-project-thread-orders": {
          "/Users/test/Project": { threadIds: [beta, alpha] },
        },
      } : {}),
      "electron-persisted-atom-state": {
        "codex-sidebar-sort-mode-v1": "manual",
      },
    }),
  });

  assert.deepEqual((await service.refresh(2)).map(({ id }) => id), [alpha, beta]);
  storeOrder = true;
  assert.deepEqual((await service.refresh(2)).map(({ id }) => id), [beta, alpha]);
});

test("metadata failure preserves known labels but omits unresolved labels for new Tasks", async () => {
  let generation = 0;
  const client: CatalogRpcPort = {
    async listThreads() {
      return generation === 0
        ? { data: [record(1)], nextCursor: null }
        : { data: [record(2), record(1)], nextCursor: null };
    },
  };
  const service = new TaskCatalogService(client, {
    readMetadata: async () => {
      if (generation > 0) throw new Error("fixture metadata failure");
      return projectWorkspaceMetadata({ "electron-saved-workspace-roots": ["/Users/test/Project"] });
    },
  });
  await service.refresh(2);
  generation = 1;

  const feed = await service.refresh(2);

  assert.equal(feed.find((task) => task.title === "Task 2")?.projectLabel, undefined);
  assert.equal(feed.find((task) => task.title === "Task 1")?.projectLabel, "Project");
  assert.equal(feed.find((task) => task.title === "Task 2")?.source, "pinned-projects");
  assert.equal(feed.find((task) => task.title === "Task 1")?.source, "pinned-projects");
  assert.equal(service.view.state, "fresh");
});

test("successive refreshes publish sidebar moves, pins, and archived Task removal", async () => {
  const alpha = "00000000-0000-4000-8000-000000000081";
  const beta = "00000000-0000-4000-8000-000000000082";
  let catalogGeneration = 0;
  let metadataGeneration = 0;
  const service = new TaskCatalogService({
    async listThreads() {
      const data = [
        record(81, { id: alpha, cwd: "/Users/test/Alpha", recencyAt: 200 }),
        record(82, { id: beta, cwd: "/Users/test/Beta", recencyAt: 100 }),
      ];
      return {
        data: catalogGeneration === 3 ? data.filter((entry) => entry.id !== alpha) : data,
        nextCursor: null,
      };
    },
  }, {
    readMetadata: async () => projectWorkspaceMetadata({
      "electron-saved-workspace-roots": ["/Users/test/Alpha", "/Users/test/Beta"],
      "project-order": metadataGeneration === 0
        ? ["/Users/test/Alpha", "/Users/test/Beta"]
        : ["/Users/test/Beta", "/Users/test/Alpha"],
      ...(metadataGeneration === 2 ? { "pinned-thread-ids": [alpha] } : {}),
      "electron-persisted-atom-state": {
        "flat-project-sidebar-preferences-v1": { mode: "project", projectSortMode: "manual" },
        "codex-sidebar-sort-mode-v1": "manual",
      },
    }),
  });

  assert.deepEqual((await service.refresh(2)).map(({ id }) => id), [alpha, beta]);
  metadataGeneration = 1;
  assert.deepEqual((await service.refresh(2)).map(({ id }) => id), [beta, alpha]);
  metadataGeneration = 2;
  assert.deepEqual((await service.refresh(2)).map(({ id }) => id), [alpha, beta]);
  catalogGeneration = 3;
  assert.deepEqual((await service.refresh(2)).map(({ id }) => id), [beta]);
});

test("an invalid thread-list shape exposes only a stable compatibility signature", async () => {
  const service = new TaskCatalogService({
    async listThreads() {
      return { data: "PRIVATE TASK CONTENT", nextCursor: null };
    },
  }, { readMetadata: async () => projectWorkspaceMetadata({}) });

  await assert.rejects(service.refresh(1), (error: unknown) => {
    assert.equal(error instanceof CatalogSchemaError, true);
    assert.equal((error as CatalogSchemaError).signature, "thread-list");
    assert.equal(String(error).includes("PRIVATE TASK CONTENT"), false);
    return true;
  });
});
