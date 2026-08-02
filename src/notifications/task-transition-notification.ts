import type { LiveTaskRecord } from "../desktop-ipc/chatgpt-desktop-ipc-adapter.ts";
import type { TaskKeyAppearanceSettings } from "../settings/task-key-settings.ts";
import type { TaskNotification } from "./mac-task-notifier.ts";

export function taskTransitionNotification(
  previous: LiveTaskRecord | undefined,
  current: LiveTaskRecord,
  settings: TaskKeyAppearanceSettings,
  taskTitle: string,
): TaskNotification | null {
  if (previous?.freshness !== "fresh"
    || current.freshness !== "fresh"
    || previous.status === current.status
    || (current.status !== "done" && current.status !== "confirmation")) {
    return null;
  }
  const status = current.status;
  const mode = status === "done" ? settings.doneNotification : settings.confirmationNotification;
  if (mode === "off") return null;
  return Object.freeze({
    status,
    taskTitle,
    mode,
    source: status === "done" ? settings.doneSoundSource : settings.confirmationSoundSource,
    sound: status === "done" ? settings.doneSound : settings.confirmationSound,
    volume: status === "done" ? settings.doneVolume : settings.confirmationVolume,
    repeat: status === "done" ? settings.doneRepeat : settings.confirmationRepeat,
    repeatDelayMs: status === "done" ? settings.doneRepeatDelayMs : settings.confirmationRepeatDelayMs,
  });
}
