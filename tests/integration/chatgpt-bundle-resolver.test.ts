import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ChatGptBundleResolver,
  type RunBoundedCommand,
} from "../../src/chatgpt/chatgpt-bundle-resolver.ts";

test("bundle resolver validates a discovered ChatGPT bundle before executing its Codex binary", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fingertip-bundle-"));
  context.after(async () => { await import("node:fs/promises").then((fs) => fs.rm(directory, { recursive: true })); });
  const bundle = path.join(directory, "ChatGPT.app");
  const resources = path.join(bundle, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  await writeFile(path.join(bundle, "Contents", "Info.plist"), "fixture");
  const binary = path.join(resources, "codex");
  await writeFile(binary, "#!/bin/sh\n");
  await chmod(binary, 0o700);
  const canonicalBundle = await realpath(bundle);
  const canonicalBinary = path.join(canonicalBundle, "Contents", "Resources", "codex");
  const calls: { command: string; args: readonly string[]; outputCap: number; timeoutMs: number }[] = [];
  const run: RunBoundedCommand = async (command, args, options) => {
    calls.push({ command, args, outputCap: options.outputCapBytes, timeoutMs: options.timeoutMs });
    if (command === "/usr/bin/lsappinfo") throw new Error("not running");
    if (command === "/usr/bin/mdfind") return `${bundle}\n`;
    if (command === "/usr/bin/plutil") {
      if (args[1] === "CFBundleIdentifier") return "com.openai.codex\n";
      if (args[1] === "CFBundleShortVersionString") return "1.2026.189\n";
      if (args[1] === "CFBundleVersion") return "1890001\n";
    }
    if (command === canonicalBinary) return "codex-cli 0.189.0\n";
    throw new Error("unexpected command");
  };

  const resolved = await new ChatGptBundleResolver({ run, homeDirectory: directory }).resolve();

  assert.deepEqual(resolved, {
    bundlePath: canonicalBundle,
    binaryPath: canonicalBinary,
    appVersion: "1.2026.189",
    appBuild: "1890001",
    codexVersion: "codex-cli 0.189.0",
    fingerprint: `${canonicalBundle}\u00001.2026.189\u00001890001\u0000codex-cli 0.189.0`,
  });
  assert.equal(calls.some((call) => call.command === canonicalBinary && call.args.join(" ") === "--version"), true);
  assert.equal(calls.find((call) => call.command === canonicalBinary)?.outputCap, 4_096);
  assert.equal(calls.every((call) => call.timeoutMs === 5_000), true);
  assert.equal(calls.find((call) => call.command === "/usr/bin/mdfind")?.outputCap, 1024 * 1024);
});
