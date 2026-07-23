import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const profileRoot = new URL("../../acceptance/FINGERTIP-ACCEPTANCE.sdProfile/", import.meta.url);

test("the isolated XL acceptance profile contains exactly ranked Tasks 1 through 5", async () => {
  const umbrella = JSON.parse(await readFile(new URL("../../acceptance/package.json", import.meta.url), "utf8")) as {
    DeviceModel: string;
    FormatVersion: number;
    OSType: string;
    RequiredPlugins: string[];
  };
  assert.equal(umbrella.DeviceModel, "20GAT9902");
  assert.equal(umbrella.FormatVersion, 1);
  assert.equal(umbrella.OSType, "Mac");
  assert.deepEqual(umbrella.RequiredPlugins, ["com.lukas-bhm.fingertip"]);

  const root = JSON.parse(await readFile(new URL("manifest.json", profileRoot), "utf8")) as {
    Device: { Model: string; UUID: string };
    Name: string;
    Pages: { Current: string; Default: string; Pages: string[] };
    Version: string;
  };

  assert.deepEqual(root, {
    Device: { Model: "20GAT9902", UUID: "" },
    Name: "Fingertip Acceptance",
    Pages: {
      Current: "00000000-0000-0000-0000-000000000000",
      Default: "920ff240-dbed-4dba-93ff-233bfcd7c16c",
      Pages: ["8caa7626-ae32-4d84-8a66-78ba153340a3"],
    },
    Version: "3.0",
  });

  const page = JSON.parse(await readFile(new URL(
    "Profiles/8caa7626-ae32-4d84-8a66-78ba153340a3/manifest.json",
    profileRoot,
  ), "utf8")) as {
    Controllers: Array<{ Type: string; Actions: Record<string, {
      ActionID: string;
      Plugin: { Name: string; UUID: string; Version: string };
      Settings: {
        version: number;
        taskPosition: number;
        taskSource: string;
      };
      UUID: string;
    }> }>;
  };

  assert.equal(page.Controllers.length, 1);
  assert.equal(page.Controllers[0]?.Type, "Keypad");
  const actions = Object.entries(page.Controllers[0]?.Actions ?? {});
  assert.deepEqual(actions.map(([coordinate]) => coordinate), ["0,0", "1,0", "2,0", "3,0", "4,0"]);
  assert.deepEqual(actions.map(([, action]) => action.Settings), [1, 2, 3, 4, 5].map((taskPosition) => ({
    taskPosition,
    taskSource: "pinned-projects",
    version: 4,
  })));
  assert.equal(new Set(actions.map(([, action]) => action.ActionID)).size, 5);
  for (const [, action] of actions) {
    assert.equal(action.UUID, "com.lukas-bhm.fingertip.task");
    assert.deepEqual(action.Plugin, {
      Name: "Fingertip",
      UUID: "com.lukas-bhm.fingertip",
      Version: "0.1.0.0",
    });
  }

  const defaultPage = JSON.parse(await readFile(new URL(
    "Profiles/920ff240-dbed-4dba-93ff-233bfcd7c16c/manifest.json",
    profileRoot,
  ), "utf8")) as { Controllers: Array<{ Type: string; Actions: Record<string, unknown> }> };
  assert.deepEqual(defaultPage.Controllers, [{ Actions: {}, Type: "Keypad" }]);
});
