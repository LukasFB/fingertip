import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyTaskKeyBadgeAppearance,
  legacyTaskKeyAppearance,
  normalizeTaskKeyAppearanceSettings,
  normalizeTaskKeySettings,
  taskKeyAppearanceSettingsNeedWriteback,
  taskKeySettingsNeedWriteback,
} from "../../src/settings/task-key-settings.ts";

test("missing Task Key settings use the documented defaults", () => {
  assert.deepEqual(normalizeTaskKeySettings(undefined), {
    version: 9,
    taskPosition: 1,
    taskSource: "pinned-projects",
    moveActiveUnreadThreadsToTop: false,
  });
});

test("Task Position is preserved while former per-key appearance fields are discarded", () => {
  assert.deepEqual(
    normalizeTaskKeySettings({ version: 2, taskPosition: 99, titleFontSize: 8, idleColor: "#abcdef" }),
    {
      version: 9,
      taskPosition: 99,
      taskSource: "pinned-projects",
      moveActiveUnreadThreadsToTop: false,
    },
  );
});

test("invalid Task Positions use the default independently", () => {
  for (const value of [null, "2", 0, 100, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizeTaskKeySettings({ taskPosition: value }).taskPosition, 1);
  }
  assert.equal(normalizeTaskKeySettings({ taskPosition: 42 }).taskPosition, 42);
  assert.equal(normalizeTaskKeySettings({ taskSource: "tasks" }).taskSource, "tasks");
  assert.equal(normalizeTaskKeySettings({ taskSource: "unknown" }).taskSource, "pinned-projects");
  assert.equal(normalizeTaskKeySettings({ moveActiveUnreadThreadsToTop: true }).moveActiveUnreadThreadsToTop, true);
  assert.equal(normalizeTaskKeySettings({ moveActiveUnreadThreadsToTop: "true" }).moveActiveUnreadThreadsToTop, false);
});

test("only exact normalized local settings avoid a writeback", () => {
  const exact = { ...normalizeTaskKeySettings(undefined), taskPosition: 2 };
  assert.equal(taskKeySettingsNeedWriteback(exact), false);
  assert.equal(taskKeySettingsNeedWriteback({ version: 2, taskPosition: 2 }), true);
  assert.equal(taskKeySettingsNeedWriteback({ ...exact, extra: true }), true);
});

test("the former settled-project setting migrates to active and unread ordering", () => {
  const migrated = normalizeTaskKeySettings({
    version: 8,
    taskPosition: 2,
    taskSource: "pinned-projects",
    skipSettledProjectTasks: true,
  });
  assert.equal(migrated.moveActiveUnreadThreadsToTop, true);
  assert.equal(taskKeySettingsNeedWriteback({
    version: 8,
    taskPosition: 2,
    taskSource: "pinned-projects",
    skipSettledProjectTasks: true,
  }), true);
});

test("missing global appearance uses quiet idle and Codex Micro status colors", () => {
  assert.deepEqual(normalizeTaskKeyAppearanceSettings(undefined), {
    version: 13,
    windowTarget: "last-active",
    titleFontSize: 10,
    projectFontSize: 8,
    timeFontSize: 6,
    textAlignment: "left",
    borderEnabled: true,
    projectColorEnabled: false,
    projectColorOpacity: 60,
    showGitDiffStats: false,
    showQueueBadge: false,
    showGoalBadge: false,
    badgePosition: "top-right",
    badgeFontSize: 15,
    idleColor: "#06090b",
    workingColor: "#9cd5fe",
    doneColor: "#9bf396",
    waitingColor: "#ffd0b8",
    confirmationColor: "#ffad28",
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
});

test("global font sizes and colors are normalized independently", () => {
  assert.deepEqual(
    normalizeTaskKeyAppearanceSettings({
      windowTarget: "rightmost",
      titleFontSize: 12,
      projectFontSize: 6,
      timeFontSize: 9,
      textAlignment: "right",
      borderEnabled: false,
      idleColor: "#AABBCC",
      workingColor: "#123456",
      doneColor: "white",
      waitingColor: "#abcd",
      confirmationColor: "#fedcba",
    }),
    {
      version: 13,
      windowTarget: "rightmost",
      titleFontSize: 12,
      projectFontSize: 6,
      timeFontSize: 9,
      textAlignment: "right",
      borderEnabled: false,
      projectColorEnabled: false,
      projectColorOpacity: 60,
      showGitDiffStats: false,
      showQueueBadge: false,
      showGoalBadge: false,
      badgePosition: "top-right",
      badgeFontSize: 15,
      idleColor: "#aabbcc",
      workingColor: "#123456",
      doneColor: "#9bf396",
      waitingColor: "#ffd0b8",
      confirmationColor: "#fedcba",
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
    },
  );
  assert.equal(normalizeTaskKeyAppearanceSettings({ titleFontSize: 13 }).titleFontSize, 10);
  assert.equal(normalizeTaskKeyAppearanceSettings({ projectFontSize: 13 }).projectFontSize, 8);
  assert.equal(normalizeTaskKeyAppearanceSettings({ timeFontSize: 11 }).timeFontSize, 6);
  assert.equal(normalizeTaskKeyAppearanceSettings({ badgeFontSize: 18 }).badgeFontSize, 18);
  assert.equal(normalizeTaskKeyAppearanceSettings({ badgeFontSize: 19 }).badgeFontSize, 15);
  assert.equal(normalizeTaskKeyAppearanceSettings({ textAlignment: "justify" }).textAlignment, "left");
  assert.equal(normalizeTaskKeyAppearanceSettings({ borderEnabled: "false" }).borderEnabled, true);
  assert.equal(normalizeTaskKeyAppearanceSettings({ projectColorEnabled: true }).projectColorEnabled, true);
  assert.equal(normalizeTaskKeyAppearanceSettings({ projectColorOpacity: 0 }).projectColorOpacity, 0);
  assert.equal(normalizeTaskKeyAppearanceSettings({ projectColorOpacity: 100 }).projectColorOpacity, 100);
  assert.equal(normalizeTaskKeyAppearanceSettings({ projectColorOpacity: 101 }).projectColorOpacity, 60);
  assert.equal(normalizeTaskKeyAppearanceSettings({ showGitDiffStats: true }).showGitDiffStats, true);
  assert.equal(normalizeTaskKeyAppearanceSettings({ showGitDiffStats: "true" }).showGitDiffStats, false);
  assert.equal(normalizeTaskKeyAppearanceSettings({ showQueueBadge: true }).showQueueBadge, true);
  assert.equal(normalizeTaskKeyAppearanceSettings({ showGoalBadge: true }).showGoalBadge, true);
  for (const value of ["top-right", "top-left", "bottom-left", "bottom-right", "bottom-replaces-git"] as const) {
    assert.equal(normalizeTaskKeyAppearanceSettings({ badgePosition: value }).badgePosition, value);
  }
  assert.equal(normalizeTaskKeyAppearanceSettings({ windowTarget: "leftmost" }).windowTarget, "leftmost");
  assert.equal(normalizeTaskKeyAppearanceSettings({ windowTarget: "middle" }).windowTarget, "last-active");
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneNotification: "toast" }).doneNotification, "toast");
  assert.equal(normalizeTaskKeyAppearanceSettings({ confirmationNotification: "sound" }).confirmationNotification, "sound");
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneNotification: "both" }).doneNotification, "both");
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneNotification: "invalid" }).doneNotification, "off");
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneSound: "Ping" }).doneSound, "Ping");
  assert.equal(normalizeTaskKeyAppearanceSettings({ confirmationSound: "custom" }).confirmationSoundSource, "custom");
  assert.equal(normalizeTaskKeyAppearanceSettings({ confirmationSound: "custom" }).confirmationSound, "Basso");
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneSoundSource: "custom" }).doneSoundSource, "custom");
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneVolume: 42 }).doneVolume, 42);
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneVolume: 401 }).doneVolume, 100);
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneRepeat: 10 }).doneRepeat, 10);
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneRepeat: 11 }).doneRepeat, 1);
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneRepeatDelayMs: 1000 }).doneRepeatDelayMs, 1000);
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneRepeatDelayMs: 24 }).doneRepeatDelayMs, 250);
  assert.equal(normalizeTaskKeyAppearanceSettings({ doneSound: "Nope" }).doneSound, "Glass");
});

