export interface ModelReasoningEffort {
  readonly reasoningEffort: string;
  readonly description: string;
}

export interface ModelCatalogEntry {
  readonly model: string;
  readonly displayName: string;
  readonly defaultReasoningEffort: string;
  readonly supportedReasoningEfforts: readonly ModelReasoningEffort[];
  readonly isDefault: boolean;
}

export interface ModelCatalogClient {
  listModels(input: { readonly limit: number; readonly cursor?: string }): Promise<unknown>;
}

export interface ProjectedModelListResult {
  readonly models: readonly ModelCatalogEntry[];
  readonly nextCursor: string | null;
}

const PAGE_SIZE = 100;
const MAXIMUM_MODELS = 500;
const MAXIMUM_PAGES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, maximumBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes
    || (!allowEmpty && value.trim().length === 0) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`invalid model ${field}`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 256);
  if (result !== result.trim() || /\s/u.test(result)) throw new TypeError(`invalid model ${field}`);
  return result;
}

function projectModel(value: unknown): ModelCatalogEntry | null {
  if (!isRecord(value)) throw new TypeError("invalid model record");
  if (value.hidden !== undefined && typeof value.hidden !== "boolean") throw new TypeError("invalid model hidden flag");
  if (value.hidden === true) return null;
  if (typeof value.isDefault !== "boolean") throw new TypeError("invalid model default flag");
  if (!Array.isArray(value.supportedReasoningEfforts) || value.supportedReasoningEfforts.length > 64) {
    throw new TypeError("invalid model reasoning efforts");
  }
  const seen = new Set<string>();
  const supportedReasoningEfforts = value.supportedReasoningEfforts.map((effort: unknown) => {
    if (!isRecord(effort)) throw new TypeError("invalid model reasoning effort");
    const reasoningEffort = identifier(effort.reasoningEffort, "reasoning effort");
    if (seen.has(reasoningEffort)) throw new TypeError("duplicate model reasoning effort");
    seen.add(reasoningEffort);
    return Object.freeze({ reasoningEffort, description: text(effort.description, "effort description", 4_096, true) });
  });
  return Object.freeze({
    model: identifier(value.model, "identifier"),
    displayName: text(value.displayName, "display name", 512),
    defaultReasoningEffort: identifier(value.defaultReasoningEffort, "default reasoning effort"),
    supportedReasoningEfforts: Object.freeze(supportedReasoningEfforts),
    isDefault: value.isDefault,
  });
}

/** Project only picker settings; model IDs and effort values remain server-owned strings. */
export function projectModelListResult(value: unknown): ProjectedModelListResult {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > MAXIMUM_MODELS) {
    throw new TypeError("invalid model/list result");
  }
  const nextCursor = value.nextCursor === undefined || value.nextCursor === null
    ? null
    : text(value.nextCursor, "pagination cursor", 4_096);
  const models: ModelCatalogEntry[] = [];
  for (const entry of value.data) {
    const model = projectModel(entry);
    if (model !== null) models.push(model);
  }
  return Object.freeze({ models: Object.freeze(models), nextCursor });
}

/** Discover the full visible picker catalog without ever starting or changing a thread. */
export async function discoverModels(client: ModelCatalogClient): Promise<readonly ModelCatalogEntry[]> {
  const models: ModelCatalogEntry[] = [];
  const seenModels = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
    const result = projectModelListResult(await client.listModels({ limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) }));
    for (const model of result.models) {
      if (seenModels.has(model.model)) throw new TypeError("duplicate catalog model");
      seenModels.add(model.model);
      models.push(model);
    }
    if (models.length > MAXIMUM_MODELS) throw new TypeError("model catalog exceeds limit");
    if (result.nextCursor === null) return Object.freeze(models);
    if (seenCursors.has(result.nextCursor)) throw new TypeError("model catalog pagination cycle");
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new TypeError("model catalog pagination exceeds limit");
}
