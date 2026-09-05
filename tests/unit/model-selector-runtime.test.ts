import assert from "node:assert/strict";
import test from "node:test";

import { parseTaskId } from "../../src/catalog/catalog-projection.ts";
import type { ChatGptBundleResolver } from "../../src/chatgpt/chatgpt-bundle-resolver.ts";
import type { ChatGptNavigationPort } from "../../src/chatgpt/chatgpt-navigation-port.ts";
import type { ChatGptDesktopIpcAdapter, LiveTaskRecord } from "../../src/desktop-ipc/chatgpt-desktop-ipc-adapter.ts";
import { modelSelection } from "../../src/models/model-selection.ts";
import { FingertipRuntime } from "../../src/runtime/fingertip-runtime.ts";

test("Model Selector follows the currently visible Task and updates the selected border optimistically", async (context) => {
  const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  const switchedTaskId = parseTaskId("00000000-0000-4000-8000-000000000002");
  const taskListeners = new Set<(record: LiveTaskRecord) => void>();
  const activeTaskListeners = new Set<(taskId: ReturnType<typeof parseTaskId> | null) => void>();
  const healthListeners = new Set<(state: "connecting" | "online" | "offline" | "incompatible") => void>();
  let activeTaskId = taskId;
  const updates: Array<{ taskId: string; model: string; effort: string }> = [];
  const fastModeUpdates: Array<{ taskId: string; enabled: boolean }> = [];
  const desktopIpc = {
    state: "online",
    get activeTaskId() { return activeTaskId; },
    onHealth(listener: (state: "connecting" | "online" | "offline" | "incompatible") => void) {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    onTaskRecord(listener: (record: LiveTaskRecord) => void) {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    },
    onCatalogHint() { return () => undefined; },
    onActiveTask(listener: (taskId: ReturnType<typeof parseTaskId> | null) => void) {
      activeTaskListeners.add(listener);
      return () => activeTaskListeners.delete(listener);
    },
    async setModelSelection(selectedTaskId: string, selection: ReturnType<typeof modelSelection>) {
      updates.push({ taskId: selectedTaskId, model: selection.model, effort: selection.effort });
      return true;
    },
    async setFastMode(selectedTaskId: string, enabled: boolean) {
      fastModeUpdates.push({ taskId: selectedTaskId, enabled });
      return true;
    },
    async start() {},
    stop() {},
    setCatalogTaskIds() {},
    setCompatibilityFingerprint() {},
  } as unknown as ChatGptDesktopIpcAdapter;
  const runtime = new FingertipRuntime({
    desktopIpc,
    navigation: {
      windowTarget: "last-active",
      async activateTargetWindow() { return true; },
    } as unknown as ChatGptNavigationPort,
    bundleResolver: { resolve: () => new Promise<never>(() => undefined) } as unknown as ChatGptBundleResolver,
    propertyInspector: { async send() {} },
  });
  context.after(() => runtime.shutdown());
  const selectorImages: string[] = [];
  runtime.attachModelSelectorAction({
    id: "selector",
    async setImage(image) { selectorImages.push(image); },
    async showAlert() {},
  });
  for (const listener of healthListeners) listener("online");
  for (const listener of taskListeners) listener(Object.freeze({
    taskId,
    ownerClientId: "owner",
    revision: 1,
    facts: Object.freeze({
      isActive: false,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      hasUnreadTurn: false,
      serviceTier: null,
      model: "gpt-5.6-terra",
      effort: "medium",
    }),
    status: "idle",
    freshness: "fresh",
  }));

  assert.equal(await runtime.prepareModelSelector(), true);
  const optionImages: string[] = [];
  runtime.attachModelOptionAction({
    id: "terra-medium",
    async setImage(image) { optionImages.push(image); },
    async showAlert() {},
  }, modelSelection("terra", "medium"));
  assert.equal(optionImages.at(-1), "imgs/actions/model-options/terra-medium-selected.png");
  const fastModeImages: string[] = [];
  runtime.attachFastModeAction({
    id: "fast-mode",
    async setImage(image) { fastModeImages.push(decodeURIComponent(image)); },
    async showAlert() {},
  });
  assert.equal(fastModeImages.at(-1)?.includes('stroke="#ffffff"'), true);
  assert.equal(fastModeImages.at(-1)?.includes("<text"), false);

  activeTaskId = switchedTaskId;
  for (const listener of activeTaskListeners) listener(switchedTaskId);
  assert.equal(optionImages.at(-1), "imgs/actions/model-options/terra-medium.png");

  assert.equal(await runtime.pressFastMode(), true);
  assert.deepEqual(fastModeUpdates, [{ taskId: switchedTaskId, enabled: true }]);
  assert.equal(fastModeImages.at(-1)?.includes('data-animation="fast-electric"'), true);
  assert.equal(fastModeImages.at(-1)?.includes("<text"), false);

  assert.equal(await runtime.pressModelSelection(modelSelection("astra", "high")), true);
  assert.deepEqual(updates, [{
    taskId: switchedTaskId,
    model: "gpt-6-astra",
    effort: "high",
  }]);
  assert.equal(selectorImages.at(-1), "imgs/actions/model-selector/key.png");
});

test("Model Selector controls a new composer before it has a Task ID", async (context) => {
  const healthListeners = new Set<(state: "connecting" | "online" | "offline" | "incompatible") => void>();
  const ipcUpdates: unknown[] = [];
  const composerUpdates: ReturnType<typeof modelSelection>[] = [];
  const staleTaskId = parseTaskId("00000000-0000-4000-8000-000000000009");
  let activeTaskId: ReturnType<typeof parseTaskId> | null = null;
  const desktopIpc = {
    state: "online",
    get activeTaskId() { return activeTaskId; },
    onHealth(listener: (state: "connecting" | "online" | "offline" | "incompatible") => void) {
      healthListeners.add(listener);
      return () => healthListeners.delete(listener);
    },
    onTaskRecord() { return () => undefined; },
    onCatalogHint() { return () => undefined; },
    onActiveTask() { return () => undefined; },
    async setModelSelection(...args: unknown[]) { ipcUpdates.push(args); return true; },
    async start() {},
    stop() {},
    setCatalogTaskIds() {},
    setCompatibilityFingerprint() {},
  } as unknown as ChatGptDesktopIpcAdapter;
  const runtime = new FingertipRuntime({
    desktopIpc,
    navigation: {
      windowTarget: "last-active",
      async activateTargetWindow() { return true; },
      async setComposerModelSelection(selection: ReturnType<typeof modelSelection>) {
        composerUpdates.push(selection);
        return true;
      },
    } as unknown as ChatGptNavigationPort,
    bundleResolver: { resolve: () => new Promise<never>(() => undefined) } as unknown as ChatGptBundleResolver,
    propertyInspector: { async send() {} },
  });
  context.after(() => runtime.shutdown());
  for (const listener of healthListeners) listener("online");

  assert.equal(await runtime.prepareModelSelector(), true);
  const optionImages: string[] = [];
  runtime.attachModelOptionAction({
    id: "luna-max",
    async setImage(image) { optionImages.push(image); },
    async showAlert() {},
  }, modelSelection("luna", "max"));
  assert.equal(optionImages.at(-1), "imgs/actions/model-options/luna-max.png");

  // Codex can briefly expose the previous Task ID while activating a fresh
  // Composer. The target prepared before opening the profile must win.
  activeTaskId = staleTaskId;
  assert.equal(await runtime.pressModelSelection(modelSelection("luna", "max")), true);
  assert.deepEqual(composerUpdates, [modelSelection("luna", "max")]);
  assert.deepEqual(ipcUpdates, []);
  assert.equal(optionImages.at(-1), "imgs/actions/model-options/luna-max-selected.png");
});

test("Model Selector still rejects a composer when ChatGPT cannot be activated", async (context) => {
  const runtime = new FingertipRuntime({
    desktopIpc: {
      state: "offline",
      activeTaskId: null,
      onHealth() { return () => undefined; },
      onTaskRecord() { return () => undefined; },
      onCatalogHint() { return () => undefined; },
      onActiveTask() { return () => undefined; },
      async start() {},
      stop() {},
      setCatalogTaskIds() {},
      setCompatibilityFingerprint() {},
    } as unknown as ChatGptDesktopIpcAdapter,
    navigation: {
      windowTarget: "last-active",
      async activateTargetWindow() { return false; },
    } as unknown as ChatGptNavigationPort,
    bundleResolver: { resolve: () => new Promise<never>(() => undefined) } as unknown as ChatGptBundleResolver,
    propertyInspector: { async send() {} },
  });
  context.after(() => runtime.shutdown());

  assert.equal(await runtime.prepareModelSelector(), false);
});
