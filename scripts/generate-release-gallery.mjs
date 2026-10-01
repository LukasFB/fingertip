import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bases = path.join(root, "scripts", "marketplace-assets", "bases");
const output = path.join(root, "marketplace-assets");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const settings = [
  ["settings-general.png", "gallery-4-settings-general.png"],
  ["settings-appearance.png", "gallery-5-settings-appearance.png"],
  ["settings-notifications.png", "gallery-6-settings-notifications.png"],
];
for (const [source, target] of settings) {
  const result = spawnSync("magick", [
    path.join(bases, source),
    "-fill", "#0c123d", "-draw", "rectangle 74,838 302,883",
    "-font", "Helvetica-Neue", "-pointsize", "20", "-kerning", "5",
    "-fill", "#b8cbf1", "-draw", `text 83,868 'VERSION ${version}'`,
    "-strip", "-define", "png:color-type=6", path.join(output, target),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`magick exited with ${result.status}`);
}
process.stdout.write(`generated release settings images for ${version}\n`);
