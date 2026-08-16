import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeTaskKeyAppearanceSettings,
  normalizeTaskKeySettings,
} from "../src/settings/task-key-settings.ts";
import { renderSnapshotDataUrl } from "../src/runtime/task-key-render-queue.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, "..");
const generatorDirectory = join(scriptDirectory, "marketplace-assets");
const basesDirectory = join(generatorDirectory, "bases");
const outputDirectory = join(repository, "marketplace-assets");
const perspective = JSON.parse(await readFile(join(generatorDirectory, "perspective.json"), "utf8"));

const tasks = [
  { projectLabel: "northstar.app", title: "Review import", status: "working", activityLabel: "just now", taskChangeStats: { added: 42, deleted: 8, files: 3 }, queuedMessageCount: 2 },
  { projectLabel: "northstar.app", title: "Prepare release", status: "waiting", activityLabel: "2 minutes ago", taskChangeStats: { added: 18, deleted: 4, files: 2 } },
  { projectLabel: "northstar.app", title: "Validation complete", status: "done", activityLabel: "ready" },
  { projectLabel: "papertrail", title: "Review release copy", status: "waiting", activityLabel: "waiting" },
  { projectLabel: "papertrail", title: "Remove legacy assets", status: "idle", activityLabel: "inactive" },
  { projectLabel: "fingertip", title: "Refactor renderer", status: "idle", taskChangeStats: { added: 184, deleted: 23, files: 6 } },
  { projectLabel: "fingertip", title: "Marketplace assets ready", status: "done", taskChangeStats: { added: 29, deleted: 12, files: 4 }, queuedMessageCount: 3 },
  { projectLabel: "fingertip", title: "Update webhook retry", status: "working", activityLabel: "just now", taskChangeStats: { added: 442, deleted: 88, files: 5 }, highlighted: true },
  { projectLabel: "launchpad", title: "Approval required", status: "confirmation", activityLabel: "blocked", hasOngoingGoal: true },
  { projectLabel: "launchpad", title: "Deploy release", status: "idle", activityLabel: "inactive" },
  { projectLabel: "commerce", title: "Fix checkout totals", status: "working", taskChangeStats: { added: 318, deleted: 41, files: 7 } },
  { projectLabel: "commerce", title: "All tests passing", status: "done", activityLabel: "done" },
  { projectLabel: "docs", title: "Update installer prompt", status: "idle", taskChangeStats: { added: 34, deleted: 17, files: 2 } },
  { projectLabel: "docs", title: "Waiting for feedback", status: "waiting", activityLabel: "4 minutes ago" },
  { projectLabel: "docs", title: "Optimize task ordering", status: "working", activityLabel: "4 minutes ago" },
];

const appearance = normalizeTaskKeyAppearanceSettings({
  version: 14,
  textAlignment: "center",
  borderEnabled: false,
  projectColorEnabled: true,
  projectColorOpacity: 61,
  showGitDiffStats: true,
  showQueueBadge: true,
  showGoalBadge: true,
  badgePosition: "top-right",
  badgeFontSize: 15,
});

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
}

function svgFromDataUrl(dataUrl) {
  const prefix = "data:image/svg+xml,";
  if (!dataUrl.startsWith(prefix)) throw new Error("unexpected renderer data URL");
  return decodeURIComponent(dataUrl.slice(prefix.length));
}

function validateTaskLayout() {
  const orangeTasks = tasks.filter((task) => task.status === "confirmation");
  if (orangeTasks.length !== 1) {
    throw new Error(`marketplace artwork must contain exactly one orange task; found ${orangeTasks.length}`);
  }
  for (let row = 0; row < 3; row += 1) {
    const labels = tasks.slice(row * 5, row * 5 + 5).map((task) => task.projectLabel);
    const runs = [];
    for (const label of labels) {
      const run = runs.at(-1);
      if (run?.label === label) run.length += 1;
      else runs.push({ label, length: 1 });
    }
    if (runs.some((run) => run.length < 2 || run.length > 3)) {
      throw new Error(`row ${row + 1} must group projects in adjacent runs of two or three keys`);
    }
  }
}

function pointPair(source, destination) {
  return `${source[0]},${source[1]} ${destination[0]},${destination[1]}`;
}

function keyPath(keysDirectory, key) {
  return join(keysDirectory, `key-${String(key).padStart(2, "0")}.png`);
}

