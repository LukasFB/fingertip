export interface TaskChangeStats {
  readonly added: number;
  readonly deleted: number;
  readonly files: number;
}

const MAXIMUM_DIFF_BYTES = 1_000_000;
const MAXIMUM_ITEMS = 10_000;
const MAXIMUM_CHANGES = 10_000;
const MAXIMUM_STAT = 1_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addWithinBounds(total: number, increment: number): number | null {
  if (increment < 0 || total + increment > MAXIMUM_STAT) return null;
  return total + increment;
}

function countUnifiedDiff(diff: string): Pick<TaskChangeStats, "added" | "deleted"> | null {
  if (Buffer.byteLength(diff, "utf8") > MAXIMUM_DIFF_BYTES) return null;
  let added = 0;
  let deleted = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) deleted += 1;
  }
  return added > MAXIMUM_STAT || deleted > MAXIMUM_STAT ? null : { added, deleted };
}

/**
 * Reduces only the App Server's successful `fileChange` records for one
 * thread. It intentionally does not inspect the shared Git worktree.
 */
export function projectTaskChangeStats(value: unknown): TaskChangeStats | null {
  if (!isRecord(value) || !isRecord(value.thread) || !Array.isArray(value.thread.turns)
    || value.thread.turns.length > MAXIMUM_ITEMS) return null;

  let added = 0;
  let deleted = 0;
  const files = new Set<string>();
  let itemCount = 0;
  let changeCount = 0;

  for (const turn of value.thread.turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items) || turn.items.length > MAXIMUM_ITEMS) return null;
    for (const item of turn.items) {
      itemCount += 1;
      if (itemCount > MAXIMUM_ITEMS || !isRecord(item)) return null;
      if (item.type !== "fileChange") continue;
      if (!Array.isArray(item.changes) || item.changes.length > MAXIMUM_CHANGES) return null;
      for (const change of item.changes) {
        changeCount += 1;
        if (changeCount > MAXIMUM_CHANGES || !isRecord(change)
          || typeof change.path !== "string" || change.path.length === 0
          || Buffer.byteLength(change.path, "utf8") > 4_096 || typeof change.diff !== "string") return null;
        const counts = countUnifiedDiff(change.diff);
        if (counts === null) return null;
        const nextAdded = addWithinBounds(added, counts.added);
        const nextDeleted = addWithinBounds(deleted, counts.deleted);
        if (nextAdded === null || nextDeleted === null) return null;
        added = nextAdded;
        deleted = nextDeleted;
        files.add(change.path);
      }
    }
  }

  return Object.freeze({ added, deleted, files: files.size });
}
