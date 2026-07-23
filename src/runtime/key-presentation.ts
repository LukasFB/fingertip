import type { TaskStatus } from "../status/task-status-projector.ts";

export type CatalogState = "cold" | "fresh" | "stale" | "unavailable" | "incompatible";
export type DesktopState = "connecting" | "online" | "offline" | "incompatible";
export type LiveFreshness = "none" | "fresh" | "stale";

export interface KeyPresentationInput {
  readonly catalogState: CatalogState;
  readonly feedAvailable: boolean;
  readonly desktopState: DesktopState;
  readonly task: null | {
    readonly freshness: LiveFreshness;
    readonly status: TaskStatus | null;
  };
}

export interface KeyPresentation {
  readonly kind: "loading" | "unavailable" | "empty" | "task";
  readonly status: TaskStatus | null;
  readonly offlineWarning: boolean;
  readonly navigable: boolean;
}

export function projectKeyPresentation(input: KeyPresentationInput): KeyPresentation {
  if (!input.feedAvailable) {
    return Object.freeze({
      kind: input.catalogState === "cold" ? "loading" : "unavailable",
      status: null,
      offlineWarning: input.catalogState !== "cold",
      navigable: false,
    });
  }

  const sourceWarning = input.catalogState !== "fresh"
    || input.desktopState === "offline"
    || input.desktopState === "incompatible";
  if (input.task === null) {
    return Object.freeze({
      kind: "empty",
      status: null,
      offlineWarning: sourceWarning,
      navigable: false,
    });
  }
  const taskIsCurrentlyUnloaded = input.task.freshness === "stale"
    && input.desktopState === "online"
    && input.catalogState === "fresh";
  return Object.freeze({
    kind: "task",
    status: taskIsCurrentlyUnloaded ? "idle" : input.task.status ?? "idle",
    offlineWarning: sourceWarning
      || (input.task.freshness === "none" && input.desktopState !== "online"),
    navigable: true,
  });
}
