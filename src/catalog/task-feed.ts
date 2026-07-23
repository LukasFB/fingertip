import { parseTaskId, type TaskId } from "./catalog-projection.ts";
import { resolveProjectLabel, resolveProjectRoot, type WorkspaceMetadata } from "./project-label-resolver.ts";

export type CatalogTaskSource = "pinned-projects" | "tasks";

export interface CatalogTask {
  readonly id: TaskId;
  readonly createdAt: number;
  readonly activityAt: number;
  readonly title: string;
  readonly source: CatalogTaskSource;
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
    const source: CatalogTaskSource = sourceMetadata.pinnedTaskIds.includes(id)
      || resolveProjectRoot({ id, cwd: task.cwd }, sourceMetadata) !== undefined
      ? "pinned-projects"
      : "tasks";
    const activityAt = task.recencyAt ?? task.createdAt;
    return projectLabel === undefined
      ? Object.freeze({ id, createdAt: task.createdAt, activityAt, title: task.title, source })
      : Object.freeze({ id, createdAt: task.createdAt, activityAt, title: task.title, source, projectLabel });
  }));
}

export function taskAtPosition(
  feed: readonly CatalogTask[],
  position: number,
  source?: CatalogTaskSource,
): CatalogTask | null {
  if (!Number.isInteger(position) || position < 1 || position > 99) return null;
  const selected = source === undefined ? feed : feed.filter((task) => task.source === source);
  return selected[position - 1] ?? null;
}
