import { toSvgDataUrl } from "./svg-key-renderer.ts";

export type FastModeVisualState = "fast" | "standard" | "unknown";

export const FAST_MODE_ANIMATION_FPS = 30;
export const FAST_MODE_ANIMATION_DURATION_SECONDS = 4;
export const FAST_MODE_ANIMATION_FRAME_COUNT = FAST_MODE_ANIMATION_FPS
  * FAST_MODE_ANIMATION_DURATION_SECONDS;

const FAST_BOLT = "M82 12 42 73h25l-12 59 51-76H79z";
const FAST_BOLT_COLOR = "#ffad28";
const FAST_HOT_COLOR = "#fff1a0";
const FAST_BACKGROUND = "#06090b";
const FAST_GLOW_STRENGTH = 2.1;
const FAST_PULSE_STRENGTH = 0.44;
const FAST_ARC_COUNT = 12;
const FAST_ARC_ENERGY = 1.3;
const FAST_ARC_REACH = 1.13;
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
  const anchors = [[79, 24], [50, 69], [66, 78], [59, 119], [96, 65], [81, 57]] as const;
  const anchor = anchors[index % anchors.length] ?? anchors[0];
  const angle = seeded(index + 4) * Math.PI * 2
    + Math.sin(phase * Math.PI * 2 + index * 1.7) * 0.16;
  const radius = 62 * FAST_ARC_REACH;
  const targetX = 72 + Math.cos(angle) * radius;
  const targetY = 70 + Math.sin(angle) * radius;
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
    const offset = (periodic * 3.5 + noise * 5.5) * envelope * FAST_ARC_ENERGY;
    return [
      anchor[0] + deltaX * progress + normalX * offset,
      anchor[1] + deltaY * progress + normalY * offset,
    ] as const;
  });
  return points.map(([x, y], pointIndex) => `${pointIndex === 0 ? "M" : "L"}${decimal(x)} ${decimal(y)}`).join(" ");
}

