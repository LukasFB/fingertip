import assert from "node:assert/strict";
import test from "node:test";

import { diagnosticLabel, selectDiagnosticCode } from "../../src/diagnostics/safe-diagnostics.ts";

test("diagnostics follow the fixed per-action precedence without private data", () => {
  assert.equal(selectDiagnosticCode({
    imageUpdateFailed: true,
    navigationFailed: true,
    catalogState: "incompatible",
    desktopState: "incompatible",
    taskLiveFreshness: "stale",
  }), "IMAGE_UPDATE_FAILED");
  assert.equal(selectDiagnosticCode({
    imageUpdateFailed: false,
    navigationFailed: false,
    catalogState: "fresh",
    desktopState: "online",
    taskLiveFreshness: "fresh",
  }), "READY");
  assert.equal(diagnosticLabel("IPC_INCOMPATIBLE"), "ChatGPT changed; Fingertip needs an update");
});

test("every public diagnostic code has the fixed English label", () => {
  assert.deepEqual([
    "STARTING", "READY", "CHATGPT_NOT_RUNNING", "IPC_UNAVAILABLE", "IPC_INCOMPATIBLE",
    "CATALOG_UNAVAILABLE", "CATALOG_INCOMPATIBLE", "LIVE_STATUS_STALE",
    "IMAGE_UPDATE_FAILED", "NAVIGATION_FAILED",
  ].map((code) => diagnosticLabel(code as Parameters<typeof diagnosticLabel>[0])), [
    "Connecting…",
    "Connected",
    "ChatGPT is not running",
    "Live Task status is unavailable",
    "ChatGPT changed; Fingertip needs an update",
    "Task list is unavailable",
    "ChatGPT Task list is incompatible",
    "This Task's live status is unavailable",
    "Stream Deck did not accept the key update",
    "ChatGPT could not be opened",
  ]);
});
