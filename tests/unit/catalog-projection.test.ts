import assert from "node:assert/strict";
import test from "node:test";

import { projectThreadListResult } from "../../src/catalog/catalog-projection.ts";

test("thread/list projection keeps only ordered materialized top-level Task metadata", () => {
  const result = projectThreadListResult({
    data: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        createdAt: 30,
        name: "  Newest   Task  ",
        cwd: "/Projects/newest",
        parentThreadId: null,
        ephemeral: false,
        preview: "PRIVATE_PREVIEW",
        status: { type: "active" },
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        createdAt: 20,
        name: "Child",
        cwd: "/Projects/child",
        parentThreadId: "00000000-0000-4000-8000-000000000001",
        ephemeral: false,
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        createdAt: 10,
        name: null,
        cwd: "/Projects/ephemeral",
        parentThreadId: null,
        ephemeral: true,
      },
      {
        id: "00000000-0000-4000-8000-000000000004",
        createdAt: 5,
        name: "   ",
        cwd: "/Projects/oldest",
        parentThreadId: null,
        ephemeral: false,
      },
    ],
    nextCursor: "cursor-2",
  });

  assert.deepEqual(result, {
    tasks: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        createdAt: 30,
        updatedAt: 30,
        recencyAt: 30,
        title: "Newest Task",
        cwd: "/Projects/newest",
      },
      {
        id: "00000000-0000-4000-8000-000000000004",
        createdAt: 5,
        updatedAt: 5,
        recencyAt: 5,
        title: "New Task",
        cwd: "/Projects/oldest",
      },
    ],
    nextCursor: "cursor-2",
    rawCount: 4,
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});
