import {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type PropertyInspectorDidAppearEvent,
  type PropertyInspectorDidDisappearEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import type { FingertipRuntime } from "../runtime/fingertip-runtime.ts";
import { taskKeySettingsNeedWriteback, type TaskKeySettings } from "../settings/task-key-settings.ts";

type PersistedTaskKeySettings = JsonObject & Partial<TaskKeySettings>;

function isRetryMessage(value: JsonValue): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, JsonValue>).command === "retry-now";
}

function persisted(settings: TaskKeySettings): PersistedTaskKeySettings {
  return {
    version: settings.version,
    taskPosition: settings.taskPosition,
    taskSource: settings.taskSource,
  };
}

@action({ UUID: "com.lukas-bhm.fingertip.task" })
export class TaskKeyAction extends SingletonAction<PersistedTaskKeySettings> {
  readonly #runtime: FingertipRuntime;
  readonly #offerLegacyAppearance: (value: unknown) => void;

  constructor(runtime: FingertipRuntime, offerLegacyAppearance: (value: unknown) => void = () => undefined) {
    super();
    this.#runtime = runtime;
    this.#offerLegacyAppearance = offerLegacyAppearance;
  }

  override async onWillAppear(event: WillAppearEvent<PersistedTaskKeySettings>): Promise<void> {
    if (!event.action.isKey()) return;
    this.#offerLegacyAppearance(event.payload.settings);
    const settings = this.#runtime.normalizeSettings(event.payload.settings);
    if (taskKeySettingsNeedWriteback(event.payload.settings)) {
      await event.action.setSettings(persisted(settings));
    }
    this.#runtime.attachAction(event.action, settings);
  }

  override onWillDisappear(event: WillDisappearEvent<PersistedTaskKeySettings>): void {
    this.#runtime.detachAction(event.action.id);
  }

  override async onDidReceiveSettings(event: DidReceiveSettingsEvent<PersistedTaskKeySettings>): Promise<void> {
    if (!event.action.isKey()) return;
    const settings = this.#runtime.normalizeSettings(event.payload.settings);
    if (taskKeySettingsNeedWriteback(event.payload.settings)) {
      await event.action.setSettings(persisted(settings));
    }
    this.#runtime.updateSettings(event.action, settings);
  }

  override async onKeyDown(event: KeyDownEvent<PersistedTaskKeySettings>): Promise<void> {
    await this.#runtime.press(event.action.id);
  }

  override onPropertyInspectorDidAppear(event: PropertyInspectorDidAppearEvent<PersistedTaskKeySettings>): void {
    this.#runtime.propertyInspectorDidAppear(event.action.id);
  }

  override onPropertyInspectorDidDisappear(event: PropertyInspectorDidDisappearEvent<PersistedTaskKeySettings>): void {
    this.#runtime.propertyInspectorDidDisappear(event.action.id);
  }

  override onSendToPlugin(event: SendToPluginEvent<JsonValue, PersistedTaskKeySettings>): void {
    if (isRetryMessage(event.payload)) this.#runtime.retryNow();
  }
}
