import assert from "node:assert/strict";
import test from "node:test";

import { projectKeyPresentation } from "../../src/runtime/key-presentation.ts";

test("Key presentation distinguishes loading, authoritative empty, unloaded and stale Task states", () => {
  assert.deepEqual(projectKeyPresentation({
    catalogState: "cold",
    feedAvailable: false,
    desktopState: "connecting",
    task: null,
  }), { kind: "loading", status: null, offlineWarning: false, navigable: false });

  assert.deepEqual(projectKeyPresentation({
    catalogState: "unavailable",
    feedAvailable: false,
    desktopState: "offline",
    task: null,
  }), { kind: "unavailable", status: null, offlineWarning: true, navigable: false });

  assert.deepEqual(projectKeyPresentation({
    catalogState: "fresh",
    feedAvailable: true,
    desktopState: "online",
    task: null,
  }), { kind: "empty", status: null, offlineWarning: false, navigable: false });

  assert.deepEqual(projectKeyPresentation({
    catalogState: "fresh",
    feedAvailable: true,
    desktopState: "connecting",
    task: null,
  }), { kind: "empty", status: null, offlineWarning: false, navigable: false });

  assert.deepEqual(projectKeyPresentation({
    catalogState: "fresh",
    feedAvailable: true,
    desktopState: "online",
    task: { freshness: "none", status: null },
  }), { kind: "task", status: "idle", offlineWarning: false, navigable: true });

  assert.deepEqual(projectKeyPresentation({
    catalogState: "fresh",
    feedAvailable: true,
    desktopState: "connecting",
    task: { freshness: "none", status: null },
  }), { kind: "task", status: "idle", offlineWarning: true, navigable: true });

  assert.deepEqual(projectKeyPresentation({
    catalogState: "fresh",
    feedAvailable: true,
    desktopState: "online",
    task: { freshness: "stale", status: "working" },
  }), { kind: "task", status: "idle", offlineWarning: false, navigable: true });

  assert.deepEqual(projectKeyPresentation({
    catalogState: "stale",
    feedAvailable: true,
    desktopState: "offline",
    task: { freshness: "stale", status: "working" },
  }), { kind: "task", status: "working", offlineWarning: true, navigable: true });
});
