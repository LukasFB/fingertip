import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

import {
  MODEL_SELECTOR_ACTIONS,
  MODEL_SELECTOR_PROFILE,
  modelSelectorProfileIdentity,
} from "../../src/models/model-selector-profile.ts";

test("layout changes invalidate installed profile copies without changing the launcher action", () => {
  const legacy = Object.fromEntries(Object.entries(MODEL_SELECTOR_ACTIONS)
    .filter(([, action]) => action.Settings.family !== "astra"));
  const previous = modelSelectorProfileIdentity(legacy);
  assert.notEqual(previous.name, MODEL_SELECTOR_PROFILE.name);
  assert.notEqual(previous.profileId, MODEL_SELECTOR_PROFILE.profileId);
  assert.notEqual(previous.pageId, MODEL_SELECTOR_PROFILE.pageId);
  assert.deepEqual(modelSelectorProfileIdentity(Object.fromEntries(
    Object.entries(MODEL_SELECTOR_ACTIONS).reverse(),
  )), MODEL_SELECTOR_PROFILE);
  assert.notEqual(MODEL_SELECTOR_PROFILE.name, "profiles/codex-model-selector");
});

test("existing launcher keys on either device open the current bundle without rewriting key settings", async () => {
  const switches: unknown[][] = [];
  const alerts: string[] = [];
  const registeredActions: string[] = [];
  const source = await readFile("src/actions/model-selector-key-action.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (name === "../models/model-selector-profile.ts") return { MODEL_SELECTOR_PROFILE };
      assert.equal(name, "@elgato/streamdeck");
      return {
        default: { profiles: { switchToProfile: async (...args: unknown[]) => { switches.push(args); } } },
        SingletonAction: class {},
        action: ({ UUID }: { UUID: string }) => { registeredActions.push(UUID); return () => undefined; },
      };
    },
  });
  type KeyEvent = {
    action: { device: { id: string }; showAlert(): Promise<void> };
    payload: { settings: Record<string, unknown> };
  };
  const Action = exports.ModelSelectorKeyAction as new (runtime: {
    prepareModelSelector(): Promise<boolean>;
  }) => { onKeyDown(event: KeyEvent): Promise<void> };
  const action = new Action({ prepareModelSelector: async () => true });
  const legacySettings = Object.freeze({ profile: "profiles/codex-model-selector", installedVersion: "1.0.5" });
  for (const id of ["first-xl", "second-xl"]) {
    await action.onKeyDown({
      action: { device: { id }, showAlert: async () => { alerts.push(id); } },
      payload: { settings: legacySettings },
    });
  }
  assert.deepEqual(registeredActions, ["com.lukas-bhm.fingertip.model-selector"]);
  assert.deepEqual(switches, [
    ["first-xl", MODEL_SELECTOR_PROFILE.name, 0],
    ["second-xl", MODEL_SELECTOR_PROFILE.name, 0],
  ]);
  assert.deepEqual(alerts, []);
});
