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

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function readOnce(filePath: string): Promise<WorkspaceMetadata> {
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
    return projectWorkspaceMetadata(value);
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceMetadata(
  filePath: string,
  options?: Partial<GlobalStateReaderOptions>,
): Promise<WorkspaceMetadata> {
  const sleep = options?.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await readOnce(filePath);
    } catch (error) {
      if (!(error instanceof ReplacementRaceError) || attempt === 2) throw error;
      await sleep(100);
    }
  }
  throw new Error("global-state read failed");
}
