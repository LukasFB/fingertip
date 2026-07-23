import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeVoiceInputSettings,
  voiceInputSettingsNeedWriteback,
} from "../../src/settings/voice-input-settings.ts";

test("Voice Input defaults to toggle and accepts hold per key", () => {
  assert.deepEqual(normalizeVoiceInputSettings(undefined), { version: 1, mode: "toggle" });
  assert.deepEqual(normalizeVoiceInputSettings({ mode: "hold" }), { version: 1, mode: "hold" });
  assert.deepEqual(normalizeVoiceInputSettings({ mode: "invalid" }), { version: 1, mode: "toggle" });
});

test("only exact Voice Input settings avoid writeback", () => {
  assert.equal(voiceInputSettingsNeedWriteback({ version: 1, mode: "toggle" }), false);
  assert.equal(voiceInputSettingsNeedWriteback({ version: 1, mode: "hold" }), false);
  assert.equal(voiceInputSettingsNeedWriteback({ version: 2, mode: "hold" }), true);
  assert.equal(voiceInputSettingsNeedWriteback({ version: 1, mode: "hold", extra: true }), true);
});
