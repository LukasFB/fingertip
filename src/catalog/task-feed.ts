import { parseTaskId, type TaskId } from "./catalog-projection.ts";
import { resolveProjectLabel, resolveProjectRoot, type WorkspaceMetadata } from "./project-label-resolver.ts";

export type CatalogTaskSource = "pinned-projects" | "tasks";

export interface CatalogTask {
  readonly id: TaskId;
  readonly createdAt: number;
  readonly activityAt: number;
  readonly title: string;
  readonly source: CatalogTaskSource;
  readonly pinned?: true;
  readonly projectLabel?: string;
}

function boundedProjectLabel(value: string): string {
  return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)]
    .slice(0, 128)
    .map((segment) => segment.segment)
    .join("");
}

export function buildTaskFeed(
  tasks: readonly {
    readonly id: string;
    readonly createdAt: number;
    readonly recencyAt?: number;
    readonly title: string;
    readonly cwd: string;
  }[],
  metadata: WorkspaceMetadata,
  sourceMetadata: WorkspaceMetadata = metadata,
): readonly CatalogTask[] {
  return Object.freeze(tasks.map((task) => {
    const id = parseTaskId(task.id);
    const resolvedLabel = resolveProjectLabel({ id, cwd: task.cwd }, metadata);
    const projectLabel = resolvedLabel === undefined ? undefined : boundedProjectLabel(resolvedLabel);
    const pinned = sourceMetadata.pinnedTaskIds.includes(id);
    const source: CatalogTaskSource = pinned
      || resolveProjectRoot({ id, cwd: task.cwd }, sourceMetadata) !== undefined
      ? "pinned-projects"
      : "tasks";
    const activityAt = task.recencyAt ?? task.createdAt;
    return projectLabel === undefined
      ? Object.freeze({
        id,
        createdAt: task.createdAt,
        activityAt,
        title: task.title,
        source,
        ...(pinned ? { pinned: true as const } : {}),
      })
      : Object.freeze({
        id,
        createdAt: task.createdAt,
        activityAt,
        title: task.title,
        source,
        ...(pinned ? { pinned: true as const } : {}),
        projectLabel,
      });
  }));
}

export function taskAtPosition(
  feed: readonly CatalogTask[],
  position: number,
  source?: CatalogTaskSource,
  include: (task: CatalogTask) => boolean = () => true,
): CatalogTask | null {
  if (!Number.isInteger(position) || position < 1 || position > 99) return null;
  const selected = feed.filter((task) => (source === undefined || task.source === source) && include(task));
  return selected[position - 1] ?? null;
}
