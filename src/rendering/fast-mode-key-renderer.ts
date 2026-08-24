import { toSvgDataUrl } from "./svg-key-renderer.ts";

export type FastModeVisualState = "standard" | "fast" | "unknown";

export const FAST_MODE_ANIMATION_FPS = 30;
export const FAST_MODE_ANIMATION_DURATION_SECONDS = 4;
export const FAST_MODE_ANIMATION_FRAME_COUNT = FAST_MODE_ANIMATION_FPS
  * FAST_MODE_ANIMATION_DURATION_SECONDS;

const FAST_BOLT = "M82 10 42 63h25l-12 49 51-65H79z";
const FAST_BOLT_COLOR = "#ffad28";
const FAST_HOT_COLOR = "#fff1a0";
const FAST_BACKGROUND = "#06090b";
const FAST_ARC_COUNT = 12;
const FAST_SPARK_COUNT = 60;

function normalizedPhase(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.25;
  return ((value % 1) + 1) % 1;
}

function decimal(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/u, "");
}

function seeded(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43_758.5453;
  return value - Math.floor(value);
}

function fastArcPath(index: number, phase: number): string {
  const anchors = [[79, 20], [50, 59], [66, 68], [59, 102], [96, 55], [81, 47]] as const;
  const anchor = anchors[index % anchors.length] ?? anchors[0];
  const angle = seeded(index + 4) * Math.PI * 2
    + Math.sin(phase * Math.PI * 2 + index * 1.7) * 0.16;
  const targetX = 72 + Math.cos(angle) * 67;
  const targetY = 61 + Math.sin(angle) * 55;
  const deltaX = targetX - anchor[0];
  const deltaY = targetY - anchor[1];
  const length = Math.hypot(deltaX, deltaY) || 1;
  const normalX = -deltaY / length;
  const normalY = deltaX / length;
  const points = Array.from({ length: 9 }, (_, pointIndex) => {
    const progress = pointIndex / 8;
    const envelope = Math.sin(progress * Math.PI);
    const periodic = Math.sin(phase * Math.PI * 2 * (2 + index % 3)
      + pointIndex * 2.31 + index);
    const noise = (seeded(index * 31 + pointIndex * 17) - 0.5) * 2;
    const offset = (periodic * 3.5 + noise * 5.5) * envelope * 1.3;
    return [
      anchor[0] + deltaX * progress + normalX * offset,
      anchor[1] + deltaY * progress + normalY * offset,
    ] as const;
  });
  return points.map(([x, y], pointIndex) =>
    `${pointIndex === 0 ? "M" : "L"}${decimal(x)} ${decimal(y)}`).join(" ");
}

