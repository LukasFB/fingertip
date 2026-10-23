import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskId } from "../../src/catalog/catalog-projection.ts";
import { projectReadStateTokens } from "../../src/catalog/read-state-invalidation.ts";

const id = parseTaskId("00000000-0000-4000-8000-000000000077");
const state = (hosts: unknown) => ({
  "electron-thread-read-state-v1": { version: 1, unreadByIdentity: hosts },
});

test("read-state tokens detect scope changes without selecting an account or exposing its identifiers", () => {
  const before = projectReadStateTokens(state({ account: { local: [id], remote: [id] } }));
  const reordered = projectReadStateTokens(state({ account: { remote: [id], local: [id] } }));
  const after = projectReadStateTokens(state({ account: { local: [], remote: [id] } }));
  assert.deepEqual(before, reordered);
  assert.notEqual(before?.get(id), after?.get(id));
  assert.match(before?.get(id) ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(projectReadStateTokens(state({ account: { local: [] } }))?.size, 0);
  assert.notEqual(before?.get(id), projectReadStateTokens(state({ other: { local: [id] } }))?.get(id));
});

test("missing, future or malformed read-state data is unavailable rather than all-read", () => {
  for (const value of [{}, state(null), state({ account: { local: ["invalid"] } }),
    { "electron-thread-read-state-v1": { version: 2, unreadByIdentity: {} } }]) {
    assert.equal(projectReadStateTokens(value), undefined);
  }
});
