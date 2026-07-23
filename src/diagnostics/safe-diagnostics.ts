import type { CatalogState, DesktopState, LiveFreshness } from "../runtime/key-presentation.ts";

export type DiagnosticCode =
  | "STARTING"
  | "READY"
  | "CHATGPT_NOT_RUNNING"
  | "IPC_UNAVAILABLE"
  | "IPC_INCOMPATIBLE"
  | "CATALOG_UNAVAILABLE"
  | "CATALOG_INCOMPATIBLE"
  | "LIVE_STATUS_STALE"
  | "IMAGE_UPDATE_FAILED"
  | "NAVIGATION_FAILED";

const LABELS: Readonly<Record<DiagnosticCode, string>> = Object.freeze({
  STARTING: "Connecting…",
  READY: "Connected",
  CHATGPT_NOT_RUNNING: "ChatGPT is not running",
  IPC_UNAVAILABLE: "Live Task status is unavailable",
  IPC_INCOMPATIBLE: "ChatGPT changed; Fingertip needs an update",
  CATALOG_UNAVAILABLE: "Task list is unavailable",
  CATALOG_INCOMPATIBLE: "ChatGPT Task list is incompatible",
  LIVE_STATUS_STALE: "This Task's live status is unavailable",
  IMAGE_UPDATE_FAILED: "Stream Deck did not accept the key update",
  NAVIGATION_FAILED: "ChatGPT could not be opened",
});

export interface DiagnosticInput {
  readonly imageUpdateFailed: boolean;
  readonly navigationFailed: boolean;
  readonly catalogState: CatalogState;
  readonly desktopState: DesktopState;
  readonly taskLiveFreshness: LiveFreshness;
  readonly chatGptNotRunning?: boolean;
}

export function selectDiagnosticCode(input: DiagnosticInput): DiagnosticCode {
  if (input.imageUpdateFailed) return "IMAGE_UPDATE_FAILED";
  if (input.navigationFailed) return "NAVIGATION_FAILED";
  if (input.catalogState === "incompatible") return "CATALOG_INCOMPATIBLE";
  if (input.desktopState === "incompatible") return "IPC_INCOMPATIBLE";
  if (input.catalogState === "unavailable") return "CATALOG_UNAVAILABLE";
  if (input.chatGptNotRunning === true) return "CHATGPT_NOT_RUNNING";
  if (input.desktopState === "offline") return "IPC_UNAVAILABLE";
  if (input.taskLiveFreshness === "stale") return "LIVE_STATUS_STALE";
  if (input.catalogState === "cold" || input.desktopState === "connecting") return "STARTING";
  return "READY";
}

export function diagnosticLabel(code: DiagnosticCode): string {
  return LABELS[code];
}
