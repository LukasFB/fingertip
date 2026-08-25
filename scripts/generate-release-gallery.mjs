import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bases = path.join(root, "scripts", "marketplace-assets", "bases");
const output = path.join(root, "marketplace-assets");
const stage = await mkdtemp(path.join(os.tmpdir(), "fingertip-release-gallery-"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;

function runMagick(args) {
  const result = spawnSync("magick", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`magick exited with ${result.status}`);
}

function imagePlacement({ crop, destination, source }) {
  const scale = destination.width / crop.width;
  return {
    x: destination.x - crop.x * scale,
    y: destination.y - crop.y * scale,
    width: source.width * scale,
    height: source.height * scale,
  };
}

function sharedDefinitions() {
  return `<defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#07061e"/>
      <stop offset="0.48" stop-color="#111044"/>
      <stop offset="1" stop-color="#3922b7"/>
    </linearGradient>
    <radialGradient id="glow" cx="78%" cy="34%" r="66%">
      <stop offset="0" stop-color="#493cff" stop-opacity="0.92"/>
      <stop offset="0.52" stop-color="#29158b" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#07061e" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000" flood-opacity="0.55"/>
    </filter>
  </defs>`;
}

function brand(iconData) {
  return `<image href="data:image/png;base64,${iconData}" x="72" y="58" width="76" height="76"/>
    <text x="176" y="98" font-family="Helvetica Neue,Arial,sans-serif" font-size="28" font-weight="700" letter-spacing="6" fill="#fff">FINGERTIP AGENT</text>
    <text x="176" y="128" font-family="Helvetica Neue,Arial,sans-serif" font-size="14" font-weight="400" letter-spacing="4" fill="#b9c6ff">CODEX TASKS ON STREAM DECK</text>`;
}

function versionBadge() {
  return `<rect x="72" y="860" width="224" height="42" fill="#101548"/>
    <text x="88" y="888" font-family="Helvetica Neue,Arial,sans-serif" font-size="18" fill="#b8cbf1">VERSION ${version}</text>`;
}

function screenshotFrame({ clipId, imageData, crop, destination, source }) {
  const image = imagePlacement({ crop, destination, source });
  return `<clipPath id="${clipId}"><rect x="${destination.x}" y="${destination.y}" width="${destination.width}" height="${destination.height}" rx="24"/></clipPath>
    <rect x="${destination.x - 18}" y="${destination.y - 18}" width="${destination.width + 36}" height="${destination.height + 36}" rx="34" fill="#20212a" stroke="#79cfff" stroke-width="3" filter="url(#shadow)"/>
    <g clip-path="url(#${clipId})">
      <image href="data:image/png;base64,${imageData}" x="${image.x}" y="${image.y}" width="${image.width}" height="${image.height}"/>
    </g>`;
}

function modelSelectorSvg({ iconData, screenshotData }) {
  const crop = { x: 0, y: 0, width: 795, height: 412 };
  const destination = { x: 820, y: 205, width: 1040, height: 539 };
  const source = { width: 795, height: 412 };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="960" viewBox="0 0 1920 960">
    ${sharedDefinitions()}
    <rect width="1920" height="960" fill="url(#background)"/>
    <rect width="1920" height="960" fill="url(#glow)"/>
    <path d="M700 0 L1080 960 L0 960 L0 0 Z" fill="#06051d" opacity="0.58"/>
    ${brand(iconData)}
    <text x="74" y="252" font-family="Helvetica Neue,Arial,sans-serif" font-size="25" font-weight="700" letter-spacing="4" fill="#9fdcff">MODEL SELECTOR</text>
    <text x="72" y="336" font-family="Helvetica Neue,Arial,sans-serif" font-size="66" font-weight="800" fill="#fff">THE RIGHT MODEL.</text>
    <text x="72" y="410" font-family="Helvetica Neue,Arial,sans-serif" font-size="66" font-weight="800" fill="#fff">ONE PRESS.</text>
    <text x="74" y="484" font-family="Helvetica Neue,Arial,sans-serif" font-size="24" fill="#d9def8">Sol, Terra and Luna across five thinking levels.</text>
    <text x="74" y="524" font-family="Helvetica Neue,Arial,sans-serif" font-size="24" fill="#d9def8">The active combination stays highlighted.</text>
    <g font-family="Helvetica Neue,Arial,sans-serif" font-size="16" font-weight="700" letter-spacing="1" fill="#fff">
      <rect x="74" y="586" width="330" height="50" rx="25" fill="#211f70" stroke="#655dff"/><text x="100" y="618">SOL · TERRA · LUNA</text>
      <rect x="74" y="650" width="340" height="50" rx="25" fill="#211f70" stroke="#655dff"/><text x="100" y="682">5 THINKING LEVELS</text>
      <rect x="74" y="714" width="310" height="50" rx="25" fill="#211f70" stroke="#655dff"/><text x="100" y="746">STREAM DECK XL</text>
    </g>
    ${screenshotFrame({ clipId: "selectorClip", imageData: screenshotData, crop, destination, source })}
    ${versionBadge()}
  </svg>`;
}

try {
  const [icon, screenshot] = await Promise.all([
    readFile(path.join(root, "com.lukas-bhm.fingertip.sdPlugin", "imgs", "plugin", "plugin@2x.png")),
    readFile(path.join(bases, "model-selector-ui.png")),
  ]);
  const data = { iconData: icon.toString("base64"), screenshotData: screenshot.toString("base64") };
  const selectors = [["gallery-7-model-selector", modelSelectorSvg(data)]];
  for (const [name, svg] of selectors) {
    const input = path.join(stage, `${name}.svg`);
    await writeFile(input, svg);
    runMagick([input, "-strip", "-depth", "8", "-define", "png:color-type=6", path.join(output, `${name}.png`)]);
  }

  const settings = [
    ["settings-general.png", "gallery-4-settings-general.png"],
    ["settings-appearance.png", "gallery-5-settings-appearance.png"],
    ["settings-notifications.png", "gallery-6-settings-notifications.png"],
  ];
  for (const [source, target] of settings) {
    runMagick([
      path.join(bases, source),
      "-fill", "#0c123d", "-draw", "rectangle 74,838 302,883",
      "-font", "Helvetica-Neue", "-pointsize", "20", "-kerning", "5",
      "-fill", "#b8cbf1", "-draw", `text 83,868 'VERSION ${version}'`,
      "-strip", "-define", "png:color-type=6", path.join(output, target),
    ]);
  }
  process.stdout.write(`generated release gallery assets for ${version}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
