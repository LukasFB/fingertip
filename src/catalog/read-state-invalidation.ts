import { createHash } from "node:crypto";

import { parseTaskId, type TaskId } from "./catalog-projection.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// These are invalidation tokens, NOT read-state values. Account/host selection
// belongs to the desktop app; a changed token only asks its owner for a snapshot.
export function projectReadStateTokens(value: unknown): ReadonlyMap<TaskId, string> | undefined {
  if (!isRecord(value)) return undefined;
  const state = value["electron-thread-read-state-v1"];
  if (!isRecord(state) || state.version !== 1 || !isRecord(state.unreadByIdentity)) return undefined;
  const memberships = new Map<TaskId, Set<string>>();
  let count = 0;
  for (const [identity, hosts] of Object.entries(state.unreadByIdentity)) {
    if (!isRecord(hosts)) return undefined;
    for (const [host, ids] of Object.entries(hosts)) {
      if (!Array.isArray(ids) || (count += ids.length) > 100_000) return undefined;
      const scope = createHash("sha256").update(JSON.stringify([identity, host])).digest("hex");
      for (const candidate of ids) {
        let id: TaskId;
        try { id = parseTaskId(candidate); } catch { return undefined; }
        const scopes = memberships.get(id) ?? new Set<string>();
        scopes.add(scope);
        memberships.set(id, scopes);
      }
    }
  }
  return new Map([...memberships].map(([id, scopes]) => [id,
    createHash("sha256").update(JSON.stringify([...scopes].sort())).digest("hex"),
  ]));
}
