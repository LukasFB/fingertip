import type { TaskStatus } from "../status/task-status-projector.ts";
import {
  DEFAULT_TASK_KEY_COLORS,
  type TaskKeyColors,
  type TaskKeyBadgePosition,
  type TaskKeyTextAlignment,
} from "../settings/task-key-settings.ts";
import type { TaskChangeStats } from "../task-change-stats.ts";

export type KeyRenderKind = "task" | "empty" | "loading" | "unavailable";
export type KeyAnimationKind = "working-noise" | "status-flash" | "done-burst";

export interface KeyAnimationEffect {
  readonly kind: KeyAnimationKind;
  readonly intensity: number;
  readonly phase?: number;
}

export interface KeyRenderModel {
  readonly kind: KeyRenderKind;
  readonly taskPosition: number;
  readonly titleFontSize: number;
  readonly projectFontSize: number;
  readonly timeFontSize?: number;
  readonly textAlignment?: TaskKeyTextAlignment;
  readonly borderEnabled?: boolean;
  readonly projectColorEnabled?: boolean;
  readonly projectColorOpacity?: number;
  readonly title?: string;
  readonly projectLabel?: string;
  readonly status?: TaskStatus | null;
  readonly activityLabel?: string;
  readonly taskChangeStats?: TaskChangeStats;
  readonly queuedMessageCount?: number;
  readonly hasOngoingGoal?: boolean;
  readonly badgePosition?: TaskKeyBadgePosition;
  readonly badgeFontSize?: number;
  readonly colors?: TaskKeyColors;
  readonly animation?: KeyAnimationEffect;
  readonly offlineWarning: boolean;
}

type RenderStatus = TaskStatus | "empty" | "unknown";

export const KEY_PALETTE: Readonly<Record<RenderStatus, string>> = Object.freeze({
  ...DEFAULT_TASK_KEY_COLORS,
  empty: "#17191e",
  unknown: "#343842",
});

