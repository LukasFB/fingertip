import path from "node:path";

import { parseTaskId, type TaskId } from "./catalog-projection.ts";

export interface WorkspaceMetadata {
  readonly projectlessTaskIds: ReadonlySet<TaskId>;
  readonly taskRootHints: ReadonlyMap<TaskId, string>;
  readonly taskProjectRoots: ReadonlyMap<TaskId, string>;
  readonly savedRoots: readonly string[];
  readonly selectedProjectRoots: readonly string[];
  readonly rootLabels: ReadonlyMap<string, string>;
  readonly pinnedTaskIds: readonly TaskId[];
  readonly pinnedProjectIds: readonly string[];
  readonly projectOrder: readonly string[];
  readonly projectThreadOrders: ReadonlyMap<string, SidebarThreadOrder>;
  readonly projectlessThreadOrder: SidebarThreadOrder | null;
  readonly sidebarMode: "project" | "list";
  readonly sidebarSortMode: SidebarSortMode;
  readonly projectSortMode: SidebarSortMode;
  readonly queuedFollowUpCounts: ReadonlyMap<TaskId, number>;
}

function queuedFollowUpCounts(value: unknown): ReadonlyMap<TaskId, number> {
  if (!isRecord(value) || Object.keys(value).length > 10_000) return new Map();
  const counts = new Map<TaskId, number>();
  for (const [candidateId, messages] of Object.entries(value)) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 256) continue;
    try {
      counts.set(parseTaskId(candidateId), messages.length);
    } catch {
      // Queue metadata is auxiliary and may evolve independently of sidebar state.
    }
  }
  return counts;
}

export type SidebarSortMode = "manual" | "priority" | "updated_at";

export interface SidebarThreadOrder {
  readonly threadIds: readonly TaskId[];
  readonly sortKey?: "created_at" | "updated_at";
}

function fail(message: string): never {
  throw new TypeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedArray(root: Record<string, unknown>, key: string, maximum: number): unknown[] {
  const value = root[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(`invalid ${key}`);
  return value;
}

function selectedRecord(root: Record<string, unknown>, key: string, maximum: number): Record<string, unknown> {
  const value = root[key];
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > maximum) fail(`invalid ${key}`);
  return value;
}

function parsePath(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || Buffer.byteLength(value, "utf8") > 4_096) {
    fail("invalid workspace path");
  }
  return path.normalize(value);
}

function parseLabel(value: unknown): string {
  if (typeof value !== "string") fail("invalid workspace label");
  const normalized = value.replace(/\s+/gu, " ").trim();
  const length = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(normalized)].length;
  if (length === 0 || length > 256) fail("invalid workspace label");
  return normalized;
}

function uniqueTaskIds(value: unknown, key: string): readonly TaskId[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 10_000) fail(`invalid ${key}`);
  return Object.freeze([...new Set(value.map(parseTaskId))]);
}

function localProjectPaths(value: unknown, key: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 2_000) fail(`invalid ${key}`);
  const paths = value.flatMap((candidate) => {
    if (typeof candidate !== "string" || Buffer.byteLength(candidate, "utf8") > 4_096) fail(`invalid ${key}`);
    return path.isAbsolute(candidate) ? [path.normalize(candidate)] : [];
  });
  return Object.freeze([...new Set(paths)]);
}

interface LocalProjectMetadata {
  readonly rootsById: ReadonlyMap<string, readonly string[]>;
  readonly labelsByRoot: ReadonlyMap<string, string>;
}

function localProjectMetadata(value: unknown): LocalProjectMetadata {
  if (value === undefined) return { rootsById: new Map(), labelsByRoot: new Map() };
  if (!isRecord(value) || Object.keys(value).length > 2_000) fail("invalid local-projects");
  const projects = value;
  const rootsById = new Map<string, readonly string[]>();
  const labelsByRoot = new Map<string, string>();
  for (const [id, project] of Object.entries(projects)) {
    if (!isRecord(project)) fail("invalid local-projects");
    if (project.id !== undefined && project.id !== id) fail("invalid local-projects.id");
    const roots = localProjectPaths(project.rootPaths, "local-projects.rootPaths");
    rootsById.set(id, roots);
    const name = project.name;
    if (name !== undefined) {
      if (typeof name !== "string") fail("invalid local-projects.name");
      const label = parseLabel(name);
      for (const root of roots) labelsByRoot.set(root, label);
    }
  }
  return { rootsById, labelsByRoot };
}

