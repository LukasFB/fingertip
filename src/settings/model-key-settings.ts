import type { JsonObject } from "@elgato/utils";

export type ModelKeyTextAlignment = "left" | "center" | "right";

export interface ModelKeySettings extends JsonObject {
  readonly version: 1;
  readonly model: string;
  readonly effort: string;
  readonly backgroundColor: string;
  readonly modelFontSize: number;
  readonly effortFontSize: number;
  readonly textAlignment: ModelKeyTextAlignment;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function identifier(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fontSize(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 6 && value <= 14 ? value : fallback;
}

export function normalizeModelKeySettings(value: unknown): ModelKeySettings {
  const source = record(value);
  return Object.freeze({
    version: 1,
    model: identifier(source.model),
    effort: identifier(source.effort),
    backgroundColor: typeof source.backgroundColor === "string" && /^#[0-9a-f]{6}$/iu.test(source.backgroundColor)
      ? source.backgroundColor.toLowerCase() : "#06090b",
    modelFontSize: fontSize(source.modelFontSize, 10),
    effortFontSize: fontSize(source.effortFontSize, 9),
    textAlignment: source.textAlignment === "left" || source.textAlignment === "right" ? source.textAlignment : "center",
  });
}

export const DEFAULT_MODEL_KEY_SETTINGS = normalizeModelKeySettings(undefined);

export function modelKeySettingsNeedWriteback(value: unknown): boolean {
  const source = record(value);
  const normalized = normalizeModelKeySettings(value);
  return Object.keys(source).length !== Object.keys(normalized).length
    || Object.entries(normalized).some(([key, setting]) => source[key] !== setting);
}
