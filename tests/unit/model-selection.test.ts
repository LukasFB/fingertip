import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MODEL_EFFORTS,
  MODEL_FAMILIES,
  modelSelection,
  modelSelectionImagePath,
  modelSelectionMatches,
  normalizeModelSelection,
} from "../../src/models/model-selection.ts";

test("the selector exposes the approved 3 by 5 model matrix", () => {
  assert.deepEqual(MODEL_FAMILIES, ["sol", "terra", "luna"]);
  assert.deepEqual(MODEL_EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
  const matrix = MODEL_FAMILIES.flatMap((family) =>
    MODEL_EFFORTS.map((effort) => modelSelection(family, effort)));
  assert.equal(matrix.length, 15);
  assert.deepEqual(matrix[0], {
    family: "sol",
    model: "gpt-5.6-sol",
    effort: "low",
    modelLabel: "SOL",
    effortLabel: "LIGHT",
  });
  assert.equal(matrix.at(-1)?.effortLabel, "MAX");
  assert.equal(modelSelectionImagePath(matrix[6]!), "imgs/actions/model-options/terra-medium.png");
  assert.equal(modelSelectionImagePath(matrix[6]!, true),
    "imgs/actions/model-options/terra-medium-selected.png");
  assert.equal(modelSelectionMatches(matrix[6]!, {
    model: "gpt-5.6-terra",
    effort: "medium",
  }), true);
});

test("profile settings are validated before they can reach IPC", () => {
  assert.deepEqual(normalizeModelSelection({ family: "luna", effort: "high", private: "ignored" }),
    modelSelection("luna", "high"));
  assert.equal(normalizeModelSelection({ family: "mars", effort: "high" }), null);
  assert.equal(normalizeModelSelection({ family: "sol", effort: "ultra" }), null);
});

test("every model option ships with standard, selected, and high-resolution visuals", async () => {
  const selections = MODEL_FAMILIES.flatMap((family) =>
    MODEL_EFFORTS.map((effort) => modelSelection(family, effort)));
  await Promise.all(selections.flatMap((selection) => [false, true].map(async (selected) => {
    const path = `com.lukas-bhm.fingertip.sdPlugin/${modelSelectionImagePath(selection, selected)}`;
    const image = await readFile(path);
    assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(image.readUInt32BE(16), 144);
    assert.equal(image.readUInt32BE(20), 144);
    const highResolution = await readFile(path.replace(/\.png$/u, "@2x.png"));
    assert.equal(highResolution.readUInt32BE(16), 288);
    assert.equal(highResolution.readUInt32BE(20), 288);
  })));
});
