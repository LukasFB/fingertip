export type TaskStatus = "confirmation" | "waiting" | "working" | "done" | "idle";

export interface TaskLiveFacts {
  readonly isActive: boolean;
  readonly waitingOnApproval: boolean;
  readonly waitingOnUserInput: boolean;
  readonly hasUnreadTurn: boolean;
  readonly hasQueuedFollowUp?: boolean;
  readonly serviceTier?: string | null | undefined;
}

export type RuntimeKind = "active" | "idle" | "notLoaded" | "systemError";
export type RequestCategory = "confirmation" | "waiting" | "ignore";
export type ActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export interface ProjectedStatusState {
  readonly runtime: {
    readonly type: RuntimeKind;
    readonly activeFlags: readonly ActiveFlag[];
  };
  readonly hasUnreadTurn: boolean;
  readonly serviceTier: string | null | undefined;
  readonly requestSlots: readonly {
    readonly category: RequestCategory;
    readonly completed: boolean;
  }[];
}

export interface StatusPatch {
  readonly op: "add" | "remove" | "replace";
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
}

const runtimeKinds = new Set<RuntimeKind>(["active", "idle", "notLoaded", "systemError"]);
const activeFlags = new Set<ActiveFlag>(["waitingOnApproval", "waitingOnUserInput"]);
const confirmationMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/plan/requestImplementation",
  "mcpServer/elicitation/request",
]);
const waitingMethods = new Set([
  "item/tool/requestUserInput",
  "item/tool/requestOptionPicker",
  "item/tool/requestSetupCodexContextPicker",
]);
const waitingTools = new Set([
  "request_onboarding_input",
  "request_option_picker",
  "setup_codex_context_picker",
  "setup_codex_step",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(message);
}

function parseRuntime(value: unknown): ProjectedStatusState["runtime"] {
  if (!isRecord(value) || typeof value.type !== "string" || !runtimeKinds.has(value.type as RuntimeKind)) {
    return fail("invalid threadRuntimeStatus");
  }
  const type = value.type as RuntimeKind;
  if (type !== "active") return Object.freeze({ type, activeFlags: Object.freeze([]) });
  if (!Array.isArray(value.activeFlags) || value.activeFlags.length > 16) {
    return fail("activeFlags must be a bounded array");
  }
  const parsed: ActiveFlag[] = [];
  for (const flag of value.activeFlags) {
    if (typeof flag !== "string" || !activeFlags.has(flag as ActiveFlag)) fail("unknown active flag");
    if (!parsed.includes(flag as ActiveFlag)) parsed.push(flag as ActiveFlag);
  }
  return Object.freeze({ type, activeFlags: Object.freeze(parsed) });
}

function parseRequest(value: unknown): ProjectedStatusState["requestSlots"][number] {
  if (!isRecord(value) || typeof value.method !== "string" || Buffer.byteLength(value.method, "utf8") > 128) {
    fail("invalid request entry");
  }
  if (value.completed !== undefined && typeof value.completed !== "boolean") {
    fail("request completed must be boolean");
  }
  let category: RequestCategory = "ignore";
  if (confirmationMethods.has(value.method)) {
    category = "confirmation";
  } else if (waitingMethods.has(value.method)) {
    category = "waiting";
  } else if (value.method === "item/tool/call" && isRecord(value.params)) {
    const tool = value.params.tool;
    if (typeof tool === "string" && Buffer.byteLength(tool, "utf8") <= 128 && waitingTools.has(tool)) {
      const argumentsValue = value.params.arguments;
      category = tool === "setup_codex_step" && isRecord(argumentsValue) && argumentsValue.step === "complete"
        ? "ignore"
        : "waiting";
    }
  }
  return Object.freeze({
    category,
    completed: value.completed === true,
  });
}

function parseRequests(value: unknown): ProjectedStatusState["requestSlots"] {
  if (!Array.isArray(value) || value.length > 256) fail("requests must be a bounded array");
  return Object.freeze(value.map(parseRequest));
}

function parseThreadSetting(value: unknown, label: string, maximumBytes: number): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail(`invalid ${label}`);
  }
  return value;
}

function projectThreadSettings(value: unknown): Pick<ProjectedStatusState, "serviceTier"> {
  if (value === undefined) return { serviceTier: undefined };
  if (!isRecord(value)) fail("latestThreadSettings must be an object");
  return {
    serviceTier: parseThreadSetting(value.serviceTier, "service tier", 64),
  };
}

export function projectStatusSnapshot(value: unknown): ProjectedStatusState {
  if (!isRecord(value)) fail("conversationState must be an object");
  if (typeof value.hasUnreadTurn !== "boolean") fail("hasUnreadTurn must be boolean");
  const threadSettings = projectThreadSettings(value.latestThreadSettings);
  return Object.freeze({
    runtime: parseRuntime(value.threadRuntimeStatus),
    hasUnreadTurn: value.hasUnreadTurn,
    ...threadSettings,
    requestSlots: parseRequests(value.requests),
  });
}

export function toTaskLiveFacts(state: ProjectedStatusState): TaskLiveFacts {
  const pending = state.requestSlots.filter((slot) => !slot.completed).map((slot) => slot.category);
  const common = {
    isActive: state.runtime.type === "active",
    waitingOnApproval: state.runtime.activeFlags.includes("waitingOnApproval") || pending.includes("confirmation"),
    waitingOnUserInput: state.runtime.activeFlags.includes("waitingOnUserInput") || pending.includes("waiting"),
    hasUnreadTurn: state.hasUnreadTurn,
  };
  return Object.freeze({
    ...common,
    ...(state.serviceTier === undefined ? {} : { serviceTier: state.serviceTier }),
  });
}

