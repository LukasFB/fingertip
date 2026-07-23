import type { JsonObject } from "@elgato/utils";

export type DictationMode = "toggle" | "hold";

export interface VoiceInputSettings extends JsonObject {
  readonly version: 1;
  readonly mode: DictationMode;
}

export function normalizeVoiceInputSettings(value: unknown): VoiceInputSettings {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return Object.freeze({
    version: 1,
    mode: record.mode === "hold" ? "hold" : "toggle",
  });
}

export function voiceInputSettingsNeedWriteback(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
  const record = value as Record<string, unknown>;
  const normalized = normalizeVoiceInputSettings(value);
  return Object.keys(record).length !== 2
    || record.version !== normalized.version
    || record.mode !== normalized.mode;
}
