import { execFile as nodeExecFile } from "node:child_process";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAC_SYSTEM_SOUNDS,
  type TaskNotificationMode,
  type TaskNotificationSound,
  type TaskNotificationSoundSource,
  type TaskNotificationStatus,
} from "../settings/task-key-settings.ts";

const MAX_CUSTOM_SOUND_BYTES = 25 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([".aac", ".aif", ".aiff", ".au", ".caf", ".m4a", ".mp3", ".mp4", ".wav"]);

type ExecFile = (
  file: string,
  args: readonly string[],
  options: Readonly<{ timeout: number; maxBuffer?: number }>,
  callback: (error: Error | null, stdout: string) => void,
) => void;

export interface TaskNotification {
  readonly status: TaskNotificationStatus;
  readonly mode: TaskNotificationMode;
  readonly source: TaskNotificationSoundSource;
  readonly sound: TaskNotificationSound;
  readonly volume: number;
  readonly taskTitle: string;
}

export interface TaskNotifier {
  notify(notification: TaskNotification): void;
  importCustomSound(status: TaskNotificationStatus): Promise<boolean>;
  customSoundAvailable(status: TaskNotificationStatus): Promise<boolean>;
}

interface MacTaskNotifierOptions {
  readonly execFile: ExecFile;
  readonly soundDirectory: string;
}

function customPrefix(status: TaskNotificationStatus): string {
  return `${status}-custom`;
}

export class MacTaskNotifier implements TaskNotifier {
  readonly #options: MacTaskNotifierOptions;

  constructor(options: Partial<MacTaskNotifierOptions> = {}) {
    this.#options = {
      execFile: options.execFile ?? nodeExecFile as ExecFile,
      soundDirectory: options.soundDirectory
        ?? path.join(os.homedir(), "Library", "Application Support", "Fingertip Agent", "Sounds"),
    };
  }

  notify(notification: TaskNotification): void {
    if (notification.mode === "off") return;
    if (notification.mode === "toast" || notification.mode === "both") {
      const subtitle = notification.status === "done" ? "Task completed" : "Task blocked";
      const script = [
        "on run argv",
        "display notification (item 1 of argv) with title \"Fingertip Agent\" subtitle (item 2 of argv)",
        "end run",
      ].join("\n");
      this.#run("/usr/bin/osascript", ["-e", script, notification.taskTitle, subtitle]);
      if (notification.mode === "toast") return;
    }
    void this.#soundPath(notification.status, notification.source, notification.sound).then((soundPath) => {
      if (soundPath !== null) {
        this.#run("/usr/bin/afplay", ["-v", String(notification.volume / 100), soundPath]);
      }
    });
  }

  async importCustomSound(status: TaskNotificationStatus): Promise<boolean> {
    const script = [
      "set pickedFile to choose file with prompt \"Choose an audio file for Fingertip Agent\"",
      "POSIX path of pickedFile",
    ].join("\n");
    const source = await this.#capture("/usr/bin/osascript", ["-e", script]);
    if (source === null) return false;
    const sourcePath = source.trim();
    const extension = path.extname(sourcePath).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)) return false;
    const details = await stat(sourcePath).catch(() => null);
    if (details === null || !details.isFile() || details.size > MAX_CUSTOM_SOUND_BYTES) return false;
    await mkdir(this.#options.soundDirectory, { recursive: true });
    await this.#removeCustomSound(status);
    await copyFile(sourcePath, path.join(this.#options.soundDirectory, `${customPrefix(status)}${extension}`));
    return true;
  }

  async customSoundAvailable(status: TaskNotificationStatus): Promise<boolean> {
    return (await this.#customSoundPath(status)) !== null;
  }

  async #soundPath(
    status: TaskNotificationStatus,
    source: TaskNotificationSoundSource,
    sound: TaskNotificationSound,
  ): Promise<string | null> {
    if (source === "custom") return this.#customSoundPath(status);
    if (!MAC_SYSTEM_SOUNDS.includes(sound)) return null;
    return `/System/Library/Sounds/${sound}.aiff`;
  }

  async #customSoundPath(status: TaskNotificationStatus): Promise<string | null> {
    const prefix = customPrefix(status);
    const files = await readdir(this.#options.soundDirectory).catch(() => []);
    const filename = files.find((file) => file.startsWith(`${prefix}.`));
    return filename === undefined ? null : path.join(this.#options.soundDirectory, filename);
  }

  async #removeCustomSound(status: TaskNotificationStatus): Promise<void> {
    const prefix = customPrefix(status);
    const files = await readdir(this.#options.soundDirectory).catch(() => []);
    await Promise.all(files
      .filter((file) => file.startsWith(`${prefix}.`))
      .map((file) => rm(path.join(this.#options.soundDirectory, file), { force: true })));
  }

  #run(file: string, args: readonly string[]): void {
    this.#options.execFile(file, args, { timeout: 10_000 }, () => undefined);
  }

  #capture(file: string, args: readonly string[]): Promise<string | null> {
    return new Promise((resolve) => {
      this.#options.execFile(file, args, { timeout: 120_000, maxBuffer: 16_384 }, (error, stdout) => {
        resolve(error === null ? stdout : null);
      });
    });
  }
}
