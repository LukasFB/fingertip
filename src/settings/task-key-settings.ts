import type { JsonObject } from "@elgato/utils";

export interface TaskKeyColors {
  readonly idle: string;
  readonly working: string;
  readonly done: string;
  readonly waiting: string;
  readonly confirmation: string;
}

export const DEFAULT_TASK_KEY_COLORS: TaskKeyColors = Object.freeze({
  idle: "#06090b",
  working: "#9cd5fe",
  done: "#9bf396",
  waiting: "#ffd0b8",
  confirmation: "#ffad28",
});

const LEGACY_CONFIRMATION_COLOR = "#ff7373";

export interface TaskKeySettings extends JsonObject {
  readonly version: 7;
  readonly taskPosition: number;
  readonly taskSource: TaskKeySource;
}

export type TaskKeySource = "pinned-projects" | "tasks";
export type TaskKeyBadgePosition = "top-right" | "top-left" | "bottom-left" | "bottom-right" | "bottom-replaces-git";
export type TaskKeyBadgeAppearanceSettings = Pick<
  TaskKeyAppearanceSettings,
  "showQueueBadge" | "showGoalBadge" | "badgePosition"
>;

export type TaskKeyTextAlignment = "left" | "center" | "right";
export type ChatGptWindowTarget = "last-active" | "leftmost" | "rightmost";
export type TaskNotificationMode = "off" | "toast" | "sound" | "both";
export type TaskNotificationStatus = "done" | "confirmation";
export type TaskNotificationSoundSource = "system" | "custom";
export const MAC_SYSTEM_SOUNDS = Object.freeze([
  "Basso",
  "Blow",
  "Bottle",
  "Frog",
  "Funk",
  "Glass",
  "Hero",
  "Morse",
  "Ping",
  "Pop",
  "Purr",
  "Sosumi",
  "Submarine",
  "Tink",
] as const);
export type TaskNotificationSound = typeof MAC_SYSTEM_SOUNDS[number];

export interface TaskKeyAppearanceSettings extends JsonObject {
  readonly version: 11;
  readonly windowTarget: ChatGptWindowTarget;
  readonly titleFontSize: number;
  readonly projectFontSize: number;
  readonly timeFontSize: number;
  readonly textAlignment: TaskKeyTextAlignment;
  readonly borderEnabled: boolean;
  readonly showGitDiffStats: boolean;
  readonly showQueueBadge: boolean;
  readonly showGoalBadge: boolean;
  readonly badgePosition: TaskKeyBadgePosition;
  readonly badgeFontSize: number;
  readonly idleColor: string;
  readonly workingColor: string;
  readonly doneColor: string;
  readonly waitingColor: string;
  readonly confirmationColor: string;
  readonly doneNotification: TaskNotificationMode;
  readonly doneSoundSource: TaskNotificationSoundSource;
  readonly doneSound: TaskNotificationSound;
  readonly doneVolume: number;
  readonly confirmationNotification: TaskNotificationMode;
  readonly confirmationSoundSource: TaskNotificationSoundSource;
  readonly confirmationSound: TaskNotificationSound;
  readonly confirmationVolume: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerInRange(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value)
    ? value.toLowerCase()
    : fallback;
}

function textAlignment(value: unknown): TaskKeyTextAlignment {
  return value === "center" || value === "right" ? value : "left";
}

function taskSource(value: unknown): TaskKeySource {
  return value === "tasks" ? "tasks" : "pinned-projects";
}

function badgePosition(value: unknown): TaskKeyBadgePosition {
  return value === "top-left"
    || value === "bottom-left"
    || value === "bottom-right"
    || value === "bottom-replaces-git"
    ? value : "top-right";
}

function windowTarget(value: unknown): ChatGptWindowTarget {
  return value === "leftmost" || value === "rightmost" ? value : "last-active";
}

function notificationMode(value: unknown): TaskNotificationMode {
  return value === "toast" || value === "sound" || value === "both" ? value : "off";
}

function notificationSound(value: unknown, fallback: TaskNotificationSound): TaskNotificationSound {
  return MAC_SYSTEM_SOUNDS.some((sound) => sound === value)
    ? value as TaskNotificationSound
    : fallback;
}

function notificationSoundSource(value: unknown, legacySound: unknown): TaskNotificationSoundSource {
  return value === "custom" || legacySound === "custom" ? "custom" : "system";
}

export function normalizeTaskKeySettings(value: unknown): TaskKeySettings {
  const record = isRecord(value) ? value : {};
  return Object.freeze({
    version: 7,
    taskPosition: integerInRange(record.taskPosition, 1, 99, 1),
    taskSource: taskSource(record.taskSource),
  });
}

