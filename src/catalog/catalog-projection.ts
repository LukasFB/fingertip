export type TaskId = string & { readonly __taskId: unique symbol };

export interface ProjectableCatalogTask {
  readonly id: TaskId;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recencyAt: number;
  readonly title: string;
  readonly cwd: string;
}

export interface ProjectedThreadListResult {
  readonly tasks: readonly ProjectableCatalogTask[];
  readonly nextCursor: string | null;
  readonly rawCount: number;
}

const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(message: string): never {
  throw new TypeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTaskId(value: unknown): TaskId {
  if (typeof value !== "string" || !TASK_ID_PATTERN.test(value)) fail("invalid Task ID");
  return value as TaskId;
}

function normalizeGraphemes(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const segments = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(normalized)];
  return segments.slice(0, maximum).map((segment) => segment.segment).join("");
}

function projectEligibleTask(value: Record<string, unknown>): ProjectableCatalogTask | null {
  if (typeof value.ephemeral !== "boolean") fail("invalid ephemeral flag");
  if (value.parentThreadId !== null && typeof value.parentThreadId !== "string") {
    fail("invalid parentThreadId");
  }
  if (value.ephemeral || value.parentThreadId !== null) return null;

  const id = parseTaskId(value.id);
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) fail("invalid createdAt");
  if (value.updatedAt !== undefined && (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt))) {
    fail("invalid updatedAt");
  }
  if (value.recencyAt !== undefined && value.recencyAt !== null
    && (typeof value.recencyAt !== "number" || !Number.isFinite(value.recencyAt))) {
    fail("invalid recencyAt");
  }
  if (value.name !== null && typeof value.name !== "string") fail("invalid Task name");
  if (typeof value.cwd !== "string" || Buffer.byteLength(value.cwd, "utf8") > 4_096) fail("invalid cwd");
  const title = normalizeGraphemes(value.name ?? "", 512) || "New Task";
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : value.createdAt;
  const recencyAt = typeof value.recencyAt === "number" ? value.recencyAt : updatedAt;
  return Object.freeze({ id, createdAt: value.createdAt, updatedAt, recencyAt, title, cwd: value.cwd });
}

export function projectThreadListResult(value: unknown): ProjectedThreadListResult {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > 500) {
    fail("invalid thread/list result");
  }
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") fail("invalid nextCursor");
  const tasks: ProjectableCatalogTask[] = [];
  for (const entry of value.data) {
    if (!isRecord(entry)) fail("invalid Task record");
    const projected = projectEligibleTask(entry);
    if (projected !== null) tasks.push(projected);
  }
  return Object.freeze({
    tasks: Object.freeze(tasks),
    nextCursor: value.nextCursor,
    rawCount: value.data.length,
  });
}
