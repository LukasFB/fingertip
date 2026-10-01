import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL_KEY_SETTINGS,
  modelKeySettingsNeedWriteback,
  normalizeModelKeySettings,
} from "../../src/settings/model-key-settings.ts";

test("model keys remain unconfigured until the user chooses a model", () => {
  assert.deepEqual(normalizeModelKeySettings(undefined), {
    version: 1,
    model: "",
    effort: "",
    backgroundColor: "#06090b",
    modelFontSize: 10,
    effortFontSize: 9,
    textAlignment: "center",
  });
});

test("saved future models and thinking levels survive normalization without enum restrictions", () => {
  const settings = normalizeModelKeySettings({
    version: 1,
    model: "  future-model/v9  ",
    effort: "  adaptive-reasoning  ",
    backgroundColor: "#A1B2C3",
    modelFontSize: 14,
    effortFontSize: 6,
    textAlignment: "right",
  });
  assert.deepEqual(settings, {
    version: 1,
    model: "future-model/v9",
    effort: "adaptive-reasoning",
    backgroundColor: "#a1b2c3",
    modelFontSize: 14,
    effortFontSize: 6,
    textAlignment: "right",
  });
  assert.equal(modelKeySettingsNeedWriteback(settings), false);
  assert.equal(modelKeySettingsNeedWriteback({ ...settings, legacyField: true }), true);
});

test("invalid appearance settings cannot inject SVG attributes or exceed the layout bounds", () => {
  for (const input of [undefined, null, [], {
    model: 12,
    effort: false,
    backgroundColor: '#ffffff"/><script>',
    modelFontSize: 15,
    effortFontSize: 5.5,
    textAlignment: "outside",
  }]) {
    assert.deepEqual(normalizeModelKeySettings(input), DEFAULT_MODEL_KEY_SETTINGS);
    assert.equal(modelKeySettingsNeedWriteback(input), true);
  }
});
