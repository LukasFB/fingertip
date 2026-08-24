import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "com.lukas-bhm.fingertip.sdPlugin");
const output = path.join(pluginRoot, "profiles", "codex-model-selector.streamDeckProfile");
const manifest = JSON.parse(await readFile(path.join(pluginRoot, "manifest.json"), "utf8"));
const stage = await mkdtemp(path.join(os.tmpdir(), "fingertip-model-profile-"));
const profileId = "6C0D98ED-0AA8-47AA-94D3-530915149F31";
const pageId = "3AE6A019-ED67-48E8-9BA6-BEE1289442E2";
const profileRoot = path.join(stage, "Profiles", `${profileId}.sdProfile`);
const pageRoot = path.join(profileRoot, "Profiles", pageId);

const plugin = Object.freeze({
  Name: manifest.Name,
  UUID: manifest.UUID,
  Version: manifest.Version,
});
const efforts = ["low", "medium", "high", "xhigh", "max"];
const families = ["sol", "terra", "luna"];
const actions = {};

for (const [row, family] of families.entries()) {
  for (const [column, effort] of efforts.entries()) {
    actions[`${column},${row}`] = {
      ActionID: `model-${family}-${effort}`,
      LinkedTitle: true,
      Name: "Model Option",
      Plugin: plugin,
      Resources: null,
      Settings: { family, effort },
      State: 0,
      States: [{}],
      UUID: "com.lukas-bhm.fingertip.model-option",
    };
  }
}

actions["5,0"] = {
  ActionID: "model-selector-fast-mode",
  LinkedTitle: true,
  Name: "Fast Mode",
  Plugin: plugin,
  Resources: null,
  Settings: {},
  State: 0,
  States: [{}],
  UUID: "com.lukas-bhm.fingertip.fast-mode",
};

actions["7,3"] = {
  ActionID: "model-selector-back",
  LinkedTitle: true,
  Name: "Back",
  Plugin: plugin,
  Resources: null,
  Settings: {},
  State: 0,
  States: [{}],
  UUID: "com.lukas-bhm.fingertip.model-selector-back",
};

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
} finally {
  await rm(stage, { recursive: true, force: true });
}
