(() => {
  "use strict";

  let websocket;
  let context;
  let action;
  const localDefaults = Object.freeze({
    version: 7,
    taskPosition: 1,
    taskSource: "pinned-projects",
  });
  const appearanceDefaults = Object.freeze({
    version: 8,
    windowTarget: "last-active",
    titleFontSize: 10,
    projectFontSize: 8,
    timeFontSize: 6,
    textAlignment: "left",
    borderEnabled: true,
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
      version: 7,
      taskPosition,
      taskSource,
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
    return {
      version: 8,
      windowTarget: source.windowTarget === "leftmost" || source.windowTarget === "rightmost"
        ? source.windowTarget : "last-active",
      titleFontSize: integer("titleFontSize", 8, 12),
      projectFontSize: integer("projectFontSize", 6, 12),
      timeFontSize: integer("timeFontSize", 5, 10),
      textAlignment: source.textAlignment === "center" || source.textAlignment === "right"
        ? source.textAlignment : "left",
      borderEnabled: typeof source.borderEnabled === "boolean" ? source.borderEnabled : true,
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
      if (key === "taskPosition" || key === "taskSource") {
        localSettings = normalizedLocal({ ...localSettings, [key]: value });
        send({ event: "setSettings", context, payload: localSettings });
      } else {
        appearance = normalizedAppearance({ ...appearance, [key]: value });
        send({ event: "setGlobalSettings", context, payload: appearance });
      }
      notifySettings();
    },
    resetAppearance() {
      appearance = { ...appearanceDefaults, windowTarget: appearance.windowTarget };
      send({ event: "setGlobalSettings", context, payload: appearance });
      notifySettings();
    },
    retry() {
      send({ action, event: "sendToPlugin", context, payload: { command: "retry-now" } });
    },
  });
})();
