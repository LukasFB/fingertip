import {
  DEFAULT_TASK_KEY_APPEARANCE,
  legacyTaskKeyBadgeAppearance,
  legacyTaskKeyAppearance,
  normalizeTaskKeyAppearanceSettings,
  taskKeyAppearanceSettingsNeedWriteback,
  type TaskKeyAppearanceSettings,
  type TaskKeyBadgeAppearanceSettings,
} from "./task-key-settings.ts";

interface AppearanceSettingsControllerOptions {
  readonly apply: (settings: TaskKeyAppearanceSettings) => void;
  readonly write: (settings: TaskKeyAppearanceSettings) => Promise<void>;
}

function hasSettings(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

export class AppearanceSettingsController {
  readonly #options: AppearanceSettingsControllerOptions;
  #loaded = false;
  #explicit = false;
  #legacyCandidate: TaskKeyAppearanceSettings | null = null;
  #legacyBadgeCandidate: TaskKeyBadgeAppearanceSettings | null = null;
  #legacyOrderingCandidate = false;
  #current = DEFAULT_TASK_KEY_APPEARANCE;
  #explicitBadgeSettings = false;
  #explicitOrderingSetting = false;

  constructor(options: AppearanceSettingsControllerOptions) {
    this.#options = options;
  }

  async offerLegacy(value: unknown): Promise<void> {
    if (this.#explicit || this.#legacyCandidate !== null) return;
    const candidate = legacyTaskKeyAppearance(value);
    if (candidate === null) return;
    this.#legacyCandidate = candidate;
    if (this.#loaded) await this.#adopt(candidate);
  }

  async offerLegacyBadges(value: unknown): Promise<void> {
    if (this.#explicitBadgeSettings || this.#legacyBadgeCandidate !== null) return;
    const candidate = legacyTaskKeyBadgeAppearance(value);
    if (candidate === null) return;
    this.#legacyBadgeCandidate = candidate;
    if (this.#loaded) await this.#adoptLegacyBadges();
  }

  async offerLegacyOrdering(value: unknown): Promise<void> {
    if (this.#explicitOrderingSetting || this.#legacyOrderingCandidate
      || !hasEnabledLegacyOrdering(value)) return;
    this.#legacyOrderingCandidate = true;
    if (this.#loaded) await this.#adoptLegacyOrdering();
  }

  async load(value: unknown): Promise<void> {
    this.#loaded = true;
    if (hasSettings(value)) {
      await this.#receiveExplicit(value);
      await this.#adoptLegacyBadges();
      await this.#adoptLegacyOrdering();
      return;
    }
    if (this.#legacyCandidate !== null) {
      await this.#adopt(this.#legacyCandidate);
      await this.#adoptLegacyBadges();
      await this.#adoptLegacyOrdering();
      return;
    }
    this.#apply(DEFAULT_TASK_KEY_APPEARANCE);
    await this.#adoptLegacyBadges();
    await this.#adoptLegacyOrdering();
  }

  async receive(value: unknown): Promise<void> {
    if (!hasSettings(value)) return;
    await this.#receiveExplicit(value);
  }

  async #receiveExplicit(value: unknown): Promise<void> {
    this.#explicit = true;
    if (hasExplicitBadgeSettings(value)) {
      this.#explicitBadgeSettings = true;
      this.#legacyBadgeCandidate = null;
    }
    if (hasExplicitOrderingSetting(value)) {
      this.#explicitOrderingSetting = true;
      this.#legacyOrderingCandidate = false;
    }
    const settings = normalizeTaskKeyAppearanceSettings(value);
    this.#apply(settings);
    if (taskKeyAppearanceSettingsNeedWriteback(value)) await this.#options.write(settings);
  }

  async #adopt(settings: TaskKeyAppearanceSettings): Promise<void> {
    if (this.#explicit) return;
    this.#explicit = true;
    this.#apply(settings);
    await this.#options.write(settings);
  }

  async #adoptLegacyBadges(): Promise<void> {
    const candidate = this.#legacyBadgeCandidate;
    if (candidate === null || this.#explicitBadgeSettings) return;
    this.#legacyBadgeCandidate = null;
    this.#explicitBadgeSettings = true;
    const settings = normalizeTaskKeyAppearanceSettings({ ...this.#current, ...candidate });
    this.#apply(settings);
    await this.#options.write(settings);
  }

  async #adoptLegacyOrdering(): Promise<void> {
    if (!this.#legacyOrderingCandidate || this.#explicitOrderingSetting) return;
    this.#legacyOrderingCandidate = false;
    this.#explicitOrderingSetting = true;
    const settings = normalizeTaskKeyAppearanceSettings({
      ...this.#current,
      moveActiveUnreadThreadsToTop: true,
    });
    this.#apply(settings);
    await this.#options.write(settings);
  }

  #apply(settings: TaskKeyAppearanceSettings): void {
    this.#current = settings;
    this.#options.apply(settings);
  }
}

function hasExplicitBadgeSettings(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.showQueueBadge === true
    || record.showGoalBadge === true
    || record.badgePosition === "top-left"
    || record.badgePosition === "bottom-left"
    || record.badgePosition === "bottom-right"
    || record.badgePosition === "bottom-replaces-git";
}

function hasEnabledLegacyOrdering(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).moveActiveUnreadThreadsToTop === true;
}

function hasExplicitOrderingSetting(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof (value as Record<string, unknown>).moveActiveUnreadThreadsToTop === "boolean";
}
