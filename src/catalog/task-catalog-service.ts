import type { CatalogState } from "../runtime/key-presentation.ts";
import {
  projectThreadListResult,
  type ProjectableCatalogTask,
  type ProjectedThreadListResult,
} from "./catalog-projection.ts";
import { projectWorkspaceMetadata, resolveProjectRoot, type WorkspaceMetadata } from "./project-label-resolver.ts";
import { rankTasksLikeSidebar } from "./sidebar-task-ranker.ts";
import { buildTaskFeed, type CatalogTask } from "./task-feed.ts";
import type { TaskStatus } from "../status/task-status-projector.ts";

export interface CatalogRpcPort {
  listThreads(input: { readonly limit: number; readonly cursor?: string }): Promise<unknown>;
}

export interface CatalogView {
  readonly state: CatalogState;
  readonly feed: readonly CatalogTask[] | null;
}

interface TaskCatalogServiceOptions {
  readonly readMetadata: () => Promise<WorkspaceMetadata>;
}

const EMPTY_METADATA = projectWorkspaceMetadata({});

export type CatalogSchemaSignature = "thread-list" | "cursor";

export class CatalogSchemaError extends Error {
  readonly signature: CatalogSchemaSignature;

  constructor(signature: CatalogSchemaSignature) {
    super("catalog schema is incompatible");
    this.name = "CatalogSchemaError";
    this.signature = signature;
  }
}

export class TaskCatalogService {
  readonly #client: CatalogRpcPort;
  readonly #readMetadata: () => Promise<WorkspaceMetadata>;
  #view: CatalogView = Object.freeze({ state: "cold", feed: null });
  #refreshing = false;
  #sourceTasks: readonly ProjectableCatalogTask[] = Object.freeze([]);
  #rankingMetadata: WorkspaceMetadata = EMPTY_METADATA;
  #workspacePathByTaskId = new Map<string, string>();
  #selectedProjectTaskId: string | null = null;

  constructor(client: CatalogRpcPort, options: TaskCatalogServiceOptions) {
    this.#client = client;
    this.#readMetadata = options.readMetadata;
  }

  get view(): CatalogView {
    return this.#view;
  }

  workspacePath(taskId: string): string | null {
    return this.#workspacePathByTaskId.get(taskId) ?? null;
  }

  selectedProjectTaskId(): string | null {
    return this.#selectedProjectTaskId;
  }

  queuedFollowUpCounts(): ReadonlyMap<string, number> {
    return this.#rankingMetadata.queuedFollowUpCounts;
  }

  async refresh(
    greatestTaskPosition: number,
    statuses: ReadonlyMap<string, TaskStatus> = new Map(),
  ): Promise<readonly CatalogTask[]> {
    if (this.#refreshing) throw new Error("catalog refresh already in flight");
    this.#refreshing = true;
    try {
      void greatestTaskPosition;
      const tasks: ProjectableCatalogTask[] = [];
      let rawCount = 0;
      let cursor: string | undefined;
      let hasMore = true;
      const seenCursors = new Set<string>();
      do {
        const pageLimit = 500 - rawCount;
        const input = cursor === undefined ? { limit: pageLimit } : { limit: pageLimit, cursor };
        let page: ProjectedThreadListResult;
        try {
          page = projectThreadListResult(await this.#client.listThreads(input));
        } catch (error) {
          if (error instanceof TypeError) throw new CatalogSchemaError("thread-list");
          throw error;
        }
        rawCount += page.rawCount;
        if (rawCount > 500) throw new CatalogSchemaError("thread-list");
        tasks.push(...page.tasks);
        if (page.nextCursor === null) {
          hasMore = false;
          cursor = undefined;
        } else {
          cursor = page.nextCursor;
          if (Buffer.byteLength(cursor, "utf8") > 4_096 || seenCursors.has(cursor)) {
            throw new CatalogSchemaError("cursor");
          }
          seenCursors.add(cursor);
        }
      } while (hasMore && rawCount < 500);

      let metadata: WorkspaceMetadata;
      let metadataFresh = true;
      try {
        metadata = await this.#readMetadata();
      } catch {
        metadata = EMPTY_METADATA;
        metadataFresh = false;
      }
      const rankingMetadata = metadataFresh ? metadata : this.#rankingMetadata;
      const materializedThreadIds = this.#view.feed?.map(({ id }) => id) ?? [];
      const ranked = rankTasksLikeSidebar(tasks, rankingMetadata, statuses, materializedThreadIds);
      let feed = buildTaskFeed(ranked, metadata, rankingMetadata);
      if (!metadataFresh) {
        const previousLabels = new Map(
          (this.#view.feed ?? []).flatMap((task) => task.projectLabel === undefined ? [] : [[task.id, task.projectLabel] as const]),
        );
        feed = Object.freeze(feed.map((task) => {
          const previousLabel = previousLabels.get(task.id);
          return previousLabel === undefined ? task : Object.freeze({ ...task, projectLabel: previousLabel });
        }));
      }
      this.#sourceTasks = Object.freeze([...tasks]);
      this.#rankingMetadata = rankingMetadata;
      this.#workspacePathByTaskId = new Map(ranked.map((task) => [
        task.id,
        resolveProjectRoot(task, rankingMetadata) ?? task.cwd,
      ]));
      const selectedRoots = new Set(rankingMetadata.selectedProjectRoots);
      const selectedTasks = selectedRoots.size === 0 ? [] : ranked.filter((task) => {
        const root = resolveProjectRoot(task, rankingMetadata);
        return root !== undefined && selectedRoots.has(root);
      });
      this.#selectedProjectTaskId = selectedTasks.length === 1 ? selectedTasks[0]?.id ?? null : null;
      this.#view = Object.freeze({ state: "fresh", feed });
      return feed;
    } catch (error) {
      this.#view = this.#view.feed === null
        ? Object.freeze({ state: "unavailable", feed: null })
        : Object.freeze({ state: "stale", feed: this.#view.feed });
      throw error;
    } finally {
      this.#refreshing = false;
    }
  }

  rerank(statuses: ReadonlyMap<string, TaskStatus>): CatalogView {
    if (this.#view.feed === null || this.#sourceTasks.length === 0) return this.#view;
    const previousById = new Map(this.#view.feed.map((task) => [task.id, task]));
    const ranked = rankTasksLikeSidebar(
      this.#sourceTasks,
      this.#rankingMetadata,
      statuses,
      this.#view.feed.map(({ id }) => id),
    );
    const feed = Object.freeze(ranked.flatMap((task) => {
      const previous = previousById.get(task.id);
      return previous === undefined ? [] : [previous];
    }));
    this.#view = Object.freeze({ state: this.#view.state, feed });
    return this.#view;
  }
}