async function renderKeys(workDirectory) {
  const svgDirectory = join(workDirectory, "svg");
  const keysDirectory = join(workDirectory, "keys");
  await mkdir(svgDirectory, { recursive: true });
  await mkdir(keysDirectory, { recursive: true });

  const renderer = join(workDirectory, "render-svg-webkit");
  run("xcrun", [
    "swiftc",
    "-framework", "AppKit",
    "-framework", "WebKit",
    join(generatorDirectory, "render-svg-webkit.swift"),
    "-o", renderer,
  ]);

  for (const [index, task] of tasks.entries()) {
    const keyNumber = index + 1;
    const snapshot = {
      kind: "task",
      settings: normalizeTaskKeySettings({ taskPosition: keyNumber, taskSource: "pinned-projects" }),
      appearance,
      taskId: `marketplace-task-${String(keyNumber).padStart(2, "0")}`,
      pressTarget: `codex://threads/marketplace-task-${String(keyNumber).padStart(2, "0")}`,
      liveFreshness: "fresh",
      offlineWarning: false,
      renderSignature: `marketplace-artwork-${keyNumber}`,
      ...task,
    };
    const effect = task.status === "working"
      ? { kind: "working-noise", intensity: 1, phase: (index + 3) / 20 }
      : undefined;
    const svg = svgFromDataUrl(renderSnapshotDataUrl(snapshot, effect))
      .replace("<svg ", '<svg width="144" height="144" ');
    const svgPath = join(svgDirectory, `key-${String(keyNumber).padStart(2, "0")}.svg`);
    const rawPath = join(keysDirectory, `key-${String(keyNumber).padStart(2, "0")}.raw.png`);
    const outputPath = keyPath(keysDirectory, keyNumber);
    await writeFile(svgPath, svg);
    let rendered = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      run(renderer, [svgPath, rawPath, "576"]);
      const deviation = Number(run("magick", [
        rawPath,
        "-colorspace", "gray",
        "-format", "%[fx:standard_deviation]",
        "info:",
      ]).trim());
      if (Number.isFinite(deviation) && deviation > 0.01) {
        rendered = true;
        break;
      }
    }
    if (!rendered) throw new Error(`WebKit produced a blank image for key ${keyNumber}`);
    run("magick", [
      rawPath,
      "(", "-size", "576x576", "xc:black", "+antialias", "-fill", "white",
      "-draw", "roundrectangle 16,16 560,560 62,62", ")",
      "-alpha", "off", "-compose", "CopyOpacity", "-composite",
      outputPath,
    ]);
  }
  return keysDirectory;
}

function composeAsset(assetName, asset, keysDirectory, workDirectory) {
  const panel = perspective.panel;
  const panelPath = join(workDirectory, `${assetName}.panel.png`);
  const projectedPath = join(workDirectory, `${assetName}.projected.png`);
  const outputPath = join(workDirectory, assetName);
  const [canvasWidth, canvasHeight] = panel.canvasSize;
  const panelArgs = ["-size", `${canvasWidth}x${canvasHeight}`, "xc:none"];
  for (const centerY of panel.keyCentersY) {
    for (const centerX of panel.keyCentersX) {
      const half = panel.backingSize / 2;
      panelArgs.push(
        "-fill", "#050708",
        "-draw", `roundrectangle ${centerX - half},${centerY - half} ${centerX + half},${centerY + half} 12,12`,
      );
    }
  }
  for (let index = 0; index < 15; index += 1) {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const keySize = panel.keySizesByRow[row];
    const x = panel.keyCentersX[column] - keySize / 2;
    const y = panel.keyCentersY[row] - keySize / 2;
    panelArgs.push(
      "(", keyPath(keysDirectory, index + 1), "-resize", `${keySize}x${keySize}!`, ")",
      "-geometry", `+${x}+${y}`,
      "-composite",
    );
  }
  panelArgs.push(panelPath);
  run("magick", panelArgs);

  const order = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  const project = (input, corners, output) => {
    const controlPoints = order.map((corner) => pointPair(
      panel.sourceCorners[corner],
      corners[corner],
    )).join("  ");
    run("magick", [
      input,
      "-alpha", "on",
      "-virtual-pixel", "transparent",
      "-set", "option:distort:viewport", "1920x960+0+0",
      "+distort", "Perspective", controlPoints,
      "-crop", "1920x960+0+0", "+repage",
      output,
    ]);
  };
  project(panelPath, asset.destinationCorners, projectedPath);

  const composeArgs = [join(basesDirectory, assetName), projectedPath, "-composite"];
  for (const callout of asset.callouts) {
    composeArgs.push(
      "(", keyPath(keysDirectory, callout.key), "-resize", `${callout.size}x${callout.size}!`, ")",
      "-geometry", `+${callout.x}+${callout.y}`,
      "-composite",
    );
  }
  composeArgs.push("-strip", outputPath);
  run("magick", composeArgs);
  return outputPath;
}

validateTaskLayout();
const workDirectory = await mkdtemp(join(tmpdir(), "fingertip-marketplace-"));
try {
  const keysDirectory = await renderKeys(workDirectory);
  const generated = [];
  for (const [assetName, asset] of Object.entries(perspective.assets)) {
    generated.push([assetName, composeAsset(assetName, asset, keysDirectory, workDirectory)]);
  }
  for (const [assetName, source] of generated) {
    await copyFile(source, join(outputDirectory, assetName));
  }
  console.log(`generated ${generated.length} hardware marketplace assets`);
} finally {
  if (process.env.KEEP_MARKETPLACE_WORK !== "1") {
    await rm(workDirectory, { recursive: true, force: true });
  } else {
    console.log(`kept generator work directory: ${workDirectory}`);
  }
}
