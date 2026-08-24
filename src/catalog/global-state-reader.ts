import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { projectWorkspaceMetadata, type WorkspaceMetadata } from "./project-label-resolver.ts";

// ChatGPT stores auxiliary UI state and queued follow-up contents alongside the
// small sidebar metadata projection consumed below. Those unrelated fields can
// legitimately push the owned state file beyond 4 MiB (ChatGPT 26.803 does so),
// so keep a bounded read while allowing enough headroom for the full JSON value.
const MAXIMUM_GLOBAL_STATE_BYTES = 16 * 1024 * 1024;

class ReplacementRaceError extends Error {}

interface GlobalStateReaderOptions {
  readonly sleep: (delayMs: number) => Promise<void>;
}

type GlobalStateProjection<T> = (value: unknown) => T;

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function readOnce<T>(filePath: string, project: GlobalStateProjection<T>): Promise<T> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > MAXIMUM_GLOBAL_STATE_BYTES) {
      throw new Error("invalid global-state file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new ReplacementRaceError("global-state changed while reading");
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new Error("invalid global-state JSON");
    }
    return project(value);
  } finally {
    await handle.close();
  }
}

async function readGlobalStateProjection<T>(
  filePath: string,
  project: GlobalStateProjection<T>,
  options?: Partial<GlobalStateReaderOptions>,
): Promise<T> {
  const sleep = options?.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await readOnce(filePath, project);
    } catch (error) {
      if (!(error instanceof ReplacementRaceError) || attempt === 2) throw error;
      await sleep(100);
    }
  }
  throw new Error("global-state read failed");
}

export function readWorkspaceMetadata(
  filePath: string,
  options?: Partial<GlobalStateReaderOptions>,
): Promise<WorkspaceMetadata> {
  return readGlobalStateProjection(filePath, projectWorkspaceMetadata, options);
}

export function readPersistedStringAtom(
  filePath: string,
  key: string,
  options?: Partial<GlobalStateReaderOptions>,
): Promise<string | null> {
  if (key.length === 0 || Buffer.byteLength(key, "utf8") > 128) {
    return Promise.reject(new TypeError("invalid persisted atom key"));
  }
  return readGlobalStateProjection(filePath, (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("global state must be an object");
    }
    const atoms = (value as Record<string, unknown>)["electron-persisted-atom-state"];
    if (typeof atoms !== "object" || atoms === null || Array.isArray(atoms)) return null;
    const candidate = (atoms as Record<string, unknown>)[key];
    return typeof candidate === "string" && Buffer.byteLength(candidate, "utf8") <= 128
      ? candidate
      : null;
  }, options);
}
