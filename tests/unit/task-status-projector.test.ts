import assert from "node:assert/strict";
import test from "node:test";

import {
  applyStatusPatches,
  deriveTaskStatus,
  projectStatusSnapshot,
  toTaskLiveFacts,
} from "../../src/status/task-status-projector.ts";

test("Task Status follows confirmation, waiting, working, done, idle precedence", () => {
  assert.equal(deriveTaskStatus({
    isActive: true,
    waitingOnApproval: true,
    waitingOnUserInput: true,
    hasUnreadTurn: true,
  }), "confirmation");
  assert.equal(deriveTaskStatus({
    isActive: true,
    waitingOnApproval: false,
    waitingOnUserInput: true,
    hasUnreadTurn: true,
  }), "waiting");
  assert.equal(deriveTaskStatus({
    isActive: true,
    waitingOnApproval: false,
    waitingOnUserInput: false,
    hasUnreadTurn: true,
  }), "working");
  assert.equal(deriveTaskStatus({
    isActive: false,
    waitingOnApproval: false,
    waitingOnUserInput: false,
    hasUnreadTurn: true,
  }), "done");
  assert.equal(deriveTaskStatus({
    isActive: false,
    waitingOnApproval: false,
    waitingOnUserInput: false,
    hasUnreadTurn: false,
  }), "idle");
});

test("a runnable queued follow-up bridges the gap between consecutive turns without delaying other states", () => {
  assert.equal(deriveTaskStatus({
    isActive: false,
    waitingOnApproval: false,
    waitingOnUserInput: false,
    hasUnreadTurn: true,
    hasQueuedFollowUp: true,
  }), "working");
  assert.equal(deriveTaskStatus({
    isActive: false,
    waitingOnApproval: true,
    waitingOnUserInput: false,
    hasUnreadTurn: true,
    hasQueuedFollowUp: true,
  }), "confirmation");
});

test("a rich desktop snapshot is reduced to bounded status facts without private content", () => {
  const projected = projectStatusSnapshot({
    threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnUserInput"] },
    hasUnreadTurn: true,
    requests: [{
      method: "item/commandExecution/requestApproval",
      completed: false,
      params: { command: "PRIVATE_COMMAND", reason: "PRIVATE_REASON" },
    }],
    turns: [{ text: "PRIVATE_MESSAGE" }],
  });

  assert.deepEqual(toTaskLiveFacts(projected), {
    isActive: true,
    waitingOnApproval: true,
    waitingOnUserInput: true,
    hasUnreadTurn: true,
  });
  assert.equal(JSON.stringify(projected).includes("PRIVATE"), false);
});

test("thread model and service tier settings are projected without retaining other thread settings", () => {
  const projected = projectStatusSnapshot({
    threadRuntimeStatus: { type: "idle" },
    hasUnreadTurn: false,
    requests: [],
    latestThreadSettings: {
      serviceTier: "priority",
      model: "gpt-5.6-terra",
      effort: "xhigh",
      privateSetting: "PRIVATE",
    },
  });
  assert.equal(toTaskLiveFacts(projected).serviceTier, "priority");
  assert.equal(toTaskLiveFacts(projected).model, "gpt-5.6-terra");
  assert.equal(toTaskLiveFacts(projected).effort, "xhigh");
  const patched = applyStatusPatches(projected, [{
    op: "replace", path: ["latestThreadSettings", "model"], value: "gpt-5.6-luna",
  }, {
    op: "replace", path: ["latestThreadSettings", "effort"], value: "high",
  }, {
    op: "replace", path: ["latestThreadSettings", "serviceTier"], value: null,
  }]);
  assert.equal(toTaskLiveFacts(patched).serviceTier, null);
  assert.equal(toTaskLiveFacts(patched).model, "gpt-5.6-luna");
  assert.equal(toTaskLiveFacts(patched).effort, "high");
  assert.equal(JSON.stringify(patched).includes("PRIVATE"), false);

  const partialSettings = applyStatusPatches(projected, [{
    op: "replace",
    path: ["latestThreadSettings"],
    value: { model: "gpt-5.6-sol", effort: "medium" },
  }]);
  assert.equal(toTaskLiveFacts(partialSettings).serviceTier, "priority");
});

