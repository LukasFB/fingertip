import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTaskId } from "../../src/catalog/catalog-projection.ts";
import type { LiveTaskRecord } from "../../src/desktop-ipc/chatgpt-desktop-ipc-adapter.ts";
import { MacTaskNotifier } from "../../src/notifications/mac-task-notifier.ts";
import { taskTransitionNotification } from "../../src/notifications/task-transition-notification.ts";
import { normalizeTaskKeyAppearanceSettings } from "../../src/settings/task-key-settings.ts";

function record(status: LiveTaskRecord["status"], freshness: LiveTaskRecord["freshness"] = "fresh"): LiveTaskRecord {
  return {
    taskId: parseTaskId("0198e504-4e1d-7fd1-9bda-5af3b983fb47"),
    ownerClientId: "owner",
    revision: 1,
    facts: {
      isActive: status === "working",
      waitingOnApproval: status === "confirmation",
      waitingOnUserInput: status === "waiting",
      hasUnreadTurn: status === "done",
    },
    status,
    freshness,
  };
}

test("only real fresh transitions into enabled green or orange states create a notification", () => {
  const settings = normalizeTaskKeyAppearanceSettings({
    doneNotification: "both",
    doneSoundSource: "system",
    doneSound: "Glass",
    doneVolume: 80,
    confirmationNotification: "sound",
    confirmationSoundSource: "system",
    confirmationSound: "Ping",
    confirmationVolume: 40,
  });
  assert.deepEqual(taskTransitionNotification(record("working"), record("done"), settings, "Ship it"), {
    status: "done",
    mode: "both",
    source: "system",
    sound: "Glass",
    volume: 80,
    repeat: 1,
    repeatDelayMs: 250,
    taskTitle: "Ship it",
  });
  assert.deepEqual(taskTransitionNotification(record("working"), record("confirmation"), settings, "Approve it"), {
    status: "confirmation",
    mode: "sound",
    source: "system",
    sound: "Ping",
    volume: 40,
    repeat: 1,
    repeatDelayMs: 250,
    taskTitle: "Approve it",
  });
  assert.equal(taskTransitionNotification(undefined, record("done"), settings, "Hydrated"), null);
  assert.equal(taskTransitionNotification(record("done"), record("done"), settings, "Duplicate"), null);
  assert.equal(taskTransitionNotification(record("working", "stale"), record("done"), settings, "Stale"), null);
  assert.equal(taskTransitionNotification(record("working"), record("waiting"), settings, "Peach"), null);
  assert.equal(taskTransitionNotification(
    record("working"),
    record("done"),
    normalizeTaskKeyAppearanceSettings(undefined),
    "Disabled",
  ), null);
});

test("macOS notifications and system sounds use fixed executables without a shell", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const notifier = new MacTaskNotifier({
    execFile(file, args, _options, callback) {
      calls.push({ file, args });
      callback(null, "");
    },
  });
  notifier.notify({
    status: "done",
    mode: "both",
    source: "system",
    sound: "Glass",
    volume: 100,
    repeat: 1,
    repeatDelayMs: 250,
    taskTitle: "A quoted \"Task\"",
  });
  notifier.notify({
    status: "confirmation",
    mode: "sound",
    source: "system",
    sound: "Ping",
    volume: 400,
    repeat: 1,
    repeatDelayMs: 250,
    taskTitle: "Blocked",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls[0]?.file, "/usr/bin/osascript");
  assert.equal(calls[0]?.args.includes("A quoted \"Task\""), true);
  assert.deepEqual(calls[1], {
    file: "/usr/bin/afplay",
    args: ["-v", "1", "/System/Library/Sounds/Glass.aiff"],
  });
  assert.deepEqual(calls[2], {
    file: "/usr/bin/afplay",
    args: ["-v", "4", "/System/Library/Sounds/Ping.aiff"],
  });
});

test("a selected custom audio is bounded, copied locally, and used for its status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fingertip-sounds-"));
  const source = path.join(directory, "chosen.wav");
  const destination = path.join(directory, "stored");
  await writeFile(source, "audio");
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const notifier = new MacTaskNotifier({
    soundDirectory: destination,
    execFile(file, args, _options, callback) {
      calls.push({ file, args });
      callback(null, file === "/usr/bin/osascript" ? `${source}\n` : "");
    },
  });
  try {
    assert.equal(await notifier.importCustomSound("done"), true);
    assert.equal(await notifier.customSoundAvailable("done"), true);
    assert.equal(await readFile(path.join(destination, "done-custom.wav"), "utf8"), "audio");
    notifier.notify({
      status: "done",
      mode: "sound",
      source: "custom",
    sound: "Glass",
    volume: 75,
    repeat: 1,
    repeatDelayMs: 250,
      taskTitle: "Custom",
    });
    for (let iteration = 0; iteration < 5; iteration += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(calls.at(-1), {
      file: "/usr/bin/afplay",
      args: ["-v", "0.75", path.join(destination, "done-custom.wav")],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repeated audio uses monotonic absolute deadlines without accumulating timer drift", async () => {
  let nowNs = 0n;
  const starts: number[] = [];
  const notifier = new MacTaskNotifier({
    now: () => nowNs,
    setTimer(callback, delayMs) {
      nowNs += BigInt(delayMs) * 1_000_000n;
      callback();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    execFile(file, args, _options, callback) {
      if (file === "/usr/bin/afplay") {
        starts.push(Number(nowNs / 1_000_000n));
        nowNs += 7n * 1_000_000n;
      }
      callback(null, "");
    },
  });

  notifier.notify({
    status: "done",
    mode: "sound",
    source: "system",
    sound: "Glass",
    volume: 100,
    repeat: 3,
    repeatDelayMs: 25,
    taskTitle: "Repeated",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(starts, [0, 25, 50]);
});

test("the bundled audio helper receives one native scheduling request for repeated audio", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const notifier = new MacTaskNotifier({
    audioHelperPath: "/plugin/bin/audio-notifier",
    execFile(file, args, _options, callback) {
      calls.push({ file, args });
      callback(null, "");
    },
  });

  notifier.notify({
    status: "done",
    mode: "sound",
    source: "system",
    sound: "Glass",
    volume: 100,
    repeat: 4,
    repeatDelayMs: 25,
    taskTitle: "Native repeated",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [{
    file: "/plugin/bin/audio-notifier",
    args: [
      "--volume", "1", "--repeat", "4", "--delay-ms", "25",
      "/System/Library/Sounds/Glass.aiff",
    ],
  }]);
});
