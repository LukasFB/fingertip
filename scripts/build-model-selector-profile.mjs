import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODEL_SELECTOR_ACTIONS, MODEL_SELECTOR_PROFILE } from "../src/models/model-selector-profile.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "com.lukas-bhm.fingertip.sdPlugin");
const output = path.join(pluginRoot, `${MODEL_SELECTOR_PROFILE.name}.streamDeckProfile`);
const manifest = JSON.parse(await readFile(path.join(pluginRoot, "manifest.json"), "utf8"));
const stage = await mkdtemp(path.join(os.tmpdir(), "fingertip-model-profile-"));
const { profileId, pageId } = MODEL_SELECTOR_PROFILE;
const profileRoot = path.join(stage, "Profiles", `${profileId}.sdProfile`);
const pageRoot = path.join(profileRoot, "Profiles", pageId);

const plugin = Object.freeze({
  Name: manifest.Name,
  UUID: manifest.UUID,
  Version: manifest.Version,
});
const actions = Object.fromEntries(Object.entries(MODEL_SELECTOR_ACTIONS).map(([position, action]) => [position, {
  ActionID: `${action.UUID}-${position}`,
  LinkedTitle: true,
  Name: action.UUID.endsWith(".model-option") ? "Model Option"
    : action.UUID.endsWith(".fast-mode") ? "Fast Mode" : "Back",
  Plugin: plugin,
  Resources: null,
  ...action,
  State: 0,
  States: [{}],
}]));

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

try {
  await mkdir(pageRoot, { recursive: true });
  await mkdir(path.dirname(output), { recursive: true });
  await Promise.all([
    writeFile(path.join(stage, "package.json"), json({
      AppVersion: "7.1.0",
      DeviceModel: "20GAT9902",
      DeviceSettings: null,
      FormatVersion: 1,
      OSType: "Mac",
      OSVersion: "13.0",
      RequiredPlugins: [manifest.UUID],
    })),
    writeFile(path.join(profileRoot, "manifest.json"), json({
      Device: { Model: "20GAT9902", UUID: "" },
      Name: "Codex Model Selector",
      ReadOnly: true,
      Pages: { Current: pageId, Default: pageId, Pages: [pageId] },
      Version: "3.0",
    })),
    writeFile(path.join(pageRoot, "manifest.json"), json({
      Controllers: [{ Actions: actions, Type: "Keypad" }],
      Icon: "",
      Name: "Models",
    })),
  ]);
  await rm(output, { force: true });
  await new Promise((resolve, reject) => {
    const zip = spawn("/usr/bin/zip", ["-qr", output, "package.json", "Profiles"], {
      cwd: stage,
      stdio: "inherit",
    });
    zip.once("error", reject);
    zip.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`zip exited with ${code}`)));
  });
  manifest.Profiles = [{
    Name: MODEL_SELECTOR_PROFILE.name,
    DeviceType: 2,
    AutoInstall: true,
    DontAutoSwitchWhenInstalled: true,
    Readonly: true,
  }];
  await writeFile(path.join(pluginRoot, "manifest.json"), json(manifest));
  // Remove obsolete bundled revisions only; installed user profiles belong to Stream Deck.
  for (const entry of await readdir(path.dirname(output))) {
    if (/^codex-model-selector(?:-[a-f0-9]{16})?\.streamDeckProfile$/u.test(entry)
      && entry !== path.basename(output)) await rm(path.join(path.dirname(output), entry));
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