function renderFastAnimation(phaseValue: number | undefined): string {
  const phase = normalizedPhase(phaseValue);
  const pulseWave = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  const shimmer = 0.5 + 0.5 * Math.sin(phase * Math.PI * 4 + 0.7);
  const pulse = 1 - FAST_PULSE_STRENGTH * 0.42
    + FAST_PULSE_STRENGTH * (0.68 * pulseWave + 0.32 * shimmer);
  const outerGlowWidth = decimal(8 + 7 * FAST_GLOW_STRENGTH * pulse);
  const innerGlowWidth = decimal(4 + 3 * FAST_GLOW_STRENGTH * pulse);
  const outerGlowOpacity = decimal(0.08 + 0.1 * pulse);
  const innerGlowOpacity = decimal(0.14 + 0.14 * pulse);
  const auraOpacity = Math.min(0.4, 0.14 * FAST_GLOW_STRENGTH * pulse);
  const arcs = Array.from({ length: FAST_ARC_COUNT }, (_, index) => {
    const flicker = 0.2 + 0.8 * Math.pow(Math.max(0,
      Math.sin(phase * Math.PI * 2 * (3 + index % 3) + index * 2.17)), 2);
    const opacity = decimal(Math.min(1, flicker * FAST_ARC_ENERGY));
    return `<path d="${fastArcPath(index + 1, phase)}" fill="none" stroke="${FAST_HOT_COLOR}" stroke-opacity="${opacity}" stroke-width=".85" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("");
  const sparks = Array.from({ length: FAST_SPARK_COUNT }, (_, index) => {
    const angle = seeded(index + 301) * Math.PI * 2;
    const orbit = 23 + seeded(index + 501) * 46;
    const motion = Math.sin(phase * Math.PI * 2 * (1 + index % 4) + index) * 5;
    const x = 72 + Math.cos(angle) * (orbit + motion);
    const y = 70 + Math.sin(angle) * (orbit + motion);
    const sparkPulse = 0.15 + 0.85 * Math.pow(Math.max(0,
      Math.sin(phase * Math.PI * 2 * (2 + index % 5) + index)), 4);
    const radius = 0.35 + seeded(index + 800) * 0.7;
    return `<circle cx="${decimal(x)}" cy="${decimal(y)}" r="${decimal(radius)}" fill="${index % 3 === 0 ? FAST_HOT_COLOR : FAST_BOLT_COLOR}" fill-opacity="${decimal(sparkPulse)}"/>`;
  }).join("");
  return `<defs>
    <clipPath id="fast-clip"><rect x="4" y="4" width="136" height="136" rx="16"/></clipPath>
    <radialGradient id="fast-aura"><stop offset="0" stop-color="${FAST_HOT_COLOR}" stop-opacity="${decimal(auraOpacity)}"/><stop offset=".42" stop-color="${FAST_BOLT_COLOR}" stop-opacity="${decimal(auraOpacity * 0.78)}"/><stop offset="1" stop-color="${FAST_BOLT_COLOR}" stop-opacity="0"/></radialGradient>
    <filter id="fast-arc-glow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="2.6" flood-color="${FAST_BOLT_COLOR}" flood-opacity=".92"/></filter>
  </defs>
  <rect width="144" height="144" rx="16" fill="${FAST_BACKGROUND}"/>
  <circle cx="72" cy="70" r="72" fill="url(#fast-aura)"/>
  <g data-animation="fast-electric" data-frame-phase="${decimal(phase)}" clip-path="url(#fast-clip)">
    <g data-arcs="${FAST_ARC_COUNT}" filter="url(#fast-arc-glow)">${arcs}</g>
    <g data-sparks="${FAST_SPARK_COUNT}" filter="url(#fast-arc-glow)">${sparks}</g>
    <path d="${FAST_BOLT}" fill="${FAST_BOLT_COLOR}" fill-opacity="${outerGlowOpacity}" stroke="${FAST_BOLT_COLOR}" stroke-opacity="${outerGlowOpacity}" stroke-width="${outerGlowWidth}" stroke-linejoin="round"/>
    <path d="${FAST_BOLT}" fill="${FAST_BOLT_COLOR}" fill-opacity="${innerGlowOpacity}" stroke="${FAST_HOT_COLOR}" stroke-opacity="${innerGlowOpacity}" stroke-width="${innerGlowWidth}" stroke-linejoin="round"/>
    <path d="${FAST_BOLT}" fill="${FAST_BOLT_COLOR}" stroke="${FAST_HOT_COLOR}" stroke-width="1.4" stroke-linejoin="round"/>
  </g>
  <text x="72" y="137" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="9" font-weight="800" letter-spacing=".7" fill="${FAST_HOT_COLOR}" filter="url(#fast-arc-glow)">FAST</text>
  <rect x="5" y="5" width="134" height="134" rx="15" fill="none" stroke="${FAST_BOLT_COLOR}" stroke-opacity=".5" stroke-width="2"/>`;
}

export function renderFastModeKeyDataUrl(input: {
  readonly state: FastModeVisualState;
  readonly offline: boolean;
  readonly animationPhase?: number;
}): string {
  const filled = input.state === "fast";
  if (filled && !input.offline) {
    return toSvgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">${renderFastAnimation(input.animationPhase)}</svg>`);
  }
  const color = input.state === "standard" ? FAST_BACKGROUND : "#343842";
  const foreground = "#f7f9fc";
  const label = input.offline ? "OFFLINE" : input.state === "unknown" ? "NO COMPOSER" : filled ? "FAST" : "STANDARD";
  return toSvgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <defs><radialGradient id="g" cx="50%" cy="0" r="90%"><stop offset="0" stop-color="#fff" stop-opacity=".10"/><stop offset=".72" stop-color="#fff" stop-opacity="0"/></radialGradient><filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="${color}" flood-opacity=".16"/></filter></defs>
  <rect x="4" y="4" width="136" height="136" rx="16" fill="${color}" filter="url(#glow)"/><rect x="4" y="4" width="136" height="136" rx="16" fill="url(#g)"/>
  <path d="${FAST_BOLT}" fill="none" stroke="${foreground}" stroke-width="7" stroke-linejoin="round"/>
  <text x="72" y="137" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="9" font-weight="800" letter-spacing=".7" fill="${input.offline ? "#ffd166" : foreground}" fill-opacity=".82">${label}</text>
  <rect x="5" y="5" width="134" height="134" rx="15" fill="none" stroke="#171b20" stroke-width="2"/></svg>`);
}
