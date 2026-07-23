import streamDeck from "@elgato/streamdeck";

import { TaskKeyAction } from "./actions/task-key-action.ts";
import { lockProductionLogLevel } from "./production-logging.ts";
import { FingertipRuntime } from "./runtime/fingertip-runtime.ts";
import { AppearanceSettingsController } from "./settings/appearance-settings-controller.ts";
import type { TaskKeyAppearanceSettings } from "./settings/task-key-settings.ts";

lockProductionLogLevel(streamDeck.logger);

const runtime = new FingertipRuntime({
  propertyInspector: {
    send: (payload) => streamDeck.ui.sendToPropertyInspector(payload),
  },
});

const appearance = new AppearanceSettingsController({
  apply: (settings) => runtime.updateAppearance(settings),
  write: (settings) => streamDeck.settings.setGlobalSettings(settings),
});

streamDeck.actions.registerAction(new TaskKeyAction(runtime, (settings) => {
  void appearance.offerLegacy(settings);
  void appearance.offerLegacyBadges(settings);
}));
streamDeck.settings.onDidReceiveGlobalSettings<TaskKeyAppearanceSettings>((event) => {
  void appearance.receive(event.settings);
});
streamDeck.system.onApplicationDidLaunch(() => runtime.applicationDidLaunch());
streamDeck.system.onApplicationDidTerminate(() => runtime.applicationDidTerminate());
streamDeck.system.onSystemDidWakeUp(() => runtime.systemDidWake());

process.once("SIGINT", () => runtime.shutdown());
process.once("SIGTERM", () => runtime.shutdown());
process.once("beforeExit", () => runtime.shutdown());

await streamDeck.connect();
await appearance.load(await streamDeck.settings.getGlobalSettings());
