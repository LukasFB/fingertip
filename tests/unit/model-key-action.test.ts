import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

import type { ModelKeyRuntime } from "../../src/actions/model-key-action.ts";
import { modelKeySettingsNeedWriteback, normalizeModelKeySettings } from "../../src/settings/model-key-settings.ts";

interface LoadedModelAction {
  onKeyDown(event: { readonly action: { readonly id: string; showOk(): Promise<void>; showAlert(): Promise<void> } }): Promise<void>;
}

async function modelAction(press: ModelKeyRuntime["pressModelKey"]): Promise<LoadedModelAction> {
  const source = await readFile("src/actions/model-key-action.ts", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled.outputText, {
    exports,
    require(name: string) {
      if (name === "@elgato/streamdeck") return { action: () => (constructor: unknown) => constructor, SingletonAction: class {} };
      if (name === "../settings/model-key-settings.ts") return { modelKeySettingsNeedWriteback, normalizeModelKeySettings };
      throw new Error(`Unexpected model action dependency: ${name}`);
    },
  });
  const Constructor = exports.ModelKeyAction as new (runtime: ModelKeyRuntime) => LoadedModelAction;
  return new Constructor({
    attachModelKeyAction() {},
    updateModelKeySettings() {},
    detachModelKeyAction() {},
    modelPropertyInspectorDidAppear() {},
    modelPropertyInspectorDidDisappear() {},
    refreshModelCatalog() {},
    pressModelKey: press,
  });
}

for (const result of ["success", "declined", "rejected"] as const) {
  test(`model action gives visible feedback when the desktop request is ${result}`, async () => {
    let pressed: string | null = null;
    const action = await modelAction(async (id) => {
      pressed = id;
      if (result === "rejected") throw new Error("Desktop IPC unavailable");
      return result === "success";
    });
    let alerts = 0;
    let confirmations = 0;
    await action.onKeyDown({ action: {
      id: "chosen-key",
      async showOk() { confirmations += 1; },
      async showAlert() { alerts += 1; },
    } });
    assert.equal(pressed, "chosen-key");
    assert.equal(confirmations, result === "success" ? 1 : 0);
    assert.equal(alerts, result === "success" ? 0 : 1);
  });
}