test("dynamic model and effort identifiers up to 256 UTF-8 bytes survive snapshots and patches", () => {
  const model = `future-${"m".repeat(249)}`;
  const effort = "ä".repeat(128);
  assert.equal(Buffer.byteLength(model, "utf8"), 256);
  assert.equal(Buffer.byteLength(effort, "utf8"), 256);
  const idle = {
    threadRuntimeStatus: { type: "idle" },
    hasUnreadTurn: false,
    requests: [],
  };
  const snapshot = projectStatusSnapshot({ ...idle, latestThreadSettings: { model, effort } });
  assert.equal(toTaskLiveFacts(snapshot).model, model);
  assert.equal(toTaskLiveFacts(snapshot).effort, effort);

  const empty = projectStatusSnapshot(idle);
  const fields = applyStatusPatches(empty, [
    { op: "replace", path: ["latestThreadSettings", "model"], value: model },
    { op: "replace", path: ["latestThreadSettings", "effort"], value: effort },
  ]);
  const whole = applyStatusPatches(empty, [{
    op: "replace", path: ["latestThreadSettings"], value: { model, effort },
  }]);
  assert.deepEqual(toTaskLiveFacts(fields), toTaskLiveFacts(snapshot));
  assert.deepEqual(toTaskLiveFacts(whole), toTaskLiveFacts(snapshot));
});

test("model and effort settings over 256 UTF-8 bytes are rejected in snapshots and both patch forms", () => {
  const idle = {
    threadRuntimeStatus: { type: "idle" },
    hasUnreadTurn: false,
    requests: [],
  };
  const state = projectStatusSnapshot({ ...idle, latestThreadSettings: { model: "future-model", effort: "future-effort" } });
  for (const field of ["model", "effort"] as const) {
    for (const oversized of ["x".repeat(257), "ä".repeat(129)]) {
      const message = new RegExp(`invalid ${field}`);
      assert.throws(() => projectStatusSnapshot({ ...idle, latestThreadSettings: { [field]: oversized } }), message);
      assert.throws(() => applyStatusPatches(state, [{
        op: "replace", path: ["latestThreadSettings", field], value: oversized,
      }]), message);
      assert.throws(() => applyStatusPatches(state, [{
        op: "replace", path: ["latestThreadSettings"], value: { [field]: oversized },
      }]), message);
    }
  }
  assert.equal(toTaskLiveFacts(state).model, "future-model");
  assert.equal(toTaskLiveFacts(state).effort, "future-effort");
});

test("only the documented outstanding request categories require attention", () => {
  const snapshot = (requests: unknown[]) => projectStatusSnapshot({
    threadRuntimeStatus: { type: "idle" },
    hasUnreadTurn: false,
    requests,
  });

  assert.equal(deriveTaskStatus(toTaskLiveFacts(snapshot([
    { method: "item/tool/requestUserInput" },
  ]))), "waiting");
  assert.equal(deriveTaskStatus(toTaskLiveFacts(snapshot([
    { method: "item/tool/call", params: { tool: "request_option_picker" } },
  ]))), "waiting");
  assert.equal(deriveTaskStatus(toTaskLiveFacts(snapshot([
    { method: "item/tool/call", params: { tool: "setup_codex_step", arguments: { step: "complete" } } },
  ]))), "idle");
  assert.equal(deriveTaskStatus(toTaskLiveFacts(snapshot([
    { method: "mcpServer/elicitation/request", completed: true },
    { method: "currentTime/read" },
  ]))), "idle");

  for (const method of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/plan/requestImplementation",
    "mcpServer/elicitation/request",
  ]) {
    assert.equal(deriveTaskStatus(toTaskLiveFacts(snapshot([{ method }]))), "confirmation");
  }
  for (const method of [
    "item/tool/requestUserInput",
    "item/tool/requestOptionPicker",
    "item/tool/requestSetupCodexContextPicker",
  ]) {
    assert.equal(deriveTaskStatus(toTaskLiveFacts(snapshot([{ method }]))), "waiting");
  }
  for (const tool of [
    "request_onboarding_input",
    "request_option_picker",
    "setup_codex_context_picker",
    "setup_codex_step",
  ]) {
    assert.equal(deriveTaskStatus(toTaskLiveFacts(snapshot([{
      method: "item/tool/call",
      params: { tool, arguments: { step: "pending" } },
    }]))), "waiting");
  }
});

