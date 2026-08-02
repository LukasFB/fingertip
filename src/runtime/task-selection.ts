import { taskAtPosition, type CatalogTask } from "../catalog/task-feed.ts";
import type { CatalogState, DesktopState, LiveFreshness } from "./key-presentation.ts";
import type { TaskKeySettings } from "../settings/task-key-settings.ts";
import type { TaskStatus } from "../status/task-status-projector.ts";

export interface TaskSelectionLiveState {
  readonly freshness: LiveFreshness;
  readonly status: TaskStatus | null;
}

export interface TaskSelectionContext {
  readonly catalogState: CatalogState;
  readonly desktopState: DesktopState;
  readonly liveByTaskId: ReadonlyMap<string, TaskSelectionLiveState>;
}

function isSettled(task: CatalogTask, context: TaskSelectionContext): boolean {
  const live = context.liveByTaskId.get(task.id);
  if (live === undefined || live.status === null || live.status === "idle") return true;
  return live.freshness === "stale"
    && context.desktopState === "online"
    && context.catalogState === "fresh";
}

function isReorderedTask(task: CatalogTask, settings: TaskKeySettings): boolean {
  return task.source === settings.taskSource && task.pinned !== true;
}

function orderedTasksForKey(
  feed: readonly CatalogTask[],
  settings: TaskKeySettings,
  context: TaskSelectionContext,
): readonly CatalogTask[] {
  const selected = feed.filter((task) => task.source === settings.taskSource);
  if (!settings.moveActiveUnreadThreadsToTop) return selected;

  const reorderableTasks = selected.filter((task) => isReorderedTask(task, settings));
  const prioritizedTasks = [
    ...reorderableTasks.filter((task) => !isSettled(task, context)),
    ...reorderableTasks.filter((task) => isSettled(task, context)),
  ];
  let reorderIndex = 0;
  return selected.map((task) => {
    if (!isReorderedTask(task, settings)) return task;
    const prioritized = prioritizedTasks[reorderIndex];
    reorderIndex += 1;
    if (prioritized === undefined) throw new TypeError("task ordering invariant failed");
    return prioritized;
  });
}

export function taskAtPositionForKey(
  feed: readonly CatalogTask[],
  settings: TaskKeySettings,
  context: TaskSelectionContext,
): CatalogTask | null {
  return taskAtPosition(orderedTasksForKey(feed, settings, context), settings.taskPosition);
}

export function needsTaskStatusHydration(settings: TaskKeySettings): boolean {
  return settings.moveActiveUnreadThreadsToTop;
}
