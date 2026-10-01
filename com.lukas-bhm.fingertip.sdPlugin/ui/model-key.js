(() => {
  "use strict";

  const defaults = Object.freeze({
    version: 1,
    model: "",
    effort: "",
    backgroundColor: "#06090b",
    modelFontSize: 10,
    effortFontSize: 9,
    textAlignment: "center",
  });
  let websocket;
  let socketContext;
  let actionContext;
  let action;
  let settings = { ...defaults };
  let state;
  const settingsListeners = new Set();
  const stateListeners = new Set();

  function parse(value) {
    try { return JSON.parse(value); } catch { return {}; }
  }

  function normalize(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const size = (key) => Number.isInteger(source[key]) && source[key] >= 6 && source[key] <= 14
      ? source[key] : defaults[key];
    return {
      version: 1,
      model: typeof source.model === "string" ? source.model.trim() : "",
      effort: typeof source.effort === "string" ? source.effort.trim() : "",
      backgroundColor: typeof source.backgroundColor === "string" && /^#[0-9a-f]{6}$/i.test(source.backgroundColor)
        ? source.backgroundColor.toLowerCase() : defaults.backgroundColor,
      modelFontSize: size("modelFontSize"),
      effortFontSize: size("effortFontSize"),
      textAlignment: source.textAlignment === "left" || source.textAlignment === "right" ? source.textAlignment : "center",
    };
  }

  function notifySettings() {
    for (const listener of settingsListeners) listener({ ...settings });
  }

  function send(message) {
    if (websocket && websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(message));
  }

  function save(update) {
    settings = normalize({ ...settings, ...update });
    send({ event: "setSettings", context: socketContext, payload: settings });
    notifySettings();
  }

  function requestModels() {
    send({ action, event: "sendToPlugin", context: socketContext, payload: { command: "refresh-models" } });
  }

  window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, info, actionInfo) => {
    const parsedAction = parse(actionInfo);
    socketContext = uuid;
    actionContext = typeof parsedAction.context === "string" ? parsedAction.context : uuid;
    action = parsedAction.action;
    settings = normalize(parsedAction.payload?.settings);
    state = undefined;
    notifySettings();
    websocket = new WebSocket(`ws://127.0.0.1:${port}`);
    websocket.addEventListener("open", () => {
      send({ event: registerEvent, uuid });
      send({ event: "getSettings", context: socketContext });
      requestModels();
    });
    websocket.addEventListener("message", ({ data }) => {
      const message = parse(data);
      if (message.context && message.context !== socketContext && message.context !== actionContext) return;
      if (message.event === "didReceiveSettings") {
        settings = normalize(message.payload?.settings);
        notifySettings();
      }
      if (message.event === "sendToPropertyInspector" && message.payload?.type === "fingertip-model-state") {
        if (message.payload.actionId && message.payload.actionId !== actionContext) return;
        state = message.payload;
        for (const listener of stateListeners) listener(state);
      }
    });
  };

  window.FingertipModelPI = Object.freeze({
    onSettings(listener) { settingsListeners.add(listener); listener({ ...settings }); },
    onState(listener) { stateListeners.add(listener); if (state) listener(state); },
    setSettings(update) { save(update); },
    selectModel(model) {
      const entry = (Array.isArray(state?.models) ? state.models : []).find((candidate) => candidate.model === model);
      const efforts = Array.isArray(entry?.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [];
      const preferred = efforts.find((candidate) => candidate.reasoningEffort === entry?.defaultReasoningEffort)
        ?? efforts[0];
      save({ model, effort: preferred?.reasoningEffort ?? "" });
    },
    resetAppearance() {
      save({
        backgroundColor: defaults.backgroundColor,
        modelFontSize: defaults.modelFontSize,
        effortFontSize: defaults.effortFontSize,
        textAlignment: defaults.textAlignment,
      });
    },
    retry() { requestModels(); },
  });

  const pendingConnection = window.__fingertipModelPendingConnection;
  delete window.__fingertipModelPendingConnection;
  if (Array.isArray(pendingConnection)) window.connectElgatoStreamDeckSocket(...pendingConnection);
})();
