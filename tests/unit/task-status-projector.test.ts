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

test("Fast Mode settings are projected and patched without retaining private settings", () => {
  const fast = projectStatusSnapshot({
    threadRuntimeStatus: { type: "idle" },
    hasUnreadTurn: false,
    requests: [],
    latestThreadSettings: {
      serviceTier: "priority",
      privateSetting: "PRIVATE",
    },
  });
  assert.equal(toTaskLiveFacts(fast).serviceTier, "priority");
  assert.equal(JSON.stringify(fast).includes("PRIVATE"), false);

  const standard = applyStatusPatches(fast, [{
    op: "replace",
    path: ["latestThreadSettings"],
    value: {
      serviceTier: null,
      privateSetting: "PRIVATE",
    },
  }]);
  assert.equal(toTaskLiveFacts(standard).serviceTier, null);
  const fastAgain = applyStatusPatches(standard, [{
    op: "replace", path: ["latestThreadSettings", "serviceTier"], value: "priority",
  }]);
  assert.equal(toTaskLiveFacts(fastAgain).serviceTier, "priority");

  assert.throws(() => applyStatusPatches(fastAgain, [{
    op: "replace", path: ["latestThreadSettings"], value: { serviceTier: { id: "internal" } },
  }]), /invalid service tier/);

  const partialSettingUpdate = applyStatusPatches(fastAgain, [{
    op: "replace",
    path: ["latestThreadSettings"],
    value: { privateSetting: "ignored" },
  }]);
  assert.equal(toTaskLiveFacts(partialSettingUpdate).serviceTier, "priority");

  const removedSettings = applyStatusPatches(partialSettingUpdate, [{
    op: "remove", path: ["latestThreadSettings"],
  }]);
  assert.equal(toTaskLiveFacts(removedSettings).serviceTier, undefined);
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
