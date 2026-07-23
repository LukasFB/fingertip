import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { DictationMode } from "../settings/voice-input-settings.ts";

const MAXIMUM_SETTINGS_BYTES = 4 * 1024 * 1024;

interface DictationPortOptions {
  readonly codexHome: string;
  readonly spawn: typeof nodeSpawn;
}

interface Keybinding {
  readonly command: string;
  readonly key: string | null;
}

export interface GlobalDictationResult {
  readonly success: boolean;
  readonly shortcut: string | null;
  readonly reason?: "not-configured" | "unsupported" | "accessibility-failed";
}

class ReplacementRaceError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOwnedJson(filePath: string): Promise<unknown> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.size > MAXIMUM_SETTINGS_BYTES) {
      throw new Error("invalid ChatGPT settings file");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new ReplacementRaceError("ChatGPT settings changed while reading");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    await handle.close();
  }
}

async function readWithRetry(filePath: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await readOwnedJson(filePath);
    } catch (error) {
      if (!(error instanceof ReplacementRaceError) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("ChatGPT settings read failed");
}

function parseKeybindings(value: unknown): Keybinding[] | null {
  if (!Array.isArray(value)) return null;
  const bindings: Keybinding[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.command !== "string"
      || (entry.key !== null && typeof entry.key !== "string")) return null;
    bindings.push({ command: entry.command, key: entry.key });
  }
  return bindings;
}

function keymapValue(bindings: readonly Keybinding[] | null, command: string): {
  readonly present: boolean;
  readonly shortcut: string | null;
} {
  const binding = bindings?.find((entry) => entry.command === command);
  return binding === undefined
    ? { present: false, shortcut: null }
    : { present: true, shortcut: binding.key };
}

function globalStateValue(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

const DICTATION_BINDINGS: Record<DictationMode, { readonly command: string; readonly legacyKey: string }> = {
  hold: { command: "globalDictationHold", legacyKey: "globalDictationHotkey" },
  toggle: { command: "globalDictationToggle", legacyKey: "globalDictationToggleHotkey" },
};

export async function readGlobalDictationShortcut(
  codexHome: string,
  mode: DictationMode,
): Promise<string | null> {
  const [keymapValueOrNull, globalState] = await Promise.all([
    readWithRetry(path.join(codexHome, "keybindings.json")).catch(() => null),
    readWithRetry(path.join(codexHome, ".codex-global-state.json")).catch(() => null),
  ]);
  const selected = DICTATION_BINDINGS[mode];
  const binding = keymapValue(parseKeybindings(keymapValueOrNull), selected.command);
  return binding.present
    ? binding.shortcut
    : globalStateValue(globalState, selected.legacyKey);
}

const MODIFIERS: Record<string, string> = {
  alt: "option down",
  command: "command down",
  commandorcontrol: "command down",
  control: "control down",
  ctrl: "control down",
  meta: "command down",
  option: "option down",
  shift: "shift down",
};

const KEY_CODES: Record<string, number> = {
  backspace: 51,
  delete: 117,
  down: 125,
  end: 119,
  enter: 36,
  escape: 53,
  fn: 63,
  home: 115,
  left: 123,
  pageup: 116,
  pagedown: 121,
  return: 36,
  right: 124,
  rightcommand: 54,
  rightcontrol: 62,
  rightoption: 61,
  rightshift: 60,
  space: 49,
  tab: 48,
  up: 126,
};

interface ParsedAccelerator {
  readonly key: string;
  readonly keyCode: number | null;
  readonly modifiers: readonly string[];
}

function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const parts = accelerator.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop()?.toLowerCase();
  if (key === undefined) return null;
  const modifiers = parts.map((part) => MODIFIERS[part.toLowerCase()]);
  if (modifiers.some((modifier) => modifier === undefined)) return null;
  if (/^[a-z0-9]$/u.test(key)) {
    return { key, keyCode: null, modifiers: modifiers as string[] };
  }
  const keyCode = KEY_CODES[key];
  if (keyCode === undefined) return null;
  return { key, keyCode, modifiers: modifiers as string[] };
}

function appleScriptForAccelerator(accelerator: string): string | null {
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return null;
  const using = parsed.modifiers.length === 0 ? "" : ` using {${parsed.modifiers.join(", ")}}`;
  return parsed.keyCode === null
    ? `tell application "System Events" to keystroke "${parsed.key}"${using}`
    : `tell application "System Events" to key code ${parsed.keyCode}${using}`;
}

function appleScriptForHeldAccelerator(accelerator: string, direction: "down" | "up"): string | null {
  const parsed = parseAccelerator(accelerator);
  if (parsed === null) return null;
  const key = parsed.keyCode === null ? `"${parsed.key}"` : String(parsed.keyCode);
  const modifiers = direction === "down" ? parsed.modifiers : [...parsed.modifiers].reverse();
  const commands = direction === "down"
    ? [modifiers.length > 0 ? `key down {${modifiers.join(", ")}}` : null, `key down ${key}`]
    : [`key up ${key}`, modifiers.length > 0 ? `key up {${modifiers.join(", ")}}` : null];
  return ["tell application \"System Events\"", ...commands.filter((command) => command !== null), "end tell"]
    .join("\n");
}

function runAppleScript(spawn: typeof nodeSpawn, script: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn("/usr/bin/osascript", ["-e", script], { shell: false, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

export class ChatGptGlobalDictationPort {
  readonly #options: DictationPortOptions;

  constructor(options?: Partial<DictationPortOptions>) {
    this.#options = {
      codexHome: options?.codexHome ?? path.join(os.homedir(), ".codex"),
      spawn: options?.spawn ?? nodeSpawn,
    };
  }

  configuredShortcut(mode: DictationMode): Promise<string | null> {
    return readGlobalDictationShortcut(this.#options.codexHome, mode);
  }

  async press(mode: DictationMode): Promise<GlobalDictationResult> {
    const shortcut = await this.configuredShortcut(mode);
    if (shortcut === null) return { success: false, shortcut, reason: "not-configured" };
    const script = mode === "toggle"
      ? appleScriptForAccelerator(shortcut)
      : appleScriptForHeldAccelerator(shortcut, "down");
    if (script === null) return { success: false, shortcut, reason: "unsupported" };
    const success = await runAppleScript(this.#options.spawn, script);
    return success
      ? { success: true, shortcut }
      : { success: false, shortcut, reason: "accessibility-failed" };
  }

  async release(shortcut: string): Promise<boolean> {
    const script = appleScriptForHeldAccelerator(shortcut, "up");
    return script !== null && runAppleScript(this.#options.spawn, script);
  }
}

export { appleScriptForAccelerator, appleScriptForHeldAccelerator };
