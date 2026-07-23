import {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  type PropertyInspectorDidAppearEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { ChatGptGlobalDictationPort } from "../chatgpt/chatgpt-global-dictation-port.ts";
import {
  normalizeVoiceInputSettings,
  voiceInputSettingsNeedWriteback,
  type VoiceInputSettings,
} from "../settings/voice-input-settings.ts";

type PersistedVoiceInputSettings = JsonObject & Partial<VoiceInputSettings>;

interface VoiceInputEntry {
  settings: VoiceInputSettings;
  heldShortcut: string | null;
}

function persisted(settings: VoiceInputSettings): PersistedVoiceInputSettings {
  return { version: settings.version, mode: settings.mode };
}

@action({ UUID: "com.lukas-bhm.fingertip.voice-input" })
export class VoiceInputKeyAction extends SingletonAction<PersistedVoiceInputSettings> {
  readonly #entries = new Map<string, VoiceInputEntry>();

  constructor(
    readonly dictation = new ChatGptGlobalDictationPort(),
    readonly sendToPropertyInspector: (payload: JsonValue) => Promise<void> = async () => undefined,
  ) { super(); }

  override async onWillAppear(event: WillAppearEvent<PersistedVoiceInputSettings>): Promise<void> {
    const settings = normalizeVoiceInputSettings(event.payload.settings);
    if (voiceInputSettingsNeedWriteback(event.payload.settings)) {
      await event.action.setSettings(persisted(settings));
    }
    this.#entries.set(event.action.id, { settings, heldShortcut: null });
  }

  override async onWillDisappear(event: WillDisappearEvent<PersistedVoiceInputSettings>): Promise<void> {
    await this.#release(event.action.id);
    this.#entries.delete(event.action.id);
  }

  override async onDidReceiveSettings(event: DidReceiveSettingsEvent<PersistedVoiceInputSettings>): Promise<void> {
    const settings = normalizeVoiceInputSettings(event.payload.settings);
    if (voiceInputSettingsNeedWriteback(event.payload.settings)) {
      await event.action.setSettings(persisted(settings));
    }
    const entry = this.#entries.get(event.action.id);
    if (entry !== undefined) {
      if (entry.settings.mode !== settings.mode) await this.#release(event.action.id);
      entry.settings = settings;
    }
    await this.#sendState(settings);
  }

  override async onKeyDown(event: KeyDownEvent<PersistedVoiceInputSettings>): Promise<void> {
    const entry = this.#entries.get(event.action.id);
    if (entry === undefined || entry.heldShortcut !== null) return;
    const result = await this.dictation.press(entry.settings.mode)
      .catch(() => ({ success: false as const, shortcut: null }));
    if (!result.success) {
      await event.action.showAlert().catch(() => undefined);
    } else if (entry.settings.mode === "hold") {
      entry.heldShortcut = result.shortcut;
    } else {
      await event.action.showOk().catch(() => undefined);
    }
    await this.#sendState(entry.settings);
  }

  override async onKeyUp(event: KeyUpEvent<PersistedVoiceInputSettings>): Promise<void> {
    await this.#release(event.action.id);
  }

  override async onPropertyInspectorDidAppear(
    event: PropertyInspectorDidAppearEvent<PersistedVoiceInputSettings>,
  ): Promise<void> {
    const settings = this.#entries.get(event.action.id)?.settings
      ?? normalizeVoiceInputSettings(undefined);
    await this.#sendState(settings);
  }

  async #release(actionId: string): Promise<void> {
    const entry = this.#entries.get(actionId);
    const shortcut = entry?.heldShortcut;
    if (entry === undefined || typeof shortcut !== "string") return;
    entry.heldShortcut = null;
    await this.dictation.release(shortcut).catch(() => false);
  }

  async #sendState(settings: VoiceInputSettings): Promise<void> {
    const shortcut = await this.dictation.configuredShortcut(settings.mode).catch(() => null);
    await this.sendToPropertyInspector({
      type: "fingertip-voice-state",
      mode: settings.mode,
      shortcut,
      configured: shortcut !== null,
    }).catch(() => undefined);
  }
}