function projectReferences(
  value: unknown,
  key: string,
  rootsByLocalProjectId: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 2_000) fail(`invalid ${key}`);
  const roots = value.flatMap((candidate) => {
    if (typeof candidate !== "string" || Buffer.byteLength(candidate, "utf8") > 4_096) fail(`invalid ${key}`);
    if (path.isAbsolute(candidate)) return [path.normalize(candidate)];
    return rootsByLocalProjectId.get(candidate) ?? [];
  });
  return Object.freeze([...new Set(roots)]);
}

function selectedProjectRoots(
  value: unknown,
  rootsByLocalProjectId: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (!isRecord(value) || value.type !== "local" || typeof value.projectId !== "string") {
    return Object.freeze([]);
  }
  return projectReferences([value.projectId], "selected-project.projectId", rootsByLocalProjectId);
}

function taskProjectRoots(
  value: unknown,
  rootsByLocalProjectId: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<TaskId, string> {
  if (value === undefined) return new Map();
  if (!isRecord(value) || Object.keys(value).length > 10_000) fail("invalid thread-project-assignments");
  const roots = new Map<TaskId, string>();
  for (const [id, assignment] of Object.entries(value)) {
    if (!isRecord(assignment)) fail("invalid thread-project-assignments");
    if (assignment.projectKind !== "local" || typeof assignment.projectId !== "string") continue;
    const candidates = rootsByLocalProjectId.get(assignment.projectId) ?? [];
    const cwd = assignment.cwd;
    const assignedRoot = typeof cwd === "string" && path.isAbsolute(cwd)
      ? candidates.filter((root) => isWithinRoot(path.normalize(cwd), root))
        .sort((left, right) => right.length - left.length)[0]
      : candidates[0];
    if (assignedRoot !== undefined) roots.set(parseTaskId(id), assignedRoot);
  }
  return roots;
}

function parseSidebarThreadOrder(value: unknown, key: string): SidebarThreadOrder {
  if (!isRecord(value)) fail(`invalid ${key}`);
  const threadIds = uniqueTaskIds(value.threadIds, `${key}.threadIds`);
  if (value.sortKey !== undefined && value.sortKey !== "created_at" && value.sortKey !== "updated_at") {
    fail(`invalid ${key}.sortKey`);
  }
  return value.sortKey === undefined
    ? Object.freeze({ threadIds })
    : Object.freeze({ threadIds, sortKey: value.sortKey });
}

function sidebarPreferences(value: unknown): {
  readonly mode: "project" | "list";
  readonly sortMode: SidebarSortMode;
  readonly projectSortMode: SidebarSortMode;
  readonly projectlessOrder: SidebarThreadOrder | null;
} {
  const atoms = isRecord(value) ? value : {};
  const preferences = isRecord(atoms["flat-project-sidebar-preferences-v1"])
    ? atoms["flat-project-sidebar-preferences-v1"] : {};
  const mode = preferences.mode === "list" ? "list" : "project";
  const preferredSort = mode === "list" ? preferences.chatSortMode : preferences.projectSortMode;
  const override = atoms["codex-sidebar-sort-mode-v1"];
  const candidate = override ?? preferredSort;
  const sortMode: SidebarSortMode = candidate === "manual" || candidate === "updated_at" || candidate === "priority"
    ? candidate : "priority";
  const projectSortMode: SidebarSortMode = preferences.projectSortMode === "manual"
    || preferences.projectSortMode === "updated_at"
    || preferences.projectSortMode === "priority"
    ? preferences.projectSortMode : "priority";
  const projectless = atoms["codex-sidebar-chat-order-v1"];
  return Object.freeze({
    mode,
    sortMode,
    projectSortMode,
    projectlessOrder: projectless === undefined ? null : parseSidebarThreadOrder(projectless, "codex-sidebar-chat-order-v1"),
  });
}

export function projectWorkspaceMetadata(value: unknown): WorkspaceMetadata {
  if (!isRecord(value)) fail("global state must be an object");
  const projectless = new Set<TaskId>();
  for (const id of selectedArray(value, "projectless-thread-ids", 10_000)) projectless.add(parseTaskId(id));

  const hints = new Map<TaskId, string>();
  for (const [id, root] of Object.entries(selectedRecord(value, "thread-workspace-root-hints", 10_000))) {
    hints.set(parseTaskId(id), parsePath(root));
  }

  const legacyRoots = selectedArray(value, "electron-saved-workspace-roots", 2_000).map(parsePath);
  const activeRoots = selectedArray(value, "active-workspace-roots", 2_000).map(parsePath);
  const localProjects = localProjectMetadata(value["local-projects"]);
  const rootsByLocalProjectId = localProjects.rootsById;
  const localRoots = [...rootsByLocalProjectId.values()].flat();
  const labels = new Map<string, string>(localProjects.labelsByRoot);
  for (const [root, label] of Object.entries(selectedRecord(value, "electron-workspace-root-labels", 2_000))) {
    labels.set(parsePath(root), parseLabel(label));
  }
  const pinnedTaskIds = uniqueTaskIds(value["pinned-thread-ids"], "pinned-thread-ids");
  const activeProjectRoots = selectedProjectRoots(value["selected-project"], rootsByLocalProjectId);
  const assignedTaskRoots = taskProjectRoots(value["thread-project-assignments"], rootsByLocalProjectId);
  const pinnedProjectIds = projectReferences(
    value["pinned-project-ids"],
    "pinned-project-ids",
    rootsByLocalProjectId,
  );
  const projectOrder = projectReferences(value["project-order"], "project-order", rootsByLocalProjectId);
  const projectThreadOrders = new Map<string, SidebarThreadOrder>();
  for (const [projectReference, order] of Object.entries(selectedRecord(value, "sidebar-project-thread-orders", 2_000))) {
    const parsedOrder = parseSidebarThreadOrder(order, "sidebar-project-thread-orders");
    const projectRoots = path.isAbsolute(projectReference)
      ? [path.normalize(projectReference)]
      : rootsByLocalProjectId.get(projectReference) ?? [];
    for (const root of projectRoots) projectThreadOrders.set(root, parsedOrder);
  }
  const preferences = sidebarPreferences(value["electron-persisted-atom-state"]);
  const queuedCounts = queuedFollowUpCounts(value["queued-follow-ups"]);
  return Object.freeze({
    projectlessTaskIds: projectless,
    taskRootHints: hints,
    taskProjectRoots: assignedTaskRoots,
    savedRoots: Object.freeze([...new Set([...legacyRoots, ...activeRoots, ...localRoots])]),
    selectedProjectRoots: activeProjectRoots,
    rootLabels: labels,
    pinnedTaskIds,
    pinnedProjectIds,
    projectOrder,
    projectThreadOrders,
    projectlessThreadOrder: preferences.projectlessOrder,
    sidebarMode: preferences.mode,
    sidebarSortMode: preferences.sortMode,
    projectSortMode: preferences.projectSortMode,
    queuedFollowUpCounts: queuedCounts,
  });
}

function isWithinRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(`${root}${path.sep}`);
}

export function resolveProjectRoot(
  task: { readonly id: string; readonly cwd: string },
  metadata: WorkspaceMetadata,
): string | undefined {
  const id = parseTaskId(task.id);
  if (metadata.projectlessTaskIds.has(id)) return undefined;
  const assignedRoot = metadata.taskProjectRoots.get(id);
  if (assignedRoot !== undefined) return assignedRoot;
  const savedRoots = new Set(metadata.savedRoots);
  const hinted = metadata.taskRootHints.get(id);
  let root = hinted !== undefined && savedRoots.has(hinted) ? hinted : undefined;
  if (root === undefined) {
    const cwd = path.normalize(task.cwd);
    root = metadata.savedRoots
      .filter((candidate) => isWithinRoot(cwd, candidate))
      .sort((left, right) => right.length - left.length)[0];
  }
  if (root === undefined) return undefined;
  return root;
}

export function resolveProjectLabel(
  task: { readonly id: string; readonly cwd: string },
  metadata: WorkspaceMetadata,
): string | undefined {
  const root = resolveProjectRoot(task, metadata);
  return root === undefined ? undefined : (metadata.rootLabels.get(root) ?? path.basename(root));
}
