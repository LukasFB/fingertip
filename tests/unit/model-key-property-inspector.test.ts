import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { normalizeModelKeySettings } from "../../src/settings/model-key-settings.ts";

interface InspectorBridge {
  connectElgatoStreamDeckSocket(port: string, uuid: string, registration: string, info: string, actionInfo: string): void;
  FingertipModelPI: {
    onSettings(listener: (value: Record<string, unknown>) => void): void;
    onState(listener: (value: Record<string, unknown>) => void): void;
    selectModel(model: string): void;
    setSettings(update: Record<string, unknown>): void;
    resetAppearance(): void;
    retry(): void;
  };
}

async function inspector(saved: unknown = {}, injectBeforeBridge = false) {
  const sent: Array<{ event: string; context?: string; payload?: Record<string, unknown> }> = [];
  const listeners = new Map<string, (event: { data: string }) => void>();
  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly readyState = FakeWebSocket.OPEN;
    addEventListener(type: string, listener: (event: { data: string }) => void): void { listeners.set(type, listener); }
    send(value: string): void { sent.push(JSON.parse(value)); }
  }
  const window = {} as InspectorBridge;
  const bridge = await readFile("com.lukas-bhm.fingertip.sdPlugin/ui/model-key.js", "utf8");
  const connectionArguments = ["1234", "pi-context", "registerPropertyInspector", "{}", JSON.stringify({
    context: "model-key",
    action: "com.lukas-bhm.fingertip.model",
    payload: { settings: saved },
  })] as const;
  if (injectBeforeBridge) {
    const html = await readFile("com.lukas-bhm.fingertip.sdPlugin/ui/model-key.html", "utf8");
    const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    assert.ok(bootstrap);
    assert.ok(html.indexOf(bootstrap) < html.indexOf('<script src="model-key.js">'));
    vm.runInNewContext(bootstrap, { window });
    window.connectElgatoStreamDeckSocket(...connectionArguments);
    assert.equal(Object.hasOwn(window, "FingertipModelPI"), false);
  }
  vm.runInNewContext(bridge, { window, WebSocket: FakeWebSocket });
  if (!injectBeforeBridge) window.connectElgatoStreamDeckSocket(...connectionArguments);
  assert.equal(Object.hasOwn(window, "__fingertipModelPendingConnection"), false);
  listeners.get("open")?.({ data: "" });
  return {
    api: window.FingertipModelPI,
    sent,
    message(value: Record<string, unknown>) { listeners.get("message")?.({ data: JSON.stringify(value) }); },
    state(payload: Record<string, unknown>) {
      listeners.get("message")?.({ data: JSON.stringify({ event: "sendToPropertyInspector", context: "pi-context", payload: { type: "fingertip-model-state", ...payload } }) });
    },
  };
}

test("native startup injection before the external bridge loads is replayed once with saved settings", async () => {
  const pi = await inspector({ model: "future/v9", effort: "adaptive" }, true);
  let settings: Record<string, unknown> = {};
  pi.api.onSettings((value) => { settings = value; });
  assert.equal(settings.model, "future/v9");
  assert.equal(settings.effort, "adaptive");
  assert.deepEqual(pi.sent.map((message) => message.event), ["registerPropertyInspector", "getSettings", "sendToPlugin"]);
  assert.equal(pi.sent.at(-1)?.context, "pi-context");
  assert.equal(pi.sent.at(-1)?.payload?.command, "refresh-models");
});

test("model inspector populates future models and selects each model's supported default atomically", async () => {
  const pi = await inspector();
  let settings: Record<string, unknown> = {};
  pi.api.onSettings((value) => { settings = value; });
  pi.state({ models: [{
    model: "future/v9",
    displayName: "Future V9",
    defaultReasoningEffort: "adaptive",
    supportedReasoningEfforts: [{ reasoningEffort: "brief", description: "Brief thinking" }, { reasoningEffort: "adaptive", description: "Adaptive thinking" }],
  }, {
    model: "fallback",
    defaultReasoningEffort: "unsupported",
    supportedReasoningEfforts: [{ reasoningEffort: "new-level", description: "New" }],
  }, { model: "no-reasoning", supportedReasoningEfforts: [] }] });
  assert.equal(settings.model, "");
  pi.api.selectModel("future/v9");
  assert.equal(settings.model, "future/v9");
  assert.equal(settings.effort, "adaptive");
  assert.equal(pi.sent.at(-1)?.payload?.effort, "adaptive");
  pi.api.selectModel("fallback");
  assert.equal(settings.effort, "new-level");
  pi.api.selectModel("no-reasoning");
  assert.equal(settings.effort, "");
  assert.equal(pi.sent.some((message) => message.event === "setGlobalSettings" || message.event === "getGlobalSettings"), false);
});

