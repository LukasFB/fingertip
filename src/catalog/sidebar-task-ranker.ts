import type { TaskStatus } from "../status/task-status-projector.ts";
import type { ProjectableCatalogTask, TaskId } from "./catalog-projection.ts";
import {
  resolveProjectRoot,
  type SidebarThreadOrder,
  type WorkspaceMetadata,
} from "./project-label-resolver.ts";

function byRecency(
  left: ProjectableCatalogTask,
  right: ProjectableCatalogTask,
): number {
  return right.recencyAt - left.recencyAt || right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt;
}

function sortedByOrderKey(
  tasks: readonly ProjectableCatalogTask[],
  key: "created_at" | "updated_at",
): readonly ProjectableCatalogTask[] {
  return [...tasks].sort((left, right) => key === "created_at"
    ? right.createdAt - left.createdAt
    : byRecency(left, right));
}

function manuallyOrdered(
  tasks: readonly ProjectableCatalogTask[],
  order: SidebarThreadOrder | null,
): readonly ProjectableCatalogTask[] {
  if (order === null) return tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const validOrder = order.threadIds.filter((id) => byId.has(id));
  const ordered = new Set(validOrder);
  let cursor = 0;
  const result: ProjectableCatalogTask[] = [];
  for (const task of tasks) {
    if (!ordered.has(task.id)) {
      result.push(task);
      continue;
    }
    const id = validOrder[cursor];
    cursor += 1;
    const replacement = id === undefined ? undefined : byId.get(id);
    if (replacement !== undefined) result.push(replacement);
  }
  return result;
}

function attentionRank(status: TaskStatus | undefined): number {
  if (status === "confirmation" || status === "waiting") return 0;
  if (status === "done") return 1;
  if (status === "working") return 2;
  return 3;
}

function orderedTasks(
  tasks: readonly ProjectableCatalogTask[],
  metadata: WorkspaceMetadata,
  statuses: ReadonlyMap<string, TaskStatus>,
  manualOrder: SidebarThreadOrder | null,
  materializedThreadIds: readonly TaskId[],
): readonly ProjectableCatalogTask[] {
  if (metadata.sidebarSortMode === "manual") {
    const effectiveOrder = manualOrder ?? (materializedThreadIds.length === 0
      ? null
      : { threadIds: materializedThreadIds });
    return manuallyOrdered(tasks, effectiveOrder);
  }
  if (metadata.sidebarSortMode === "updated_at") return sortedByOrderKey(tasks, "updated_at");
  return [...tasks].sort((left, right) =>
    attentionRank(statuses.get(left.id)) - attentionRank(statuses.get(right.id)) || byRecency(left, right));
}

export function rankTasksLikeSidebar(
  tasks: readonly ProjectableCatalogTask[],
  metadata: WorkspaceMetadata,
  statuses: ReadonlyMap<string, TaskStatus>,
  materializedThreadIds: readonly TaskId[] = [],
): readonly ProjectableCatalogTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const pinned = metadata.pinnedTaskIds.flatMap((id) => {
    const task = byId.get(id);
    return task === undefined ? [] : [task];
  });
  const pinnedIds = new Set(pinned.map((task) => task.id));
  const unpinned = tasks.filter((task) => !pinnedIds.has(task.id));

  if (metadata.sidebarMode === "list") {
    return Object.freeze([
      ...pinned,
      ...orderedTasks(unpinned, metadata, statuses, metadata.projectlessThreadOrder, materializedThreadIds),
    ]);
  }

  const groups = new Map<string, ProjectableCatalogTask[]>();
  const projectless: ProjectableCatalogTask[] = [];
  for (const task of unpinned) {
    const root = resolveProjectRoot(task, metadata);
    if (root === undefined) {
      projectless.push(task);
      continue;
    }
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [task]);
    else group.push(task);
  }

  const discoveredRoots = [...groups.keys()].sort((left, right) => {
    const leftRecency = Math.max(...(groups.get(left) ?? []).map((task) => task.recencyAt));
    const rightRecency = Math.max(...(groups.get(right) ?? []).map((task) => task.recencyAt));
    return rightRecency - leftRecency;
  });
  const discoveredSet = new Set(discoveredRoots);
  const pinnedRoots = metadata.pinnedProjectIds.filter((root) => discoveredSet.has(root));
  const pinnedRootSet = new Set(pinnedRoots);
  const unpinnedRoots = discoveredRoots.filter((root) => !pinnedRootSet.has(root));
  const unpinnedRootSet = new Set(unpinnedRoots);
  const configuredRoots = metadata.projectOrder.filter((root) => unpinnedRootSet.has(root));
  const configuredSet = new Set(configuredRoots);
  const orderedRoots = [
    ...unpinnedRoots.filter((root) => !configuredSet.has(root)),
    ...configuredRoots,
  ];
  const rankedProject = (root: string): readonly ProjectableCatalogTask[] => orderedTasks(
    groups.get(root) ?? [],
    metadata,
    statuses,
    metadata.projectThreadOrders.get(root) ?? null,
    materializedThreadIds,
  );
  return Object.freeze([
    ...pinned,
    ...pinnedRoots.flatMap(rankedProject),
    ...orderedRoots.flatMap(rankedProject),
    ...orderedTasks(projectless, metadata, statuses, metadata.projectlessThreadOrder, materializedThreadIds),
  ]);
}
