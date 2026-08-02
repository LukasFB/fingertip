(() => {
  "use strict";

  let websocket;
  let context;
  let action;
  const localDefaults = Object.freeze({
    version: 9,
    taskPosition: 1,
    taskSource: "pinned-projects",
    moveActiveUnreadThreadsToTop: false,
  });
  const appearanceDefaults = Object.freeze({
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
  let localSettings = { ...localDefaults };
  let appearance = { ...appearanceDefaults };
  const stateListeners = new Set();
  const settingsListeners = new Set();

  function parse(value) {
    try { return JSON.parse(value); } catch { return {}; }
  }

  function normalizedLocal(value) {
    const source = value && typeof value === "object" ? value : {};
    const taskPosition = Number.isInteger(source.taskPosition) && source.taskPosition >= 1 && source.taskPosition <= 99
      ? source.taskPosition : localDefaults.taskPosition;
    const taskSource = source.taskSource === "tasks" ? "tasks" : "pinned-projects";
    return {
      version: 9,
      taskPosition,
      taskSource,
      moveActiveUnreadThreadsToTop: source.moveActiveUnreadThreadsToTop === true
        || (source.moveActiveUnreadThreadsToTop === undefined && source.skipSettledProjectTasks === true),
    };
  }

  function normalizedAppearance(value) {
    const source = value && typeof value === "object" ? value : {};
    const integer = (key, minimum, maximum) => Number.isInteger(source[key])
      && source[key] >= minimum && source[key] <= maximum ? source[key] : appearanceDefaults[key];
    const color = (key) => typeof source[key] === "string" && /^#[0-9a-f]{6}$/i.test(source[key])
      ? source[key].toLowerCase() : appearanceDefaults[key];
    const normalizedIdle = color("idleColor");
    const normalizedConfirmation = color("confirmationColor");
    const notificationMode = (key) => source[key] === "toast"
      || source[key] === "sound"
      || source[key] === "both"
      ? source[key] : "off";
    const systemSounds = [
      "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero",
      "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
    ];
    const notificationSound = (key) => systemSounds.includes(source[key])
      ? source[key] : appearanceDefaults[key];
    const notificationSoundSource = (key, legacySoundKey) => source[key] === "custom"
      || source[legacySoundKey] === "custom" ? "custom" : "system";
    return {
      version: 13,
      windowTarget: source.windowTarget === "leftmost" || source.windowTarget === "rightmost"
        ? source.windowTarget : "last-active",
      titleFontSize: integer("titleFontSize", 8, 12),
      projectFontSize: integer("projectFontSize", 6, 12),
      timeFontSize: integer("timeFontSize", 5, 10),
      textAlignment: source.textAlignment === "center" || source.textAlignment === "right"
        ? source.textAlignment : "left",
      borderEnabled: typeof source.borderEnabled === "boolean" ? source.borderEnabled : true,
      projectColorEnabled: source.projectColorEnabled === true,
      projectColorOpacity: integer("projectColorOpacity", 0, 100),
      showGitDiffStats: source.showGitDiffStats === true,
      showQueueBadge: source.showQueueBadge === true,
      showGoalBadge: source.showGoalBadge === true,
      badgePosition: ["top-right", "top-left", "bottom-left", "bottom-right", "bottom-replaces-git"].includes(source.badgePosition)
        ? source.badgePosition : "top-right",
      badgeFontSize: integer("badgeFontSize", 8, 18),
      idleColor: source.version === 1 && normalizedIdle === "#343842" ? appearanceDefaults.idleColor : normalizedIdle,
      workingColor: color("workingColor"),
      doneColor: color("doneColor"),
      waitingColor: color("waitingColor"),
      confirmationColor: Number.isInteger(source.version)
        && source.version <= 7
        && normalizedConfirmation === "#ff7373"
        ? appearanceDefaults.confirmationColor : normalizedConfirmation,
      doneNotification: notificationMode("doneNotification"),
      doneSoundSource: notificationSoundSource("doneSoundSource", "doneSound"),
      doneSound: notificationSound("doneSound"),
      doneVolume: integer("doneVolume", 0, 400),
      doneRepeat: integer("doneRepeat", 1, 10),
      doneRepeatDelayMs: integer("doneRepeatDelayMs", 25, 1000),
      confirmationNotification: notificationMode("confirmationNotification"),
      confirmationSoundSource: notificationSoundSource("confirmationSoundSource", "confirmationSound"),
      confirmationSound: notificationSound("confirmationSound"),
      confirmationVolume: integer("confirmationVolume", 0, 400),
      confirmationRepeat: integer("confirmationRepeat", 1, 10),
      confirmationRepeatDelayMs: integer("confirmationRepeatDelayMs", 25, 1000),
    };
  }

  function notifySettings() {
    const combined = { ...localSettings, ...appearance };
    for (const listener of settingsListeners) listener(combined);
  }

  function send(message) {
    if (websocket && websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(message));
  }

  window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, info, actionInfo) => {
    context = uuid;
    const parsedAction = parse(actionInfo);
    action = parsedAction.action;
    localSettings = normalizedLocal(parsedAction.payload?.settings);
    notifySettings();
    websocket = new WebSocket(`ws://127.0.0.1:${port}`);
    websocket.addEventListener("open", () => {
      send({ event: registerEvent, uuid });
      send({ event: "getGlobalSettings", context });
    });
    websocket.addEventListener("message", (event) => {
      const message = parse(event.data);
      if (message.event === "didReceiveSettings") {
        localSettings = normalizedLocal(message.payload?.settings);
        notifySettings();
      } else if (message.event === "didReceiveGlobalSettings") {
        appearance = normalizedAppearance(message.payload?.settings);
        notifySettings();
      } else if (message.event === "sendToPropertyInspector") {
        for (const listener of stateListeners) listener(message.payload);
      }
    });
  };

  window.FingertipPI = Object.freeze({
    onSettings(listener) { settingsListeners.add(listener); listener({ ...localSettings, ...appearance }); },
    onState(listener) { stateListeners.add(listener); },
    setSetting(key, value) {
      if (key === "taskPosition" || key === "taskSource" || key === "moveActiveUnreadThreadsToTop") {
        localSettings = normalizedLocal({ ...localSettings, [key]: value });
        send({ event: "setSettings", context, payload: localSettings });
      } else {
        appearance = normalizedAppearance({ ...appearance, [key]: value });
        send({ event: "setGlobalSettings", context, payload: appearance });
      }
      notifySettings();
    },
    resetAppearance() {
      appearance = {
        ...appearanceDefaults,
        windowTarget: appearance.windowTarget,
        doneNotification: appearance.doneNotification,
        doneSoundSource: appearance.doneSoundSource,
        doneSound: appearance.doneSound,
        doneVolume: appearance.doneVolume,
        doneRepeat: appearance.doneRepeat,
        doneRepeatDelayMs: appearance.doneRepeatDelayMs,
        confirmationNotification: appearance.confirmationNotification,
        confirmationSoundSource: appearance.confirmationSoundSource,
        confirmationSound: appearance.confirmationSound,
        confirmationVolume: appearance.confirmationVolume,
        confirmationRepeat: appearance.confirmationRepeat,
        confirmationRepeatDelayMs: appearance.confirmationRepeatDelayMs,
      };
      send({ event: "setGlobalSettings", context, payload: appearance });
      notifySettings();
    },
    importCustomSound(status) {
      send({
        action,
        event: "sendToPlugin",
        context,
        payload: { command: "import-custom-sound", status },
      });
    },
    previewSound(status) {
      send({
        action,
        event: "sendToPlugin",
        context,
        payload: { command: "preview-sound", status },
      });
    },
    retry() {
      send({ action, event: "sendToPlugin", context, payload: { command: "retry-now" } });
    },
  });
})();