const LIGHT_FOREGROUND = "#f7f9fc";
const DARK_FOREGROUND = "#10141b";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function mix(hex: string, target: "#ffffff" | "#000000", amount: number): string {
  const source = Number.parseInt(hex.slice(1), 16);
  const destination = Number.parseInt(target.slice(1), 16);
  const channel = (shift: number): number => {
    const from = (source >> shift) & 255;
    const to = (destination >> shift) & 255;
    return Math.round(from + (to - from) * amount);
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixColors(first: string, second: string, amount: number): string {
  const source = Number.parseInt(first.slice(1), 16);
  const destination = Number.parseInt(second.slice(1), 16);
  const channel = (shift: number): number => {
    const from = (source >> shift) & 255;
    const to = (destination >> shift) & 255;
    return Math.round(from + (to - from) * amount);
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function relativeLuminance(hex: string): number {
  const source = Number.parseInt(hex.slice(1), 16);
  const linearChannel = (shift: number): number => {
    const channel = ((source >> shift) & 255) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearChannel(16) + 0.7152 * linearChannel(8) + 0.0722 * linearChannel(0);
}

function contrastRatio(background: string, foreground: string): number {
  const backgroundLuminance = relativeLuminance(background);
  const foregroundLuminance = relativeLuminance(foreground);
  const lighter = Math.max(backgroundLuminance, foregroundLuminance);
  const darker = Math.min(backgroundLuminance, foregroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function bestContrastForeground(background: string): string {
  return contrastRatio(background, LIGHT_FOREGROUND) >= contrastRatio(background, DARK_FOREGROUND)
    ? LIGHT_FOREGROUND
    : DARK_FOREGROUND;
}

function hueToRgb(p: number, q: number, t: number): number {
  let normalized = t;
  if (normalized < 0) normalized += 1;
  if (normalized > 1) normalized -= 1;
  if (normalized < 1 / 6) return p + (q - p) * 6 * normalized;
  if (normalized < 1 / 2) return q;
  if (normalized < 2 / 3) return p + (q - p) * (2 / 3 - normalized) * 6;
  return p;
}

export function deterministicProjectColor(value: string): string {
  let hash = 2166136261;
  for (const character of value.normalize("NFKC")) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360 / 360;
  const saturation = 0.58;
  const lightness = 0.31;
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return `#${[hueToRgb(p, q, hue + 1 / 3), hueToRgb(p, q, hue), hueToRgb(p, q, hue - 1 / 3)]
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function graphemes(value: string): string[] {
  return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)]
    .map((entry) => entry.segment);
}

function graphemeWidth(value: string): number {
  if (/^\s$/u.test(value)) return 0.33;
  if (/^[ilI1|.,:;!'`´]$/u.test(value)) return 0.32;
  if (/^[MW@%&#QGÖÜÄ]$/u.test(value)) return 0.86;
  if (/^[A-ZÀ-Þ]$/u.test(value)) return 0.68;
  if (/^[0-9]$/u.test(value)) return 0.56;
  if (/^[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(value)) return 1;
  return 0.55;
}

function width(value: string): number {
  return graphemes(value).reduce((sum, character) => sum + graphemeWidth(character), 0);
}

export function wrapKeyText(value: string, maximumEm: number, maximumLines: number): readonly string[] {
  const normalized = value.replace(/\s+/gu, " ").trim() || "New Task";
  if (maximumLines <= 0 || maximumEm <= 0) return Object.freeze([]);
  const characters = graphemes(normalized);
  const lines: string[] = [];
  let cursor = 0;
  while (cursor < characters.length && lines.length < maximumLines) {
    while (/^\s$/u.test(characters[cursor] ?? "")) cursor += 1;
    if (cursor >= characters.length) break;
    let end = cursor;
    let lastBreak = -1;
    while (end < characters.length) {
      const candidate = characters.slice(cursor, end + 1).join("").trimEnd();
      if (width(candidate) > maximumEm) break;
      end += 1;
      const previous = characters[end - 1] ?? "";
      const next = characters[end] ?? "";
      const whitespaceBreak = /^\s$/u.test(previous);
      const punctuationBreak = /^[-/–—]$/u.test(previous);
      const camelCaseBreak = /[\p{Ll}\d]/u.test(previous) && /\p{Lu}/u.test(next);
      if (whitespaceBreak || punctuationBreak || camelCaseBreak) lastBreak = end;
    }
    if (end >= characters.length) {
      lines.push(characters.slice(cursor).join("").trim());
      cursor = characters.length;
      break;
    }
    const cut = lastBreak > cursor ? lastBreak : Math.max(cursor + 1, end);
    lines.push(characters.slice(cursor, cut).join("").trim());
    cursor = cut;
  }
  if (cursor < characters.length && lines.length > 0) {
    let last = `${lines.at(-1) ?? ""}…`;
    while (width(last) > maximumEm && graphemes(last).length > 1) {
      const remaining = graphemes(last);
      remaining.pop();
      remaining.pop();
      last = `${remaining.join("").trim()}…`;
    }
    lines[lines.length - 1] = last;
  }
  return Object.freeze(lines);
}

function renderTextLines(
  lines: readonly string[],
  x: number,
  anchor: "start" | "middle" | "end",
  firstBaseline: number,
  lineHeight: number,
  fontSize: number,
  fontWeight: number,
  fill: string,
): string {
  return lines.map((line, index) =>
    `<text x="${x}" y="${firstBaseline + index * lineHeight}" text-anchor="${anchor}" xml:space="preserve" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}">${escapeXml(line)}</text>`,
  ).join("");
}

function normalizeInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function normalizeIntensity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function compactDecimal(value: number): string {
  return value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

export function renderKeySvg(model: KeyRenderModel): string {
  const taskPosition = normalizeInteger(model.taskPosition, 1, 99, 1);
  const font = normalizeInteger(model.titleFontSize, 8, 12, 10) * 2;
  const projectFont = normalizeInteger(model.projectFontSize, 6, 12, 8) * 2;
  const timeFont = normalizeInteger(model.timeFontSize, 5, 10, 6) * 2;
  const alignment = model.textAlignment === "center" || model.textAlignment === "right"
    ? model.textAlignment
    : "left";
  const textPosition = alignment === "left"
    ? { x: 10, anchor: "start" as const }
    : alignment === "center"
      ? { x: 72, anchor: "middle" as const }
      : { x: 134, anchor: "end" as const };
  const status: RenderStatus = model.kind === "task" ? (model.status ?? "unknown")
    : model.kind === "empty" ? "empty" : "unknown";
  const colors = model.colors ?? DEFAULT_TASK_KEY_COLORS;
  const accent = status === "empty" || status === "unknown" ? KEY_PALETTE[status] : colors[status];
  const source = Number.parseInt(accent.slice(1), 16);
  const linearChannel = (shift: number): number => {
    const channel = ((source >> shift) & 255) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linearChannel(16) + 0.7152 * linearChannel(8) + 0.0722 * linearChannel(0);
  const isDark = luminance < 0.42;
  const title = model.kind === "empty" ? "No Task"
    : model.kind === "loading" ? "Loading…"
      : model.kind === "unavailable" ? "Offline"
        : (model.title?.replace(/\s+/gu, " ").trim() || "New Task");
  const projectLabel = model.kind === "task" ? (model.projectLabel?.replace(/\s+/gu, " ").trim() ?? "") : "";
  const hasProject = projectLabel.length > 0;
  const projectBarPadding = 3;
  const projectBarHeight = hasProject ? projectFont + projectBarPadding * 2 : 0;
  const projectTextBaseline = projectBarPadding + projectFont * 0.95;
  const titleFirstBaseline = hasProject ? projectBarHeight + 25 : 31;
  const titleLines = wrapKeyText(title, 124 / font, hasProject ? 3 : 4);
  const projectLines = hasProject ? wrapKeyText(projectLabel, 124 / projectFont, 1) : [];
  const foreground = bestContrastForeground(accent);
  const statusProjectBar = mix(accent, "#000000", 0.28);
  const projectColorAmount = normalizeInteger(model.projectColorOpacity, 0, 100, 60) / 100;
  const projectBar = hasProject && model.projectColorEnabled === true
    ? mixColors(statusProjectBar, deterministicProjectColor(projectLabel), projectColorAmount)
    : statusProjectBar;
  const projectForeground = bestContrastForeground(projectBar);
  const taskChangeFooterBar = mix(accent, "#000000", 0.72);
  const animation = model.animation;
  const animationIntensity = normalizeIntensity(animation?.intensity);
  const animationPhase = normalizeIntensity(animation?.phase);
  const animated = animation !== undefined && animationIntensity > 0;
  const isWorkingNoise = animated && animation.kind === "working-noise";
  const isDoneBurst = animated && animation.kind === "done-burst";
  const animationAccent = isDoneBurst ? colors.done : accent;
  const glowDeviation = animated
    ? compactDecimal(6 + animationIntensity * (isWorkingNoise ? 5.4 : 11))
    : "6";
  const baseGlowOpacity = isDark ? 0.18 : 0.72;
  const glowOpacity = animated
    ? compactDecimal(Math.min(1, baseGlowOpacity + animationIntensity * 0.55))
    : compactDecimal(baseGlowOpacity);
  const animationTint = mix(animationAccent, "#ffffff", isDoneBurst ? 0.68 : 0.52);
  const animationFillOpacity = compactDecimal(animationIntensity * (isDoneBurst ? 0.5 : 0.58));
  const animationStrokeWidth = compactDecimal(2 + animationIntensity * (isDoneBurst ? 10 : 8));
  const animationStrokeOpacity = compactDecimal(Math.min(1, animationIntensity * 1.15));
  const workingTextureScale = 2.4;
  const workingTileSize = 72 * workingTextureScale;
  const workingCoordinate = (value: number): string => compactDecimal(value * workingTextureScale);
  const workingGrainOpacity = (value: number): string => compactDecimal(Math.min(1, value * 1.35));
  const workingPatternOffset = compactDecimal(-workingTileSize * animationPhase);
  const workingLight = mix(accent, "#ffffff", 1);
  const workingDark = mix(accent, "#000000", 0.44);
  const burstRadius = 10 + animationPhase * 88;
  const burstSparkles = isDoneBurst
    ? Array.from({ length: 10 }, (_, index) => {
      const angle = index / 10 * Math.PI * 2;
      const distance = burstRadius * (index % 2 === 0 ? 0.82 : 0.62);
      const x = compactDecimal(72 + Math.cos(angle) * distance);
      const y = compactDecimal(72 + Math.sin(angle) * distance);
      const radius = compactDecimal(1.8 + animationIntensity * (index % 2 === 0 ? 2.4 : 1.2));
      return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${animationTint}" fill-opacity="${animationStrokeOpacity}"/>`;
    }).join("")
    : "";
  const lineHeight = font * 1.04;
  const activityLabel = model.kind === "task" ? (model.activityLabel?.trim() ?? "") : "";
  const taskChangeStats = model.kind === "task" ? model.taskChangeStats : undefined;
  const taskChangeFooter = taskChangeStats === undefined ? "" : [
    taskChangeStats.added > 0 ? `<tspan fill="#9bf396">+${taskChangeStats.added}</tspan>` : "",
    taskChangeStats.deleted > 0 ? `<tspan fill="#ff7373">&#160;-${taskChangeStats.deleted}</tspan>` : "",
  ].join("");
  const queuedMessageCount = model.kind === "task"
    ? normalizeInteger(model.queuedMessageCount, 1, 256, 0) : 0;
  const badgeFontSize = normalizeInteger(model.badgeFontSize, 8, 18, 15);
  const queueBadgeLabel = queuedMessageCount > 0 ? `+${queuedMessageCount}` : "";
  const queueBadgeWidth = queueBadgeLabel.length > 0
    ? Math.max(28, Math.ceil(13 + queueBadgeLabel.length * badgeFontSize * 2 / 3)) : 0;
  const goalBadgeWidth = model.kind === "task" && model.hasOngoingGoal === true ? 24 : 0;
  const hasBadges = queueBadgeWidth > 0 || goalBadgeWidth > 0;
  const badgePosition = model.badgePosition ?? "top-right";
  const badgesAtBottom = badgePosition === "bottom-left"
    || badgePosition === "bottom-right"
    || badgePosition === "bottom-replaces-git";
  const showBadges = hasBadges && !(model.offlineWarning && badgesAtBottom);
  const badgesReplaceFooter = showBadges && badgePosition === "bottom-replaces-git";
  const showTaskChangeFooter = !model.offlineWarning && taskChangeFooter.length > 0 && !badgesReplaceFooter;
  const badgeGap = queueBadgeWidth > 0 && goalBadgeWidth > 0 ? 4 : 0;
  const badgeGroupWidth = queueBadgeWidth + badgeGap + goalBadgeWidth;
  const badgesOnLeft = badgePosition === "top-left" || badgePosition === "bottom-left";
  const badgeGroupX = badgePosition === "bottom-replaces-git"
    ? 72 - badgeGroupWidth / 2
    : badgesOnLeft ? 8 : 136 - badgeGroupWidth;
  const badgeY = badgePosition === "bottom-left"
    || badgePosition === "bottom-right"
    || badgePosition === "bottom-replaces-git" ? 113 : 9;
  const goalBadgeX = badgeGroupX;
  const queueBadgeX = badgeGroupX + goalBadgeWidth + badgeGap;
  const badgeBackground = "#0b3155";
  const queueBadgeBaseline = compactDecimal(badgeY + 11 + badgeFontSize * 0.34);
  const queueBadge = queueBadgeWidth === 0 ? "" : `<g data-badge="queue"><rect x="${queueBadgeX}" y="${badgeY}" width="${queueBadgeWidth}" height="22" rx="11" fill="${badgeBackground}"/><text x="${queueBadgeX + queueBadgeWidth / 2}" y="${queueBadgeBaseline}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${badgeFontSize}" font-weight="800" fill="#ffffff">${queueBadgeLabel}</text></g>`;
  const goalBadge = goalBadgeWidth === 0 ? "" : `<g data-badge="goal"><rect x="${goalBadgeX}" y="${badgeY}" width="${goalBadgeWidth}" height="22" rx="11" fill="${badgeBackground}"/><g transform="translate(${goalBadgeX + 12} ${badgeY + 11})" fill="none" stroke="#ffffff" stroke-width="1.8"><circle r="6"/><circle r="2.5"/><path d="M0-8v3M0 5v3M-8 0h3M5 0h3" stroke-linecap="round"/></g></g>`;
  const badges = showBadges
    ? `<g data-badges-position="${badgePosition}">${goalBadge}${queueBadge}</g>` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144" role="img" aria-label="Task ${taskPosition}: ${escapeXml(title)}, ${status}${model.offlineWarning ? ", offline" : ""}">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${mix(accent, "#ffffff", isDark ? 0.08 : 0.18)}"/>
      <stop offset="0.58" stop-color="${accent}"/>
      <stop offset="1" stop-color="${mix(accent, "#000000", isDark ? 0.18 : 0.14)}"/>
    </linearGradient>
    <radialGradient id="highlight" cx="0.5" cy="0.04" r="0.85">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${isDark ? 0.16 : 0.55}"/>
      <stop offset="0.68" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    ${isWorkingNoise ? `<linearGradient id="workingBand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${workingDark}"/>
      <stop offset="0.28" stop-color="${accent}"/>
      <stop offset="0.52" stop-color="${workingLight}"/>
      <stop offset="0.78" stop-color="${accent}"/>
      <stop offset="1" stop-color="${workingDark}"/>
    </linearGradient>
    <pattern id="workingNoise" width="${compactDecimal(workingTileSize)}" height="${compactDecimal(workingTileSize)}" patternUnits="userSpaceOnUse" patternTransform="translate(${workingPatternOffset} 0)">
      <rect width="${compactDecimal(workingTileSize)}" height="${compactDecimal(workingTileSize)}" fill="url(#workingBand)"/>
      <rect x="${compactDecimal(workingTileSize * 0.46)}" width="${compactDecimal(workingTileSize * 0.12)}" height="${compactDecimal(workingTileSize)}" fill="${workingLight}" fill-opacity="0.35"/>
      <path d="M${workingCoordinate(82)} ${workingCoordinate(-8)}L${workingCoordinate(28)} ${workingCoordinate(80)}M${workingCoordinate(52)} ${workingCoordinate(-8)}L${workingCoordinate(-2)} ${workingCoordinate(80)}" stroke="${workingLight}" stroke-width="${workingCoordinate(7)}" stroke-opacity="${workingGrainOpacity(0.24)}"/>
      <path d="M${workingCoordinate(68)} ${workingCoordinate(-8)}L${workingCoordinate(14)} ${workingCoordinate(80)}M${workingCoordinate(98)} ${workingCoordinate(-8)}L${workingCoordinate(44)} ${workingCoordinate(80)}" stroke="${workingDark}" stroke-width="${workingCoordinate(11)}" stroke-opacity="${workingGrainOpacity(0.22)}"/>
      <circle cx="${workingCoordinate(7)}" cy="${workingCoordinate(11)}" r="${workingCoordinate(2.4)}" fill="${workingLight}" fill-opacity="${workingGrainOpacity(0.8)}"/>
      <circle cx="${workingCoordinate(19)}" cy="${workingCoordinate(47)}" r="${workingCoordinate(1.5)}" fill="${workingDark}" fill-opacity="${workingGrainOpacity(0.75)}"/>
      <circle cx="${workingCoordinate(31)}" cy="${workingCoordinate(23)}" r="${workingCoordinate(3.2)}" fill="${workingLight}" fill-opacity="${workingGrainOpacity(0.44)}"/>
      <circle cx="${workingCoordinate(44)}" cy="${workingCoordinate(61)}" r="${workingCoordinate(2.2)}" fill="${workingLight}" fill-opacity="${workingGrainOpacity(0.66)}"/>
      <circle cx="${workingCoordinate(58)}" cy="${workingCoordinate(34)}" r="${workingCoordinate(1.8)}" fill="${workingDark}" fill-opacity="${workingGrainOpacity(0.8)}"/>
      <circle cx="${workingCoordinate(67)}" cy="${workingCoordinate(8)}" r="${workingCoordinate(1.3)}" fill="${workingLight}" fill-opacity="${workingGrainOpacity(0.72)}"/>
      <path d="M${workingCoordinate(3)} ${workingCoordinate(34)}h${workingCoordinate(9)}M${workingCoordinate(35)} ${workingCoordinate(8)}h${workingCoordinate(12)}M${workingCoordinate(51)} ${workingCoordinate(49)}h${workingCoordinate(8)}M${workingCoordinate(14)} ${workingCoordinate(66)}h${workingCoordinate(13)}" stroke="${workingLight}" stroke-width="${workingCoordinate(2)}" stroke-linecap="round" stroke-opacity="${workingGrainOpacity(0.58)}"/>
    </pattern>` : ""}
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="0" stdDeviation="${glowDeviation}" flood-color="${animationAccent}" flood-opacity="${glowOpacity}"/>
      <feDropShadow dx="0" dy="5" stdDeviation="6" flood-color="#000000" flood-opacity="0.32"/>
    </filter>
    <clipPath id="key"><rect x="4" y="4" width="136" height="136" rx="16"/></clipPath>
  </defs>
  <g filter="url(#glow)">
    <rect x="4" y="4" width="136" height="136" rx="16" fill="url(#base)"/>
    <rect x="4" y="4" width="136" height="136" rx="16" fill="url(#highlight)"/>
  </g>
  <g clip-path="url(#key)">
    ${hasProject ? `<rect x="4" y="4" width="136" height="${projectBarHeight}" fill="${projectBar}"/>` : ""}
    ${isWorkingNoise ? `<rect data-animation="working-noise" x="4" y="4" width="136" height="136" rx="16" fill="url(#workingNoise)" fill-opacity="0.72"/>` : ""}
    ${animated && !isWorkingNoise && !isDoneBurst ? `<rect data-animation="status-flash" x="4" y="4" width="136" height="136" rx="16" fill="${animationTint}" fill-opacity="${animationFillOpacity}" stroke="${animationTint}" stroke-opacity="${animationStrokeOpacity}" stroke-width="${animationStrokeWidth}"/>` : ""}
    ${isDoneBurst ? `<g data-animation="done-burst"><rect x="4" y="4" width="136" height="136" rx="16" fill="${animationTint}" fill-opacity="${animationFillOpacity}"/><circle cx="72" cy="72" r="${compactDecimal(burstRadius)}" fill="none" stroke="${animationTint}" stroke-width="${animationStrokeWidth}" stroke-opacity="${animationStrokeOpacity}"/>${burstSparkles}</g>` : ""}
    ${showTaskChangeFooter ? `<rect data-footer="task-changes" x="4" y="116" width="136" height="24" fill="${taskChangeFooterBar}"/>` : ""}
    ${hasProject ? renderTextLines(projectLines, textPosition.x, textPosition.anchor, projectTextBaseline, 0, projectFont, 650, projectForeground) : ""}
    ${renderTextLines(titleLines, textPosition.x, textPosition.anchor, titleFirstBaseline, lineHeight, font, 700, foreground)}
    ${model.offlineWarning ? `<text x="${textPosition.x}" y="133" text-anchor="${textPosition.anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${timeFont}" font-weight="800" letter-spacing="0.3" fill="#ffd166">OFFLINE</text>` : showTaskChangeFooter ? `<text x="${textPosition.x}" y="133" text-anchor="${textPosition.anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${timeFont}" font-weight="800">${taskChangeFooter}</text>` : !badgesReplaceFooter && activityLabel.length > 0 ? `<text x="${textPosition.x}" y="133" text-anchor="${textPosition.anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${timeFont}" font-weight="700" fill="${foreground}" fill-opacity="0.72">${escapeXml(activityLabel)}</text>` : ""}
    ${badges}
  </g>
  ${model.borderEnabled !== false ? `<rect x="5" y="5" width="134" height="134" rx="15" fill="none" stroke="${statusProjectBar}" stroke-width="2"/>` : ""}
</svg>`;
}

export function toSvgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
