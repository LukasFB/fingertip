import type { TaskId } from "../catalog/catalog-projection.ts";
import type { TaskKeySettings } from "../settings/task-key-settings.ts";
import type { KeySnapshot } from "./key-snapshot.ts";
import { TaskKeyRenderQueue, type StreamDeckKeyImagePort } from "./task-key-render-queue.ts";

export interface TaskKeyActionPort extends StreamDeckKeyImagePort {
  readonly id: string;
}

export interface TaskNavigationPort {
  openTask(taskId: TaskId): Promise<boolean>;
}

export interface RegisteredTaskKey {
  readonly action: TaskKeyActionPort;
  settings: TaskKeySettings;
  readonly queue: TaskKeyRenderQueue;
  navigationFailed: boolean;
  propertyInspectorVisible: boolean;
}

export class TaskKeyRegistry {
  readonly #entries = new Map<string, RegisteredTaskKey>();
  readonly #onRenderStateChange: (actionId: string) => void;

  constructor(onRenderStateChange: (actionId: string) => void = () => undefined) {
    this.#onRenderStateChange = onRenderStateChange;
  }

  get size(): number {
    return this.#entries.size;
  }

  entries(): readonly RegisteredTaskKey[] {
    return Object.freeze([...this.#entries.values()]);
  }

  get(actionId: string): RegisteredTaskKey | null {
    return this.#entries.get(actionId) ?? null;
  }

  upsert(action: TaskKeyActionPort, settings: TaskKeySettings): RegisteredTaskKey {
    const existing = this.#entries.get(action.id);
    if (existing !== undefined) {
      existing.settings = settings;
      return existing;
    }
    const queue = new TaskKeyRenderQueue(action);
    queue.onStateChange(() => this.#onRenderStateChange(action.id));
    const entry: RegisteredTaskKey = {
      action,
      settings,
      queue,
      navigationFailed: false,
      propertyInspectorVisible: false,
    };
    this.#entries.set(action.id, entry);
    return entry;
  }

  remove(actionId: string): void {
    this.#entries.get(actionId)?.queue.dispose();
    this.#entries.delete(actionId);
  }

  clear(): void {
    for (const entry of this.#entries.values()) entry.queue.dispose();
    this.#entries.clear();
  }

  render(snapshotFor: (settings: TaskKeySettings) => KeySnapshot): void {
    for (const entry of this.#entries.values()) entry.queue.enqueue(snapshotFor(entry.settings));
  }

  async press(actionId: string, navigation: TaskNavigationPort): Promise<TaskId | null> {
    const entry = this.#entries.get(actionId);
    const displayed = entry?.queue.displayedSnapshot ?? null;
    if (entry === undefined || displayed?.kind !== "task") {
      await entry?.action.showAlert().catch(() => undefined);
      return null;
    }
    const launched = await navigation.openTask(displayed.taskId);
    entry.navigationFailed = !launched;
    if (!launched) await entry.action.showAlert().catch(() => undefined);
    return launched ? displayed.taskId : null;
  }
}
