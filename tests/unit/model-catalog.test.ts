import assert from "node:assert/strict";
import test from "node:test";

import { discoverModels, projectModelListResult } from "../../src/models/model-catalog.ts";

function model(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "picker-entry",
    model: "future-model-12",
    displayName: "Future Model 12",
    hidden: false,
    defaultReasoningEffort: "adaptive",
    supportedReasoningEfforts: [
      { reasoningEffort: "adaptive", description: "Adapts to the current problem" },
      { reasoningEffort: "ultra", description: "Thinks more deeply" },
      { reasoningEffort: "future-effort", description: "A newly introduced level" },
    ],
    isDefault: true,
    ...overrides,
  };
}

test("model discovery accepts future model and effort names and projects only picker metadata", () => {
  const result = projectModelListResult({
    data: [model({ secret: "PRIVATE", supportedReasoningEfforts: [
      { reasoningEffort: "adaptive", description: "Adapts", private: "PRIVATE" },
      { reasoningEffort: "ultra", description: "Deep" },
    ] }), model({ hidden: true })],
    nextCursor: null,
  });

  assert.deepEqual(result, {
    models: [{
      model: "future-model-12",
      displayName: "Future Model 12",
      defaultReasoningEffort: "adaptive",
      supportedReasoningEfforts: [
        { reasoningEffort: "adaptive", description: "Adapts" },
        { reasoningEffort: "ultra", description: "Deep" },
      ],
      isDefault: true,
    }],
    nextCursor: null,
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.models), true);
  assert.equal(Object.isFrozen(result.models[0]), true);
  assert.equal(Object.isFrozen(result.models[0]?.supportedReasoningEfforts), true);
  assert.equal(Object.isFrozen(result.models[0]?.supportedReasoningEfforts[0]), true);
});

test("discovery preserves server order across pages and uses the canonical model rather than picker id", async () => {
  const requests: unknown[] = [];
  const pages = [
    { data: [model()], nextCursor: "page-two" },
    { data: [model({ model: "future-model-13", isDefault: false })], nextCursor: null },
  ];
  const result = await discoverModels({
    listModels: async (input) => { requests.push(input); return pages.shift(); },
  });

  assert.deepEqual(requests, [{ limit: 100 }, { limit: 100, cursor: "page-two" }]);
  assert.deepEqual(result.map((entry) => entry.model), ["future-model-12", "future-model-13"]);
  assert.equal(Object.isFrozen(result), true);
});

test("an absent cursor ends the catalog and empty effort lists remain server-owned", async () => {
  assert.deepEqual(await discoverModels({ listModels: async () => ({ data: [] }) }), []);
  const result = projectModelListResult({ data: [model({ supportedReasoningEfforts: [] })] });
  assert.deepEqual(result.models[0]?.supportedReasoningEfforts, []);
  assert.equal(result.nextCursor, null);
});

test("malformed catalog fields are rejected without selecting a made-up fallback", () => {
  const invalidModels = [
    null,
    model({ model: "" }),
    model({ model: " has spaces " }),
    model({ displayName: "\u0000bad" }),
    model({ isDefault: "true" }),
    model({ hidden: "false" }),
    model({ defaultReasoningEffort: " " }),
    model({ supportedReasoningEfforts: null }),
    model({ supportedReasoningEfforts: [{ reasoningEffort: "future-effort", description: 1 }] }),
    model({ supportedReasoningEfforts: [
      { reasoningEffort: "future-effort", description: "One" },
      { reasoningEffort: "future-effort", description: "Duplicate" },
    ] }),
  ];
  for (const entry of invalidModels) {
    assert.throws(() => projectModelListResult({ data: [entry], nextCursor: null }), TypeError);
  }
  for (const value of [null, [], {}, { data: {} }, { data: [], nextCursor: 1 }, { data: [], nextCursor: "" }]) {
    assert.throws(() => projectModelListResult(value), TypeError);
  }
});

test("pagination cycles and duplicate canonical models reject an incomplete discovery", async () => {
  await assert.rejects(discoverModels({
    listModels: async () => ({ data: [], nextCursor: "repeated" }),
  }), /pagination cycle/);
  const pages = [
    { data: [model()], nextCursor: "next" },
    { data: [model()], nextCursor: null },
  ];
  await assert.rejects(discoverModels({ listModels: async () => pages.shift() }), /duplicate catalog model/);
});

test("an endless model catalog is bounded and request failures propagate", async () => {
  let calls = 0;
  await assert.rejects(discoverModels({
    listModels: async () => ({ data: [], nextCursor: `page-${String(++calls)}` }),
  }), /pagination exceeds limit/);
  assert.equal(calls, 20);
  const failure = new Error("unavailable");
  await assert.rejects(discoverModels({ listModels: async () => { throw failure; } }), (error: unknown) => error === failure);
});

test("oversized models, effort options and catalogs are bounded", async () => {
  assert.throws(() => projectModelListResult({ data: [model({ model: "x".repeat(257) })] }), /identifier/);
  assert.throws(() => projectModelListResult({ data: [model({ supportedReasoningEfforts: Array.from(
    { length: 65 }, (_, index) => ({ reasoningEffort: `effort-${String(index)}`, description: "" }),
  ) })] }), /reasoning efforts/);
  let page = 0;
  await assert.rejects(discoverModels({
    listModels: async () => {
      const current = page++;
      return {
        data: Array.from({ length: 100 }, (_, index) => model({ model: `model-${String(current * 100 + index)}` })),
        nextCursor: `page-${String(page)}`,
      };
    },
  }), /catalog exceeds limit/);
});
