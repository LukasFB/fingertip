import type { TaskId } from "../catalog/catalog-projection.ts";
import type { CatalogTask } from "../catalog/task-feed.ts";
import type { ModelCatalogEntry } from "../models/model-catalog.ts";
import type { TaskStatus } from "../status/task-status-projector.ts";
import { record, records } from "./t3-client.ts";

export interface T3Thread extends Record<string, unknown> { id: string; title: string; projectId: string }
export function thread(value: unknown): T3Thread {
  const item = record(value);
  if (typeof item.id !== "string" || !item.id || item.id.length > 4096
    || typeof item.title !== "string" || typeof item.projectId !== "string") throw new Error("Invalid T3 thread.");
  return item as T3Thread;
}
export function timestamp(value: unknown): number { return typeof value === "string" ? Date.parse(value) || 0 : 0; }
export function eligible(item: T3Thread): boolean {
  return !item.deletedAt && !item.archivedAt && record(item.lineage).relationshipToParent !== "subagent";
}
export function activeThread(threads: Iterable<T3Thread>): T3Thread | null {
  return [...threads].filter((item) => eligible(item) && timestamp(item.lastVisitedAt) > 0)
    .sort((a, b) => timestamp(b.lastVisitedAt) - timestamp(a.lastVisitedAt) || a.id.localeCompare(b.id))[0] ?? null;
}
export function threadStatus(item: T3Thread): TaskStatus {
  const request = record(item.pendingRuntimeRequest);
  if (request.kind) return ["command", "file-read", "file-change", "file", "permission", "command_execution", "file_change", "permissions"].includes(String(request.kind))
    || String(request.kind).includes("approval") ? "confirmation" : "waiting";
  // T3's runtime waiting/queued states still belong to Working; only an
  // explicit runtime request above means the user needs to respond.
  if (inWorkingShelf(item)) return "working";
  if (item.status === "failed") return "waiting";
  if (item.status === "completed" && timestamp(item.latestRunCompletedAt) > timestamp(item.lastVisitedAt)) return "done";
  return "idle";
}
export function taskKey(environmentId: string, id: string): TaskId {
  return `t3:${encodeURIComponent(environmentId)}:${encodeURIComponent(id)}` as TaskId;
}
export function threadLink(environmentId: string, id: string): string {
  return `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(id)}`;
}
function inWorkingShelf(item: T3Thread): boolean {
  return !record(item.pendingRuntimeRequest).kind
    && ["preparing", "queued", "starting", "running", "waiting"].includes(String(item.status));
}
function sidebarTime(item: T3Thread): number {
  return inWorkingShelf(item)
    ? Math.max(timestamp(item.createdAt), timestamp(item.latestUserAuthoredMessageAt === undefined
      ? item.latestRunRequestedAt : item.latestUserAuthoredMessageAt))
    : Math.max(timestamp(item.createdAt), timestamp(item.unsettledAt),
      timestamp(item.latestRunRequestedAt), timestamp(item.latestRunCompletedAt));
}
export function taskFeed(threads: Iterable<T3Thread>, projects: Map<string, Record<string, unknown>>, environmentId: string, source: string): CatalogTask[] {
  const items = [...threads].filter((item) => eligible(item) && !item.settledAt && item.settledOverride !== "settled"
    && timestamp(item.snoozedUntil) <= Date.now());
  items.sort((a, b) => {
    const pinned = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
    if (pinned) return pinned;
    if (a.pinnedAt) {
      if (a.pinOrderKey && b.pinOrderKey && a.pinOrderKey !== b.pinOrderKey) return String(a.pinOrderKey).localeCompare(String(b.pinOrderKey));
      return timestamp(b.latestUserAuthoredMessageAt ?? b.createdAt) - timestamp(a.latestUserAuthoredMessageAt ?? a.createdAt)
        || a.id.localeCompare(b.id);
    }
    // T3's inbox comes before its Working shelf. Inbox returns use completion
    // time, while the Working shelf keeps send order, not run activity order.
    return Number(inWorkingShelf(a)) - Number(inWorkingShelf(b)) || sidebarTime(b) - sidebarTime(a)
      || a.id.localeCompare(b.id);
  });
  return items.filter((item) => source !== "tasks" || !item.pinnedAt).map((item) => ({
    id: taskKey(environmentId, item.id), title: item.title, createdAt: timestamp(item.createdAt),
    activityAt: timestamp(item.latestRunCompletedAt ?? item.latestRunStartedAt ?? item.updatedAt),
    source: source === "tasks" ? "tasks" : "pinned-projects",
    ...(item.pinnedAt ? { pinned: true as const } : {}),
    projectLabel: String(projects.get(item.projectId)?.title ?? projects.get(item.projectId)?.name ?? "T3 Code"),
  }));
}
export function selections(value: unknown): { id: string; value: string | boolean }[] {
  if (Array.isArray(value)) return records(value).filter((item) => typeof item.id === "string"
    && (typeof item.value === "string" || typeof item.value === "boolean")) as { id: string; value: string | boolean }[];
  return Object.entries(record(value)).filter((entry): entry is [string, string | boolean] =>
    typeof entry[1] === "string" || typeof entry[1] === "boolean").map(([id, value]) => ({ id, value }));
}
export interface T3Model extends ModelCatalogEntry {
  instanceId: string; slug: string; descriptors: Record<string, unknown>[]; effortId: string;
}
export function modelsFromConfig(value: unknown): T3Model[] {
  return records(record(value).providers).flatMap((provider) => {
    if (typeof provider.instanceId !== "string" || provider.status === "disabled" || provider.availability === "unavailable") return [];
    return records(provider.models).flatMap((model) => {
      if (typeof model.slug !== "string") return [];
      const descriptors = records(record(model.capabilities).optionDescriptors);
      const reasoning = descriptors.find((option) => ["reasoningEffort", "reasoning_effort", "reasoning"].includes(String(option.id)) && option.type === "select");
      const choices = records(reasoning?.options).filter((choice) => typeof choice.id === "string");
      return [{
        model: JSON.stringify([provider.instanceId, model.slug]), instanceId: String(provider.instanceId), slug: model.slug,
        displayName: `${provider.displayName ?? provider.instanceId} · ${model.name ?? model.slug}`,
        defaultReasoningEffort: String(reasoning?.currentValue ?? choices.find((choice) => choice.isDefault)?.id ?? choices[0]?.id ?? ""),
        supportedReasoningEfforts: choices.map((choice) => ({ reasoningEffort: String(choice.id), description: String(choice.description ?? choice.label ?? "") })),
        isDefault: model.isDefault === true, descriptors, effortId: String(reasoning?.id ?? "reasoningEffort"),
      }];
    });
  });
}
export function modelOptions(model: T3Model, current: unknown, effort: string): { id: string; value: string | boolean }[] {
  const options = selections(current).filter((option) => model.descriptors.some((descriptor) => descriptor.id === option.id
    && (descriptor.type === "boolean" ? typeof option.value === "boolean" : records(descriptor.options).some((choice) => choice.id === option.value))));
  return [...options.filter((option) => option.id !== model.effortId), ...(effort ? [{ id: model.effortId, value: effort }] : [])];
}