test("only exact normalized global appearance avoids a writeback", () => {
  const exact = normalizeTaskKeyAppearanceSettings(undefined);
  assert.equal(taskKeyAppearanceSettingsNeedWriteback(exact), false);
  assert.equal(taskKeyAppearanceSettingsNeedWriteback({ ...exact, version: 2 }), true);
  assert.equal(taskKeyAppearanceSettingsNeedWriteback({ ...exact, extra: true }), true);
});

test("the former approval default migrates to orange while custom confirmation colors survive", () => {
  assert.equal(normalizeTaskKeyAppearanceSettings({
    version: 7,
    confirmationColor: "#ff7373",
  }).confirmationColor, "#ffad28");
  assert.equal(normalizeTaskKeyAppearanceSettings({
    version: 7,
    confirmationColor: "#123456",
  }).confirmationColor, "#123456");
  assert.equal(normalizeTaskKeyAppearanceSettings({
    version: 8,
    confirmationColor: "#ff7373",
  }).confirmationColor, "#ff7373");
});

test("the former V1 idle default migrates darker while custom colors survive", () => {
  assert.equal(normalizeTaskKeyAppearanceSettings({ version: 1, idleColor: "#343842" }).idleColor, "#06090b");
  assert.equal(normalizeTaskKeyAppearanceSettings({ version: 1, idleColor: "#112233" }).idleColor, "#112233");
  assert.equal(normalizeTaskKeyAppearanceSettings({ version: 3, idleColor: "#343842" }).idleColor, "#343842");
});

test("legacy per-key appearance can seed the central appearance once", () => {
  assert.deepEqual(
    legacyTaskKeyAppearance({
      version: 2,
      taskPosition: 4,
      titleFontSize: 11,
      idleColor: "#111111",
      workingColor: "#222222",
      doneColor: "#333333",
      waitingColor: "#444444",
      confirmationColor: "#555555",
    }),
    {
      version: 13,
      windowTarget: "last-active",
      titleFontSize: 11,
      projectFontSize: 8,
      timeFontSize: 6,
      textAlignment: "left",
      borderEnabled: true,
      projectColorEnabled: false,
      projectColorOpacity: 60,
      showGitDiffStats: false,
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
    },
  );
  assert.equal(legacyTaskKeyAppearance({ version: 4, taskPosition: 4 }), null);
  assert.equal(legacyTaskKeyAppearance(undefined), null);
});

test("V6 per-key badges can migrate once into shared appearance", () => {
  assert.deepEqual(legacyTaskKeyBadgeAppearance({
    version: 6,
    taskPosition: 2,
    taskSource: "pinned-projects",
    showQueueBadge: true,
    showGoalBadge: true,
    badgePosition: "bottom-right",
  }), {
    showQueueBadge: true,
    showGoalBadge: true,
    badgePosition: "bottom-right",
  });
  assert.equal(legacyTaskKeyBadgeAppearance({
    version: 6,
    showQueueBadge: false,
    showGoalBadge: false,
    badgePosition: "top-right",
  }), null);
});