test("a status patch batch is allowlisted and atomic", () => {
  const active = projectStatusSnapshot({
    threadRuntimeStatus: { type: "active", activeFlags: [] },
    hasUnreadTurn: false,
    requests: [],
  });
  const done = applyStatusPatches(active, [
    { op: "replace", path: ["hasUnreadTurn"], value: true },
    { op: "replace", path: ["turns", 0, "text"], value: "PRIVATE" },
    { op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } },
  ]);
  assert.equal(deriveTaskStatus(toTaskLiveFacts(done)), "done");
  assert.equal(JSON.stringify(done).includes("PRIVATE"), false);

  assert.throws(() => applyStatusPatches(active, [
    { op: "replace", path: ["hasUnreadTurn"], value: true },
    { op: "replace", path: ["requests", 0, "params", "tool"], value: "x" },
  ]), /unsupported requests patch path/);
  assert.equal(deriveTaskStatus(toTaskLiveFacts(active)), "working");
});

test("indexed request and active-flag patches preserve desktop array semantics", () => {
  const active = projectStatusSnapshot({
    threadRuntimeStatus: { type: "active", activeFlags: [] },
    hasUnreadTurn: false,
    requests: [],
  });
  const waiting = applyStatusPatches(active, [
    { op: "add", path: ["requests", 0], value: { method: "item/tool/requestUserInput" } },
  ]);
  assert.equal(deriveTaskStatus(toTaskLiveFacts(waiting)), "waiting");

  const completed = applyStatusPatches(waiting, [
    { op: "add", path: ["requests", 0, "completed"], value: true },
    { op: "add", path: ["threadRuntimeStatus", "activeFlags", 0], value: "waitingOnApproval" },
  ]);
  assert.equal(deriveTaskStatus(toTaskLiveFacts(completed)), "confirmation");

  const working = applyStatusPatches(completed, [
    { op: "remove", path: ["requests", 0] },
    { op: "remove", path: ["threadRuntimeStatus", "activeFlags", 0] },
  ]);
  assert.equal(deriveTaskStatus(toTaskLiveFacts(working)), "working");
});

test("status projection enforces the 16/256/1,024 defensive bounds", () => {
  assert.throws(() => projectStatusSnapshot({
    threadRuntimeStatus: { type: "active", activeFlags: Array.from({ length: 17 }, () => "waitingOnApproval") },
    hasUnreadTurn: false,
    requests: [],
  }));
  assert.throws(() => projectStatusSnapshot({
    threadRuntimeStatus: { type: "idle" },
    hasUnreadTurn: false,
    requests: Array.from({ length: 257 }, () => ({ method: "currentTime/read" })),
  }));
  const idle = projectStatusSnapshot({
    threadRuntimeStatus: { type: "idle" }, hasUnreadTurn: false, requests: [],
  });
  assert.throws(() => applyStatusPatches(idle, Array.from({ length: 1_025 }, () => ({
    op: "replace", path: ["unrelated"], value: null,
  }))));
  assert.throws(() => projectStatusSnapshot({
    threadRuntimeStatus: { type: "idle" },
    hasUnreadTurn: false,
    requests: [{ method: "x".repeat(129) }],
  }));
});
