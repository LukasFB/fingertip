import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readWorkspaceMetadata } from "../../src/catalog/global-state-reader.ts";
import { parseTaskId } from "../../src/catalog/catalog-projection.ts";

test("global-state reader opens a UID-owned regular file and projects only allowlisted metadata", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fingertip-state-"));
  context.after(async () => { await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true })); });
  const statePath = path.join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({
    "projectless-thread-ids": ["00000000-0000-4000-8000-000000000001"],
    "electron-saved-workspace-roots": ["/Users/test/Project"],
    "queued-follow-ups": {
      "00000000-0000-4000-8000-000000000001": [
        { text: "must-not-survive" },
        { text: "must-not-survive-either" },
      ],
    },
    secret: "must-not-survive",
  }));

  const metadata = await readWorkspaceMetadata(statePath);

  assert.equal(metadata.projectlessTaskIds.size, 1);
  assert.deepEqual(metadata.savedRoots, ["/Users/test/Project"]);
  assert.equal(metadata.queuedFollowUpCounts.get(parseTaskId("00000000-0000-4000-8000-000000000001")), 2);
  assert.equal(JSON.stringify(metadata).includes("secret"), false);
  assert.equal(JSON.stringify(metadata).includes("must-not-survive"), false);
});

test("global-state reader ignores malformed auxiliary queue metadata", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fingertip-state-"));
  context.after(async () => { await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true })); });
  const statePath = path.join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({
    "electron-saved-workspace-roots": ["/Users/test/Project"],
    "queued-follow-ups": { invalid: "future-shape" },
  }));

  const metadata = await readWorkspaceMetadata(statePath);

  assert.deepEqual(metadata.savedRoots, ["/Users/test/Project"]);
  assert.equal(metadata.queuedFollowUpCounts.size, 0);
});

test("global-state reader rejects symlinks and oversize files", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fingertip-state-"));
  context.after(async () => { await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true })); });
  const target = path.join(directory, "target.json");
  const link = path.join(directory, "link.json");
  const large = path.join(directory, "large.json");
  await writeFile(target, "{}");
  await symlink(target, link);
  await writeFile(large, Buffer.alloc(4 * 1024 * 1024 + 1));

  await assert.rejects(readWorkspaceMetadata(link));
  await assert.rejects(readWorkspaceMetadata(large));
});
