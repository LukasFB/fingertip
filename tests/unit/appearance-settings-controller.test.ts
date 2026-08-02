import assert from "node:assert/strict";
import test from "node:test";

import { AppearanceSettingsController } from "../../src/settings/appearance-settings-controller.ts";
import type { TaskKeyAppearanceSettings } from "../../src/settings/task-key-settings.ts";

const legacy = {
  version: 2,
  taskPosition: 2,
  titleFontSize: 11,
  idleColor: "#111111",
  workingColor: "#222222",
  doneColor: "#333333",
  waitingColor: "#444444",
  confirmationColor: "#555555",
};

test("an existing global appearance is applied and wins over legacy key settings", async () => {
  const applied: TaskKeyAppearanceSettings[] = [];
  const written: TaskKeyAppearanceSettings[] = [];
  const controller = new AppearanceSettingsController({
    apply: (settings) => applied.push(settings),
    write: async (settings) => { written.push(settings); },
  });

  controller.offerLegacy(legacy);
  await controller.load({
    version: 13,
    windowTarget: "rightmost",
    titleFontSize: 11,
    projectFontSize: 9,
    timeFontSize: 7,
    textAlignment: "center",
    borderEnabled: false,
    projectColorEnabled: false,
    projectColorOpacity: 60,
    showGitDiffStats: true,
    showQueueBadge: false,
    showGoalBadge: false,
    badgePosition: "top-right",
    badgeFontSize: 15,
    idleColor: "#111111",
    workingColor: "#222222",
    doneColor: "#333333",
    waitingColor: "#444444",
    confirmationColor: "#555555",
    doneNotification: "off",
    doneSoundSource: "system",
    doneSound: "Glass",
    doneVolume: 100,
    doneRepeat: 1,
    doneRepeatDelayMs: 250,
    confirmationNotification: "off",
    confirmationSoundSource: "system",
    confirmationSound: "Basso",
    confirmationVolume: 100,
    confirmationRepeat: 1,
    confirmationRepeatDelayMs: 250,
  });

  assert.equal(applied.at(-1)?.projectFontSize, 9);
  assert.equal(applied.at(-1)?.idleColor, "#111111");
  assert.equal(applied.at(-1)?.windowTarget, "rightmost");
  assert.equal(applied.at(-1)?.showGitDiffStats, true);
  assert.deepEqual(written, []);
});

test("enabled V6 per-key badges migrate into an older shared appearance", async () => {
  const applied: TaskKeyAppearanceSettings[] = [];
  const written: TaskKeyAppearanceSettings[] = [];
  const controller = new AppearanceSettingsController({
    apply: (settings) => applied.push(settings),
    write: async (settings) => { written.push(settings); },
  });

  await controller.offerLegacyBadges({
    version: 6,
    showQueueBadge: true,
    showGoalBadge: true,
    badgePosition: "bottom-right",
  });
  await controller.load({ version: 5, titleFontSize: 11 });

  assert.equal(applied.at(-1)?.showQueueBadge, true);
  assert.equal(applied.at(-1)?.showGoalBadge, true);
  assert.equal(applied.at(-1)?.badgePosition, "bottom-right");
  assert.equal(written.at(-1)?.badgePosition, "bottom-right");
});

test("enabled V6 per-key badges still migrate after shared defaults were normalized", async () => {
  const written: TaskKeyAppearanceSettings[] = [];
  const controller = new AppearanceSettingsController({
    apply: () => undefined,
    write: async (settings) => { written.push(settings); },
  });

  await controller.load({
    version: 6,
    showQueueBadge: false,
    showGoalBadge: false,
    badgePosition: "top-right",
  });
  await controller.offerLegacyBadges({
    version: 6,
    showQueueBadge: true,
    showGoalBadge: true,
    badgePosition: "top-right",
  });

  assert.equal(written.at(-1)?.showQueueBadge, true);
  assert.equal(written.at(-1)?.showGoalBadge, true);
});

test("the first legacy key seeds empty global settings after initial load", async () => {
  const applied: TaskKeyAppearanceSettings[] = [];
  const written: TaskKeyAppearanceSettings[] = [];
  const controller = new AppearanceSettingsController({
    apply: (settings) => applied.push(settings),
    write: async (settings) => { written.push(settings); },
  });

  controller.offerLegacy(legacy);
  controller.offerLegacy({ ...legacy, titleFontSize: 8 });
  await controller.load({});

  assert.equal(applied.at(-1)?.titleFontSize, 11);
  assert.equal(written.length, 1);
  assert.deepEqual(written[0], applied.at(-1));
});

test("a legacy key appearing after an empty load can still seed settings", async () => {
  const written: TaskKeyAppearanceSettings[] = [];
  const controller = new AppearanceSettingsController({
    apply: () => undefined,
    write: async (settings) => { written.push(settings); },
  });

  await controller.load({});
  await controller.offerLegacy(legacy);

  assert.equal(written.length, 1);
});

test("later Stream Deck global updates are normalized and applied", async () => {
  const applied: TaskKeyAppearanceSettings[] = [];
  const written: TaskKeyAppearanceSettings[] = [];
  const controller = new AppearanceSettingsController({
    apply: (settings) => applied.push(settings),
    write: async (settings) => { written.push(settings); },
  });
  await controller.load({});

  await controller.receive({
    titleFontSize: 12,
    projectFontSize: 7,
    timeFontSize: 8,
    textAlignment: "right",
    borderEnabled: false,
    showGitDiffStats: true,
    idleColor: "#ABCDEF",
  });

  assert.equal(applied.at(-1)?.titleFontSize, 12);
  assert.equal(applied.at(-1)?.projectFontSize, 7);
  assert.equal(applied.at(-1)?.timeFontSize, 8);
  assert.equal(applied.at(-1)?.textAlignment, "right");
  assert.equal(applied.at(-1)?.borderEnabled, false);
  assert.equal(applied.at(-1)?.showGitDiffStats, true);
  assert.equal(applied.at(-1)?.idleColor, "#abcdef");
  assert.deepEqual(written.at(-1), applied.at(-1));
});