function requirePatchValue(patch: StatusPatch): unknown {
  if (!("value" in patch)) fail("patch value is required");
  return patch.value;
}

function parseIndex(value: string | number | undefined, length: number, allowEnd = false): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) fail("patch index must be non-negative");
  const maximum = allowEnd ? length : length - 1;
  if (value > maximum) fail("patch index is out of bounds");
  return value;
}

export function applyStatusPatches(
  state: ProjectedStatusState,
  value: unknown,
): ProjectedStatusState {
  if (!Array.isArray(value) || value.length > 1_024) fail("patches must be a bounded array");
  let runtime: { type: RuntimeKind; activeFlags: ActiveFlag[] } = {
    type: state.runtime.type,
    activeFlags: [...state.runtime.activeFlags],
  };
  let hasUnreadTurn = state.hasUnreadTurn;
  let serviceTier = state.serviceTier;
  const requestSlots = state.requestSlots.map((slot) => ({ ...slot }));

  for (const candidate of value) {
    if (!isRecord(candidate)
      || (candidate.op !== "add" && candidate.op !== "remove" && candidate.op !== "replace")
      || !Array.isArray(candidate.path)
      || candidate.path.length === 0) {
      fail("invalid patch");
    }
    const patch = candidate as unknown as StatusPatch;
    const root = patch.path[0];
    if (root !== "threadRuntimeStatus" && root !== "hasUnreadTurn" && root !== "requests"
      && root !== "latestThreadSettings") continue;

    if (root === "latestThreadSettings") {
      if (patch.path.length === 1) {
        const settings = patch.op === "remove"
          ? projectThreadSettings(undefined)
          : projectThreadSettings(requirePatchValue(patch));
        if (patch.op === "remove") {
          serviceTier = undefined;
        } else {
          if (settings.serviceTier !== undefined) serviceTier = settings.serviceTier;
        }
      } else if (patch.path.length === 2) {
        const setting = patch.path[1];
        const next = patch.op === "remove" ? null : requirePatchValue(patch);
        if (setting === "serviceTier") serviceTier = parseThreadSetting(next, "service tier", 64);
      }
      continue;
    }

    if (root === "threadRuntimeStatus") {
      if (patch.path.length === 1) {
        if (patch.op === "remove") fail("threadRuntimeStatus cannot be removed");
        const nextRuntime = parseRuntime(requirePatchValue(patch));
        runtime = { type: nextRuntime.type, activeFlags: [...nextRuntime.activeFlags] };
        continue;
      }
      if (patch.path[1] !== "activeFlags" || runtime.type !== "active") {
        fail("unsupported threadRuntimeStatus patch path");
      }
      if (patch.path.length === 2) {
        if (patch.op === "remove") {
          runtime.activeFlags = [];
        } else {
          const nextRuntime = parseRuntime({ type: "active", activeFlags: requirePatchValue(patch) });
          runtime.activeFlags = [...nextRuntime.activeFlags];
        }
        continue;
      }
      if (patch.path.length !== 3) fail("unsupported threadRuntimeStatus patch path");
      const index = parseIndex(patch.path[2], runtime.activeFlags.length, patch.op === "add");
      if (patch.op === "remove") {
        runtime.activeFlags.splice(index, 1);
      } else {
        const flag = requirePatchValue(patch);
        if (typeof flag !== "string" || !activeFlags.has(flag as ActiveFlag)) fail("unknown active flag");
        if (patch.op === "add") runtime.activeFlags.splice(index, 0, flag as ActiveFlag);
        else runtime.activeFlags[index] = flag as ActiveFlag;
        runtime.activeFlags = [...new Set(runtime.activeFlags)];
      }
      continue;
    }
    if (root === "hasUnreadTurn") {
      const next = requirePatchValue(patch);
      if (patch.path.length !== 1 || patch.op === "remove" || typeof next !== "boolean") {
        fail("unsupported hasUnreadTurn patch");
      }
      hasUnreadTurn = next;
      continue;
    }
    if (patch.path.length === 1) {
      if (patch.op === "remove") fail("requests cannot be removed");
      requestSlots.splice(0, requestSlots.length, ...parseRequests(requirePatchValue(patch)));
      continue;
    }
    if (patch.path.length > 3 || (patch.path.length === 3 && patch.path[2] !== "completed")) {
      fail("unsupported requests patch path");
    }
    const index = parseIndex(patch.path[1], requestSlots.length, patch.op === "add" && patch.path.length === 2);
    if (patch.path.length === 2) {
      if (patch.op === "remove") requestSlots.splice(index, 1);
      else if (patch.op === "add") requestSlots.splice(index, 0, { ...parseRequest(requirePatchValue(patch)) });
      else requestSlots[index] = { ...parseRequest(requirePatchValue(patch)) };
      continue;
    }
    if (patch.path.length !== 3) fail("unsupported requests patch path");
    const completed = patch.op === "remove" ? false : requirePatchValue(patch);
    if (typeof completed !== "boolean") fail("request completed must be boolean");
    const slot = requestSlots[index];
    if (slot === undefined) fail("patch index is out of bounds");
    requestSlots[index] = { ...slot, completed };
  }

  return Object.freeze({
    runtime: Object.freeze({ type: runtime.type, activeFlags: Object.freeze(runtime.activeFlags) }),
    hasUnreadTurn,
    serviceTier,
    requestSlots: Object.freeze(requestSlots.map((slot) => Object.freeze(slot))),
  });
}

export function deriveTaskStatus(facts: TaskLiveFacts): TaskStatus {
  if (facts.waitingOnApproval) return "confirmation";
  if (facts.waitingOnUserInput) return "waiting";
  if (facts.isActive || facts.hasQueuedFollowUp === true) return "working";
  if (facts.hasUnreadTurn) return "done";
  return "idle";
}