test("offline catalogs preserve saved model settings and ignore stale messages for other keys", async () => {
  const saved = normalizeModelKeySettings({ model: "future/v9", effort: "new-level", backgroundColor: "#abcdef" });
  const pi = await inspector(saved);
  let settings: Record<string, unknown> = {};
  let count = 0;
  pi.api.onSettings((value) => { settings = value; });
  pi.api.onState(() => { count += 1; });
  pi.state({ models: [], error: "Offline", loading: false, actionId: "model-key" });
  assert.equal(count, 1);
  assert.equal(settings.model, saved.model);
  assert.equal(settings.effort, saved.effort);
  pi.state({ models: [], actionId: "different-key" });
  assert.equal(count, 1);
  pi.message({ event: "didReceiveSettings", context: "different-key", payload: { settings: { model: "wrong" } } });
  assert.equal(settings.model, saved.model);
  pi.api.setSettings({ textAlignment: "left", modelFontSize: 14 });
  assert.equal(settings.model, saved.model);
  assert.equal(settings.effort, saved.effort);
  assert.equal(pi.sent.at(-1)?.context, "pi-context");
  pi.api.resetAppearance();
  assert.equal(settings.backgroundColor, "#06090b");
  assert.equal(settings.model, saved.model);
  assert.equal(settings.effort, saved.effort);
  pi.api.retry();
  assert.equal(pi.sent.at(-1)?.event, "sendToPlugin");
  assert.equal(pi.sent.at(-1)?.payload?.command, "refresh-models");
  assert.equal(pi.sent.at(-1)?.context, "pi-context");
});

test("distinct property inspector and action contexts persist settings through a Stream Deck roundtrip and restart", async () => {
  const pi = await inspector();
  assert.deepEqual(pi.sent.slice(0, 3), [{ event: "registerPropertyInspector", uuid: "pi-context" }, { event: "getSettings", context: "pi-context" }, {
    action: "com.lukas-bhm.fingertip.model",
    event: "sendToPlugin",
    context: "pi-context",
    payload: { command: "refresh-models" },
  }]);
  pi.state({ actionId: "model-key", models: [{
    model: "future/v9",
    defaultReasoningEffort: "adaptive",
    supportedReasoningEfforts: [{ reasoningEffort: "adaptive", description: "Adaptive" }],
  }] });
  pi.api.selectModel("future/v9");
  pi.api.setSettings({ modelFontSize: 14, textAlignment: "right" });
  const written = pi.sent.at(-1);
  assert.equal(written?.event, "setSettings");
  assert.equal(written?.context, "pi-context");
  assert.equal(written?.payload?.model, "future/v9");
  assert.equal(written?.payload?.effort, "adaptive");
  let echoed: Record<string, unknown> = {};
  pi.api.onSettings((value) => { echoed = value; });
  pi.message({ event: "didReceiveSettings", context: "pi-context", payload: { settings: written?.payload } });
  assert.equal(echoed.model, "future/v9");
  assert.equal(echoed.effort, "adaptive");
  const restarted = await inspector(written?.payload);
  let restored: Record<string, unknown> = {};
  restarted.api.onSettings((value) => { restored = value; });
  assert.equal(restored.model, "future/v9");
  assert.equal(restored.effort, "adaptive");
  assert.equal(restored.modelFontSize, 14);
  assert.equal(restored.textAlignment, "right");
});

test("inspector dropdowns show discovered models and retain unavailable saved selections", async () => {
  const pi = await inspector({ model: "saved-model", effort: "saved-effort" });
  class Element {
    value = "";
    textContent = "";
    src = "";
    disabled = false;
    hidden = false;
    readonly dataset: Record<string, string> = {};
    readonly options: Array<{ text: string; value: string }> = [];
    readonly listeners = new Map<string, () => void>();
    readonly attributes = new Map<string, string>();
    add(option: { text: string; value: string }): void { this.options.push(option); }
    replaceChildren(...options: Array<{ text: string; value: string }>): void {
      this.options.splice(0, this.options.length, ...options);
    }
    addEventListener(event: string, listener: () => void): void { this.listeners.set(event, listener); }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  }
  class Option {
    readonly text: string;
    readonly value: string;
    constructor(text: string, value: string) { this.text = text; this.value = value; }
  }
  const elements = new Map<string, Element>();
  const document = {
    querySelector(selector: string): Element {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector)!;
    },
    querySelectorAll(): Element[] { return []; },
  };
  const html = await readFile("com.lukas-bhm.fingertip.sdPlugin/ui/model-key.html", "utf8");
  const script = html.slice(html.indexOf("<body>")).match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, { document, Option, FingertipModelPI: pi.api });
  const model = document.querySelector("#model");
  const effort = document.querySelector("#effort");
  assert.equal(model.value, "saved-model");
  assert.match(model.options.at(-1)?.text ?? "", /unavailable/u);
  pi.state({ models: [{
    model: "future/v9",
    displayName: "Future V9",
    defaultReasoningEffort: "adaptive",
    supportedReasoningEfforts: [{ reasoningEffort: "adaptive", description: "New adaptive level" }],
  }], loading: false, error: null, activeThreadId: "active-thread", preview: "data:image/svg+xml,sample" });
  assert.equal(model.disabled, false);
  assert.equal(model.options.some((option) => option.text === "Future V9" && option.value === "future/v9"), true);
  assert.equal(model.value, "saved-model");
  assert.equal(effort.value, "saved-effort");
  model.value = "future/v9";
  model.listeners.get("change")?.();
  assert.equal(effort.value, "adaptive");
  assert.equal(effort.disabled, false);
  assert.equal(document.querySelector("#effort-description").textContent, "New adaptive level");
  assert.equal(document.querySelector("#selection-status").textContent, "Ready to apply to the active thread.");
  assert.equal(document.querySelector("#preview").src, "data:image/svg+xml,sample");
  pi.state({ models: [], loading: false, error: "Disconnected", activeThreadId: null });
  assert.equal(model.value, "future/v9");
  assert.equal(effort.value, "adaptive");
  assert.match(document.querySelector("#catalog-status").textContent, /Disconnected/u);
  assert.match(document.querySelector("#target-status").textContent, /No active/u);
  assert.match(document.querySelector("#selection-status").textContent, /saved selection is retained/u);
});