function renderFastAnimation(phaseValue: number | undefined): string {
  const phase = normalizedPhase(phaseValue);
  const pulse = 0.82 + 0.18 * Math.sin(phase * Math.PI * 2) ** 2;
  const arcs = Array.from({ length: FAST_ARC_COUNT }, (_, index) => {
    const flicker = 0.2 + 0.8 * Math.pow(Math.max(0,
      Math.sin(phase * Math.PI * 2 * (3 + index % 3) + index * 2.17)), 2);
    return `<path d="${fastArcPath(index + 1, phase)}" fill="none" stroke="${FAST_HOT_COLOR}" stroke-opacity="${decimal(Math.min(1, flicker * 1.3))}" stroke-width=".85" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("");
  const sparks = Array.from({ length: FAST_SPARK_COUNT }, (_, index) => {
    const angle = seeded(index + 301) * Math.PI * 2;
    const orbit = 19 + seeded(index + 501) * 42;
    const motion = Math.sin(phase * Math.PI * 2 * (1 + index % 4) + index) * 5;
    const x = 72 + Math.cos(angle) * (orbit + motion);
    const y = 60 + Math.sin(angle) * (orbit + motion) * 0.86;
    const opacity = 0.15 + 0.85 * Math.pow(Math.max(0,
      Math.sin(phase * Math.PI * 2 * (2 + index % 5) + index)), 4);
    return `<circle cx="${decimal(x)}" cy="${decimal(y)}" r="${decimal(0.35 + seeded(index + 800) * 0.7)}" fill="${index % 3 === 0 ? FAST_HOT_COLOR : FAST_BOLT_COLOR}" fill-opacity="${decimal(opacity)}"/>`;
  }).join("");
  const sweepX = decimal((phase * 1.4 % 1) * 195 - 35);
  return `<defs>
    <clipPath id="fast-clip"><rect x="4" y="4" width="136" height="136" rx="16"/></clipPath>
    <radialGradient id="fast-aura"><stop stop-color="${FAST_HOT_COLOR}" stop-opacity="${decimal(0.34 * pulse)}"/><stop offset=".45" stop-color="${FAST_BOLT_COLOR}" stop-opacity="${decimal(0.24 * pulse)}"/><stop offset="1" stop-color="${FAST_BOLT_COLOR}" stop-opacity="0"/></radialGradient>
    <linearGradient id="fast-bolt" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${FAST_HOT_COLOR}"/><stop offset=".42" stop-color="${FAST_BOLT_COLOR}"/><stop offset=".8" stop-color="${FAST_BOLT_COLOR}"/><stop offset="1" stop-color="${FAST_HOT_COLOR}"/></linearGradient>
    <linearGradient id="fast-sweep" gradientUnits="userSpaceOnUse" x1="${sweepX}" y1="0" x2="${decimal(Number(sweepX) + 36)}" y2="0"><stop stop-color="${FAST_HOT_COLOR}" stop-opacity="0"/><stop offset=".5" stop-color="${FAST_HOT_COLOR}" stop-opacity=".82"/><stop offset="1" stop-color="${FAST_HOT_COLOR}" stop-opacity="0"/></linearGradient>
    <filter id="fast-glow" x="-80%" y="-80%" width="260%" height="260%"><feDropShadow dx="0" dy="0" stdDeviation="${decimal(8 + 5 * pulse)}" flood-color="${FAST_BOLT_COLOR}" flood-opacity=".96"/></filter>
    <filter id="fast-arc-glow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="2.6" flood-color="${FAST_BOLT_COLOR}" flood-opacity=".92"/></filter>
  </defs>
  <rect width="144" height="144" rx="16" fill="${FAST_BACKGROUND}"/>
  <circle cx="72" cy="72" r="70" fill="url(#fast-aura)"/>
  <g data-animation="fast-electric" data-frame-phase="${decimal(phase)}" clip-path="url(#fast-clip)" transform="translate(0 12)">
    <g data-arcs="${FAST_ARC_COUNT}" filter="url(#fast-arc-glow)">${arcs}</g>
    <g data-sparks="${FAST_SPARK_COUNT}" filter="url(#fast-arc-glow)">${sparks}</g>
    <path d="${FAST_BOLT}" fill="${FAST_BOLT_COLOR}" fill-opacity=".48" filter="url(#fast-glow)"/>
    <path d="${FAST_BOLT}" fill="url(#fast-bolt)" stroke="${FAST_HOT_COLOR}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="${FAST_BOLT}" fill="url(#fast-sweep)" opacity=".9"/>
  </g>`;
}

export function renderFastModeKeyDataUrl(input: {
  readonly state: FastModeVisualState;
  readonly offline: boolean;
  readonly animationPhase?: number;
}): string {
  if (input.state === "fast" && !input.offline) {
    return toSvgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">${renderFastAnimation(input.animationPhase)}</svg>`);
  }
  const unknown = input.state === "unknown";
  const accent = input.offline ? "#ffd166" : unknown ? "#66717d" : "#ffffff";
  return toSvgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="${accent}" flood-opacity=".3"/></filter></defs>
  <rect width="144" height="144" rx="16" fill="${FAST_BACKGROUND}"/>
  <path d="${FAST_BOLT}" transform="translate(0 12)" fill="none" stroke="${accent}" stroke-width="7" stroke-linejoin="round" filter="url(#glow)"/>
  </svg>`);
}
