import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

import type { TaskId } from "../catalog/catalog-projection.ts";
import type { ChatGptWindowTarget } from "../settings/task-key-settings.ts";

interface NavigationChild {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(): boolean;
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { shell: false; stdio: "ignore" },
) => NavigationChild;

interface NavigationOptions {
  spawn: SpawnProcess;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number;
  clearTimer(timer: ReturnType<typeof setTimeout> | number): void;
}

const defaultSpawn: SpawnProcess = (command, args, options) =>
  nodeSpawn(command, [...args], options) as ChildProcess;

const CODEX_BUNDLE_ID = "com.openai.codex";
const WINDOW_FOCUS_TIMEOUT_MS = 650;
const NAVIGATION_TIMEOUT_MS = 5_000;

function focusWindowScript(target: Exclude<ChatGptWindowTarget, "last-active">): string {
  const comparison = target === "leftmost" ? "candidateX < targetX" : "candidateX > targetX";
  return `tell application "System Events"
  set matchingProcesses to every application process whose bundle identifier is "com.openai.codex"
  if (count of matchingProcesses) is 0 then error "ChatGPT is not running"
  set chatGptProcess to item 1 of matchingProcesses
  tell chatGptProcess
    set frontmost to true
    set candidateWindows to every window whose subrole is "AXStandardWindow"
    if (count of candidateWindows) is 0 then error "ChatGPT has no standard window"
    if (count of candidateWindows) is 1 then return
    set targetWindow to item 1 of candidateWindows
    set targetPosition to position of targetWindow
    set targetX to item 1 of targetPosition
    repeat with candidateWindow in candidateWindows
      set candidatePosition to position of candidateWindow
      set candidateX to item 1 of candidatePosition
      if ${comparison} then
        set targetWindow to candidateWindow
        set targetX to candidateX
      end if
    end repeat
    try
      set value of attribute "AXMain" of targetWindow to true
    end try
    perform action "AXRaise" of targetWindow
    repeat with attempt from 1 to 10
      try
        if value of attribute "AXMain" of targetWindow then exit repeat
      end try
      delay 0.01
    end repeat
  end tell
end tell`;
}

export class ChatGptNavigationPort {
  readonly #options: NavigationOptions;
  #windowTarget: ChatGptWindowTarget = "last-active";

  constructor(options?: Partial<NavigationOptions>) {
    this.#options = {
      spawn: options?.spawn ?? defaultSpawn,
      setTimer: options?.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      clearTimer: options?.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
    };
  }

  setWindowTarget(target: ChatGptWindowTarget): void {
    this.#windowTarget = target;
  }

  get windowTarget(): ChatGptWindowTarget {
    return this.#windowTarget;
  }

  async activateTargetWindow(): Promise<boolean> {
    if (this.#windowTarget === "last-active") {
      return this.#run("/usr/bin/open", ["-b", CODEX_BUNDLE_ID]);
    }
    return this.#run(
      "/usr/bin/osascript",
      ["-e", focusWindowScript(this.#windowTarget)],
      WINDOW_FOCUS_TIMEOUT_MS,
    );
  }

  async openTask(taskId: TaskId): Promise<boolean> {
    // Bring Codex forward immediately instead of making activation wait for
    // physical-window discovery or deep-link processing. This best-effort
    // request is deliberately independent from the navigation result.
    void this.#run(
      "/usr/bin/open",
      ["-b", CODEX_BUNDLE_ID],
      WINDOW_FOCUS_TIMEOUT_MS,
    );
    if (this.#windowTarget !== "last-active") {
      await this.#run(
        "/usr/bin/osascript",
        ["-e", focusWindowScript(this.#windowTarget)],
        WINDOW_FOCUS_TIMEOUT_MS,
      );
    }
    return this.#run(
      "/usr/bin/open",
      ["-b", CODEX_BUNDLE_ID, `codex://threads/${taskId}`],
      NAVIGATION_TIMEOUT_MS,
    );
  }

  #run(command: string, args: readonly string[], timeoutMs = NAVIGATION_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        this.#options.clearTimer(timer);
        resolve(result);
      };
      let child: NavigationChild;
      try {
        child = this.#options.spawn(command, args, { shell: false, stdio: "ignore" });
      } catch {
        resolve(false);
        return;
      }
      const timer = this.#options.setTimer(() => {
        child.kill();
        finish(false);
      }, timeoutMs);
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
    });
  }
}