export function normalizeTaskKeyAppearanceSettings(value: unknown): TaskKeyAppearanceSettings {
  const record = isRecord(value) ? value : {};
  const normalizedIdle = color(record.idleColor, DEFAULT_TASK_KEY_COLORS.idle);
  const idleColor = record.version === 1 && normalizedIdle === "#343842"
    ? DEFAULT_TASK_KEY_COLORS.idle
    : normalizedIdle;
  const normalizedConfirmation = color(record.confirmationColor, DEFAULT_TASK_KEY_COLORS.confirmation);
  const confirmationColor = typeof record.version === "number"
    && record.version <= 7
    && normalizedConfirmation === LEGACY_CONFIRMATION_COLOR
    ? DEFAULT_TASK_KEY_COLORS.confirmation
    : normalizedConfirmation;
  return Object.freeze({
    version: 11,
    windowTarget: windowTarget(record.windowTarget),
    titleFontSize: integerInRange(record.titleFontSize, 8, 12, 10),
    projectFontSize: integerInRange(record.projectFontSize, 6, 12, 8),
    timeFontSize: integerInRange(record.timeFontSize, 5, 10, 6),
    textAlignment: textAlignment(record.textAlignment),
    borderEnabled: typeof record.borderEnabled === "boolean" ? record.borderEnabled : true,
    showGitDiffStats: record.showGitDiffStats === true,
    showQueueBadge: record.showQueueBadge === true,
    showGoalBadge: record.showGoalBadge === true,
    badgePosition: badgePosition(record.badgePosition),
    badgeFontSize: integerInRange(record.badgeFontSize, 8, 18, 15),
    idleColor,
    workingColor: color(record.workingColor, DEFAULT_TASK_KEY_COLORS.working),
    doneColor: color(record.doneColor, DEFAULT_TASK_KEY_COLORS.done),
    waitingColor: color(record.waitingColor, DEFAULT_TASK_KEY_COLORS.waiting),
    confirmationColor,
    doneNotification: notificationMode(record.doneNotification),
    doneSoundSource: notificationSoundSource(record.doneSoundSource, record.doneSound),
    doneSound: notificationSound(record.doneSound, "Glass"),
    doneVolume: integerInRange(record.doneVolume, 0, 100, 100),
    confirmationNotification: notificationMode(record.confirmationNotification),
    confirmationSoundSource: notificationSoundSource(record.confirmationSoundSource, record.confirmationSound),
    confirmationSound: notificationSound(record.confirmationSound, "Basso"),
    confirmationVolume: integerInRange(record.confirmationVolume, 0, 100, 100),
  });
}

export const DEFAULT_TASK_KEY_APPEARANCE = normalizeTaskKeyAppearanceSettings(undefined);

export function taskKeyColors(settings: TaskKeyAppearanceSettings): TaskKeyColors {
  return Object.freeze({
    idle: settings.idleColor,
    working: settings.workingColor,
    done: settings.doneColor,
    waiting: settings.waitingColor,
    confirmation: settings.confirmationColor,
  });
}

export function legacyTaskKeyAppearance(value: unknown): TaskKeyAppearanceSettings | null {
  if (!isRecord(value) || value.version !== 2) {
    return null;
  }
  return normalizeTaskKeyAppearanceSettings({ ...value, version: 1 });
}

export function legacyTaskKeyBadgeAppearance(value: unknown): TaskKeyBadgeAppearanceSettings | null {
  if (!isRecord(value) || value.version !== 6) return null;
  const candidate = Object.freeze({
    showQueueBadge: value.showQueueBadge === true,
    showGoalBadge: value.showGoalBadge === true,
    badgePosition: badgePosition(value.badgePosition),
  });
  return candidate.showQueueBadge || candidate.showGoalBadge || candidate.badgePosition !== "top-right"
    ? candidate : null;
}

export function taskKeySettingsNeedWriteback(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    return true;
  }
  const normalized = normalizeTaskKeySettings(value);
  return value.version !== normalized.version
    || value.taskPosition !== normalized.taskPosition
    || value.taskSource !== normalized.taskSource;
}

export function taskKeyAppearanceSettingsNeedWriteback(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 25) {
    return true;
  }
  const normalized = normalizeTaskKeyAppearanceSettings(value);
  return value.version !== normalized.version
    || value.windowTarget !== normalized.windowTarget
    || value.titleFontSize !== normalized.titleFontSize
    || value.projectFontSize !== normalized.projectFontSize
    || value.timeFontSize !== normalized.timeFontSize
    || value.textAlignment !== normalized.textAlignment
    || value.borderEnabled !== normalized.borderEnabled
    || value.showGitDiffStats !== normalized.showGitDiffStats
    || value.showQueueBadge !== normalized.showQueueBadge
    || value.showGoalBadge !== normalized.showGoalBadge
    || value.badgePosition !== normalized.badgePosition
    || value.badgeFontSize !== normalized.badgeFontSize
    || value.idleColor !== normalized.idleColor
    || value.workingColor !== normalized.workingColor
    || value.doneColor !== normalized.doneColor
    || value.waitingColor !== normalized.waitingColor
    || value.confirmationColor !== normalized.confirmationColor
    || value.doneNotification !== normalized.doneNotification
    || value.doneSoundSource !== normalized.doneSoundSource
    || value.doneSound !== normalized.doneSound
    || value.doneVolume !== normalized.doneVolume
    || value.confirmationNotification !== normalized.confirmationNotification
    || value.confirmationSoundSource !== normalized.confirmationSoundSource
    || value.confirmationSound !== normalized.confirmationSound
    || value.confirmationVolume !== normalized.confirmationVolume;
}
