import {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type PropertyInspectorDidAppearEvent,
  type PropertyInspectorDidDisappearEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { modelKeySettingsNeedWriteback, normalizeModelKeySettings, type ModelKeySettings } from "../settings/model-key-settings.ts";

type PersistedModelKeySettings = JsonObject & Partial<ModelKeySettings>;

export interface ModelKeyRuntime {
  attachModelKeyAction(action: KeyAction, settings: ModelKeySettings): void;
  updateModelKeySettings(action: KeyAction, settings: ModelKeySettings): void;
  detachModelKeyAction(id: string): void;
  pressModelKey(id: string): Promise<boolean>;
  modelPropertyInspectorDidAppear(id: string): void;
  modelPropertyInspectorDidDisappear(id: string): void;
  refreshModelCatalog(): void;
}

@action({ UUID: "com.lukas-bhm.fingertip.model" })
export class ModelKeyAction extends SingletonAction<PersistedModelKeySettings> {
  constructor(readonly runtime: ModelKeyRuntime) { super(); }

  override async onWillAppear(event: WillAppearEvent<PersistedModelKeySettings>): Promise<void> {
    if (!event.action.isKey()) return;
    const settings = normalizeModelKeySettings(event.payload.settings);
    if (modelKeySettingsNeedWriteback(event.payload.settings)) await event.action.setSettings(settings);
    this.runtime.attachModelKeyAction(event.action, settings);
  }

  override onWillDisappear(event: WillDisappearEvent<PersistedModelKeySettings>): void {
    this.runtime.detachModelKeyAction(event.action.id);
  }

  override async onDidReceiveSettings(event: DidReceiveSettingsEvent<PersistedModelKeySettings>): Promise<void> {
    if (!event.action.isKey()) return;
    const settings = normalizeModelKeySettings(event.payload.settings);
    if (modelKeySettingsNeedWriteback(event.payload.settings)) await event.action.setSettings(settings);
    this.runtime.updateModelKeySettings(event.action, settings);
  }

  override async onKeyDown(event: KeyDownEvent<PersistedModelKeySettings>): Promise<void> {
    let succeeded = false;
    try {
      succeeded = await this.runtime.pressModelKey(event.action.id);
    } catch {
      // A failed asynchronous desktop request must still give key feedback.
    }
    if (succeeded) {
      await event.action.showOk().catch(() => undefined);
    } else {
      await event.action.showAlert().catch(() => undefined);
    }
  }

  override onPropertyInspectorDidAppear(event: PropertyInspectorDidAppearEvent<PersistedModelKeySettings>): void {
    this.runtime.modelPropertyInspectorDidAppear(event.action.id);
  }

  override onPropertyInspectorDidDisappear(event: PropertyInspectorDidDisappearEvent<PersistedModelKeySettings>): void {
    this.runtime.modelPropertyInspectorDidDisappear(event.action.id);
  }

  override onSendToPlugin(event: SendToPluginEvent<JsonValue, PersistedModelKeySettings>): void {
    if (typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      && event.payload.command === "refresh-models") this.runtime.refreshModelCatalog();
  }
}
