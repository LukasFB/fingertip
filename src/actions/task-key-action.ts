import {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  type PropertyInspectorDidAppearEvent,
  type PropertyInspectorDidDisappearEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import type { FingertipRuntime } from "../runtime/fingertip-runtime.ts";
import {
  taskKeySettingsNeedWriteback,
  type TaskKeySettings,
  type TaskNotificationStatus,
} from "../settings/task-key-settings.ts";

type PersistedTaskKeySettings = JsonObject & Partial<TaskKeySettings>;

function command(value: JsonValue): { name: string; status?: TaskNotificationStatus } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, JsonValue>;
  if (record.command === "retry-now") return { name: "retry-now" };
  if (record.command === "import-custom-sound"
    && (record.status === "done" || record.status === "confirmation")) {
    return { name: "import-custom-sound", status: record.status };
  }
  if (record.command === "preview-sound"
    && (record.status === "done" || record.status === "confirmation")) {
    return { name: "preview-sound", status: record.status };
  }
  return null;
}

function persisted(settings: TaskKeySettings): PersistedTaskKeySettings {
  return {
    version: settings.version,
    taskPosition: settings.taskPosition,
    taskSource: settings.taskSource,
    moveActiveUnreadThreadsToTop: settings.moveActiveUnreadThreadsToTop,
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
    this.#runtime.keyDown(event.action.id);
  }

  override async onKeyUp(event: KeyUpEvent<PersistedTaskKeySettings>): Promise<void> {
    await this.#runtime.keyUp(event.action.id);
  }

  override onPropertyInspectorDidAppear(event: PropertyInspectorDidAppearEvent<PersistedTaskKeySettings>): void {
    this.#runtime.propertyInspectorDidAppear(event.action.id);
  }

  override onPropertyInspectorDidDisappear(event: PropertyInspectorDidDisappearEvent<PersistedTaskKeySettings>): void {
    this.#runtime.propertyInspectorDidDisappear(event.action.id);
  }

  override onSendToPlugin(event: SendToPluginEvent<JsonValue, PersistedTaskKeySettings>): void {
    const received = command(event.payload);
    if (received?.name === "retry-now") this.#runtime.retryNow();
    if (received?.name === "import-custom-sound" && received.status !== undefined) {
      void this.#runtime.importCustomSound(received.status);
    }
    if (received?.name === "preview-sound" && received.status !== undefined) {
      this.#runtime.previewSound(received.status);
    }
  }
}
