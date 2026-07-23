import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appleScriptForAccelerator,
  appleScriptForHeldAccelerator,
  ChatGptGlobalDictationPort,
  readGlobalDictationShortcut,
} from "../../src/chatgpt/chatgpt-global-dictation-port.ts";

async function codexHome(context: { after(callback: () => Promise<void>): void }): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fingertip-dictation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  return directory;
}

test("command keymap overrides legacy toggle shortcut, including explicit clear", async (context) => {
  const directory = await codexHome(context);
  await writeFile(path.join(directory, ".codex-global-state.json"), JSON.stringify({
    globalDictationToggleHotkey: "Command+Shift+D",
  }));
  await writeFile(path.join(directory, "keybindings.json"), JSON.stringify([
    { command: "globalDictationToggle", key: "Option+Space" },
  ]));
  assert.equal(await readGlobalDictationShortcut(directory, "toggle"), "Option+Space");

  await writeFile(path.join(directory, "keybindings.json"), JSON.stringify([
    { command: "globalDictationToggle", key: null },
  ]));
  assert.equal(await readGlobalDictationShortcut(directory, "toggle"), null);
});

test("legacy toggle shortcut is used when the command keymap has no override", async (context) => {
  const directory = await codexHome(context);
  await writeFile(path.join(directory, ".codex-global-state.json"), JSON.stringify({
    globalDictationToggleHotkey: "Control+Shift+D",
  }));
  await writeFile(path.join(directory, "keybindings.json"), "[]");
  assert.equal(await readGlobalDictationShortcut(directory, "toggle"), "Control+Shift+D");
});

test("global toggle emits only the configured shortcut and never opens ChatGPT", async (context) => {
  const directory = await codexHome(context);
  await writeFile(path.join(directory, "keybindings.json"), JSON.stringify([
    { command: "globalDictationToggle", key: "Control+Option+Space" },
  ]));
  const calls: [string, readonly string[]][] = [];
  const spawn = ((command: string, args: readonly string[]) => {
    calls.push([command, args]);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child as ChildProcess;
  }) as unknown as typeof nodeSpawn;

  const result = await new ChatGptGlobalDictationPort({ codexHome: directory, spawn }).press("toggle");

  assert.deepEqual(result, { success: true, shortcut: "Control+Option+Space" });
  assert.deepEqual(calls, [[
    "/usr/bin/osascript",
    ["-e", "tell application \"System Events\" to key code 49 using {control down, option down}"],
  ]]);
});

test("accelerator conversion supports regular and bare modifier shortcuts", () => {
  assert.equal(
    appleScriptForAccelerator("Command+Shift+D"),
    "tell application \"System Events\" to keystroke \"d\" using {command down, shift down}",
  );
  assert.equal(appleScriptForAccelerator("Fn"), "tell application \"System Events\" to key code 63");
  assert.equal(appleScriptForAccelerator("Hyper+D"), null);
});

test("hold mode reads its independent binding and emits matching down and up events", async (context) => {
  const directory = await codexHome(context);
  await writeFile(path.join(directory, "keybindings.json"), JSON.stringify([
    { command: "globalDictationToggle", key: "Option+Space" },
    { command: "globalDictationHold", key: "Command+Shift+D" },
  ]));
  const calls: string[] = [];
  const spawn = ((_command: string, args: readonly string[]) => {
    calls.push(args[1] ?? "");
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child as ChildProcess;
  }) as unknown as typeof nodeSpawn;
  const port = new ChatGptGlobalDictationPort({ codexHome: directory, spawn });

  const result = await port.press("hold");
  assert.deepEqual(result, { success: true, shortcut: "Command+Shift+D" });
  assert.equal(await port.release("Command+Shift+D"), true);
  assert.deepEqual(calls, [
    "tell application \"System Events\"\nkey down {command down, shift down}\nkey down \"d\"\nend tell",
    "tell application \"System Events\"\nkey up \"d\"\nkey up {shift down, command down}\nend tell",
  ]);
});

test("hold accelerator conversion keeps modifier release ordering safe", () => {
  assert.equal(
    appleScriptForHeldAccelerator("Control+Option+Space", "down"),
    "tell application \"System Events\"\nkey down {control down, option down}\nkey down 49\nend tell",
  );
  assert.equal(
    appleScriptForHeldAccelerator("Control+Option+Space", "up"),
    "tell application \"System Events\"\nkey up 49\nkey up {option down, control down}\nend tell",
  );
});
