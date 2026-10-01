import { normalizeModelKeySettings, type ModelKeySettings } from "../settings/model-key-settings.ts";
import { toSvgDataUrl } from "./svg-key-renderer.ts";

export interface ModelKeyRenderInput {
  readonly settings: ModelKeySettings;
  readonly modelLabel?: string;
  readonly offline?: boolean;
  readonly active?: boolean;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function foreground(background: string): string {
  const source = Number.parseInt(background.slice(1), 16);
  const channel = (shift: number): number => {
    const value = ((source >> shift) & 255) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / 0.05) ? "#ffffff" : "#000000";
}

function graphemes(value: string): string[] {
  return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)].map((entry) => entry.segment);
}

const CAPITAL_WIDTHS = [0.722, 0.722, 0.722, 0.722, 0.667, 0.611, 0.778, 0.722, 0.278, 0.556, 0.722, 0.611, 0.833, 0.722, 0.778, 0.667, 0.778, 0.722, 0.667, 0.611, 0.722, 0.667, 0.944, 0.667, 0.667, 0.611];
const LOWERCASE_WIDTHS = [0.556, 0.611, 0.556, 0.611, 0.556, 0.333, 0.611, 0.611, 0.278, 0.278, 0.556, 0.278, 0.889, 0.611, 0.611, 0.611, 0.611, 0.389, 0.556, 0.333, 0.611, 0.556, 0.778, 0.556, 0.556, 0.5];

// Arial Bold widths with a small margin keep model IDs readable on one line.
// Digits share the same width; treating "1" as a narrow letter overflows keys.
function textWidth(value: string): number {
  return graphemes(value).reduce((sum, character) => {
    if (/^[A-Z]$/u.test(character)) return sum + (CAPITAL_WIDTHS[character.charCodeAt(0) - 65] ?? 0.8) + 0.02;
    if (/^[a-z]$/u.test(character)) return sum + (LOWERCASE_WIDTHS[character.charCodeAt(0) - 97] ?? 0.8) + 0.02;
    if (/^[0-9]$/u.test(character)) return sum + 0.58;
    if (/^[\s|.,'!`/]$/u.test(character)) return sum + 0.3;
    if (/^[-:;\\()]$/u.test(character)) return sum + 0.36;
    return sum + (character.length === 1 && character.charCodeAt(0) <= 0x7e ? 1 : 1.1);
  }, 0);
}

function fitLabel(value: string, maximumEm: number): string {
  const characters = graphemes(value.replace(/\s+/gu, " ").replace(/\p{Cc}/gu, "").trim());
  if (textWidth(characters.join("")) <= maximumEm) return characters.join("");
  while (characters.length > 0 && textWidth(`${characters.join("").trimEnd()}…`) > maximumEm) characters.pop();
  return `${characters.join("").trimEnd()}…`;
}

function renderLabel(value: string, input: {
  readonly fontSize: number;
  readonly y: number;
  readonly x: number;
  readonly anchor: string;
  readonly weight: number;
  readonly kind: string;
  readonly color: string;
}): string {
  const label = fitLabel(value, 60 / input.fontSize);
  return `<text data-label="${input.kind}" x="${input.x}" y="${input.y}" text-anchor="${input.anchor}" xml:space="preserve" font-family="Arial, Helvetica, sans-serif" font-size="${input.fontSize}" font-weight="${input.weight}" fill="${input.color}">${escapeXml(label)}</text>`;
}

export function renderModelKeySvg(input: ModelKeyRenderInput): string {
  const settings = normalizeModelKeySettings(input.settings);
  const color = foreground(settings.backgroundColor);
  const anchor = settings.textAlignment === "left" ? "start" : settings.textAlignment === "right" ? "end" : "middle";
  const x = settings.textAlignment === "left" ? 6 : settings.textAlignment === "right" ? 66 : 36;
  const model = settings.model ? input.modelLabel?.trim() || settings.model : "Choose model";
  const effort = settings.effort || (settings.model ? "Default" : "Thinking");
  const position = { x, anchor, color };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 72 72">
  <rect width="72" height="72" rx="8" fill="${settings.backgroundColor}"/>
  ${renderLabel(model, { ...position, fontSize: settings.modelFontSize, y: 30, weight: 700, kind: "model" })}
  <path d="M6 39H66" fill="none" stroke="${color}" stroke-opacity=".24" stroke-width=".5"/>
  ${renderLabel(effort, { ...position, fontSize: settings.effortFontSize, y: 54, weight: 500, kind: "effort" })}
  ${input.offline ? `<g data-offline="true"><circle cx="64" cy="7" r="4" fill="${color}"/><text x="64" y="9.5" fill="${settings.backgroundColor}" font-family="Arial, Helvetica, sans-serif" font-size="7" font-weight="700" text-anchor="middle">!</text></g>` : ""}
  ${input.active && !input.offline ? `<g data-active="true"><rect x="1.5" y="1.5" width="69" height="69" rx="7" fill="none" stroke="#ffffff" stroke-width="2.5"/><rect x="4" y="4" width="64" height="64" rx="5" fill="none" stroke="#000000" stroke-width="1.5"/></g>` : ""}
</svg>`;
}

export function renderModelKeyDataUrl(input: ModelKeyRenderInput): string {
  return toSvgDataUrl(renderModelKeySvg(input));
}
