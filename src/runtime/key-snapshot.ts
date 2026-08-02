import { parseTaskId, type TaskId } from "../catalog/catalog-projection.ts";
import type { CatalogTask } from "../catalog/task-feed.ts";
import type { TaskKeyAppearanceSettings, TaskKeySettings } from "../settings/task-key-settings.ts";
import type { TaskStatus } from "../status/task-status-projector.ts";
import { formatTaskActivityTime } from "../rendering/relative-task-time.ts";
import type { TaskChangeStats } from "../task-change-stats.ts";
import {
  projectKeyPresentation,
  type CatalogState,
  type DesktopState,
  type LiveFreshness,
} from "./key-presentation.ts";
import { taskAtPositionForKey } from "./task-selection.ts";

interface NonTaskKeySnapshot {
  readonly kind: "loading" | "unavailable" | "empty";
  readonly settings: TaskKeySettings;
  readonly appearance: TaskKeyAppearanceSettings;
  readonly offlineWarning: boolean;
  readonly pressTarget: null;
  readonly renderSignature: string;
}

export interface TaskKeySnapshot {
  readonly kind: "task";
  readonly settings: TaskKeySettings;
  readonly appearance: TaskKeyAppearanceSettings;
  readonly taskId: TaskId;
  readonly title: string;
  readonly projectLabel?: string;
  readonly status: TaskStatus | null;
  readonly activityLabel: string;
  readonly taskChangeStats?: TaskChangeStats;
  readonly queuedMessageCount?: number;
  readonly hasOngoingGoal?: true;
  readonly highlighted?: true;
  readonly liveFreshness: LiveFreshness;
  readonly offlineWarning: boolean;
  readonly pressTarget: `codex://threads/${string}`;
  readonly renderSignature: string;
}

export type KeySnapshot = NonTaskKeySnapshot | TaskKeySnapshot;

export interface KeySnapshotInput {
  readonly settings: TaskKeySettings;
  readonly appearance: TaskKeyAppearanceSettings;
  readonly catalog: {
    readonly state: CatalogState;
    readonly feed: readonly (Omit<CatalogTask, "id"> & { readonly id: string })[] | null;
  };
  readonly desktopState: DesktopState;
  readonly liveByTaskId: ReadonlyMap<string, {
    readonly freshness: LiveFreshness;
    readonly status: TaskStatus | null;
    readonly queuedFollowUpCount?: number;
  }>;
  readonly now: number;
  readonly taskChangeStatsByTaskId?: ReadonlyMap<string, TaskChangeStats>;
  readonly ongoingGoalByTaskId?: ReadonlyMap<string, boolean>;
  readonly queuedFollowUpCountByTaskId?: ReadonlyMap<string, number>;
  readonly highlightedTaskIds?: ReadonlySet<string>;
}

export function createKeySnapshot(input: KeySnapshotInput): KeySnapshot {
  const feedMustBeNull = input.catalog.state === "cold" || input.catalog.state === "unavailable";
  const feedMustExist = input.catalog.state === "fresh" || input.catalog.state === "stale";
  if ((feedMustBeNull && input.catalog.feed !== null) || (feedMustExist && input.catalog.feed === null)) {
    throw new TypeError("invalid catalog view invariant");
  }
  const task = input.catalog.feed === null
    ? null
    : taskAtPositionForKey(input.catalog.feed as readonly CatalogTask[], input.settings, {
      catalogState: input.catalog.state,
      desktopState: input.desktopState,
      liveByTaskId: input.liveByTaskId,
    });
  const live = task === null
    ? null
    : input.liveByTaskId.get(task.id) ?? { freshness: "none" as const, status: null };
  const presentation = projectKeyPresentation({
    catalogState: input.catalog.state,
    feedAvailable: input.catalog.feed !== null,
    desktopState: input.desktopState,
    task: live,
  });

  if (presentation.kind !== "task") {
    const signature = JSON.stringify({
      kind: presentation.kind,
      position: input.settings.taskPosition,
      source: input.settings.taskSource,
      appearance: input.appearance,
      offline: presentation.offlineWarning,
    });
    return Object.freeze({
      kind: presentation.kind,
      settings: input.settings,
      appearance: input.appearance,
      offlineWarning: presentation.offlineWarning,
      pressTarget: null,
      renderSignature: signature,
    });
  }

  if (task === null || live === null) throw new TypeError("task presentation requires a catalog Task");
  const id = parseTaskId(task.id);
  const activityLabel = formatTaskActivityTime(task.activityAt, input.now);
  const candidateTaskChangeStats = input.appearance.showGitDiffStats
    ? input.taskChangeStatsByTaskId?.get(id) : undefined;
  const taskChangeStats = candidateTaskChangeStats !== undefined
    && (candidateTaskChangeStats.added > 0 || candidateTaskChangeStats.deleted > 0)
    ? candidateTaskChangeStats : undefined;
  const candidateQueuedMessageCount = live.queuedFollowUpCount
    ?? input.queuedFollowUpCountByTaskId?.get(id);
  const queuedMessageCount = input.appearance.showQueueBadge
    && input.desktopState === "online"
    && (candidateQueuedMessageCount ?? 0) > 0
    ? candidateQueuedMessageCount : undefined;
  const hasOngoingGoal = input.appearance.showGoalBadge
    && input.ongoingGoalByTaskId?.get(id) === true;
  const highlighted = input.highlightedTaskIds?.has(id) === true;
  const hasBadges = queuedMessageCount !== undefined || hasOngoingGoal;
  const signatureFields = {
    kind: "task",
    position: input.settings.taskPosition,
    source: input.settings.taskSource,
    appearance: input.appearance,
    taskId: id,
    title: task.title,
    project: task.projectLabel,
    status: presentation.status,
    freshness: live.freshness,
    activityLabel,
    taskChangeStats,
    queuedMessageCount,
    ...(hasOngoingGoal ? { hasOngoingGoal: true } : {}),
    ...(highlighted ? { highlighted: true } : {}),
    ...(hasBadges ? { badgePosition: input.appearance.badgePosition } : {}),
    offline: presentation.offlineWarning,
  };
  const common = {
    kind: "task" as const,
    settings: input.settings,
    appearance: input.appearance,
    taskId: id,
    title: task.title,
    status: presentation.status,
    activityLabel,
    ...(taskChangeStats === undefined ? {} : { taskChangeStats }),
    ...(queuedMessageCount === undefined ? {} : { queuedMessageCount }),
    ...(hasOngoingGoal ? { hasOngoingGoal: true as const } : {}),
    ...(highlighted ? { highlighted: true as const } : {}),
    liveFreshness: live.freshness,
    offlineWarning: presentation.offlineWarning,
    pressTarget: `codex://threads/${id}` as const,
    renderSignature: JSON.stringify(signatureFields),
  };
  return task.projectLabel === undefined
    ? Object.freeze(common)
    : Object.freeze({ ...common, projectLabel: task.projectLabel });
}
