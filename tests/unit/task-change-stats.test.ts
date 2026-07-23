import assert from "node:assert/strict";
import test from "node:test";

import { projectTaskChangeStats } from "../../src/task-change-stats.ts";

test("Task Change Stats aggregate only App Server file changes for one thread", () => {
  const stats = projectTaskChangeStats({
    thread: {
      turns: [{
        items: [
          { type: "agentMessage", text: "This content must be ignored." },
          {
            type: "fileChange",
            changes: [{
              path: "src/first.ts",
              diff: "--- a/src/first.ts\n+++ b/src/first.ts\n@@ -1 +1,2 @@\n old\n-old\n+new\n+another\n",
            }],
          },
        ],
      }, {
        items: [{
          type: "fileChange",
          changes: [{
            path: "src/first.ts",
            diff: "@@ -4 +5 @@\n-old value\n+new value\n",
          }, {
            path: "src/second.ts",
            diff: "@@ -0,0 +1 @@\n+created\n",
          }],
        }],
      }],
    },
  });

  assert.deepEqual(stats, { added: 4, deleted: 2, files: 2 });
});

test("Task Change Stats fail closed for malformed App Server content", () => {
  assert.equal(projectTaskChangeStats({ thread: { turns: [{ items: [{ type: "fileChange", changes: [{
    path: "src/file.ts", diff: 42,
  }] }] }] } }), null);
  assert.equal(projectTaskChangeStats({ thread: { turns: "private task content" } }), null);
});
