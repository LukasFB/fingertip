import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "assets", "model-selector-v3");
const outputRoot = path.join(root, "com.lukas-bhm.fingertip.sdPlugin", "imgs", "actions");
const optionOutputRoot = path.join(outputRoot, "model-options");
const selectorOutputRoot = path.join(outputRoot, "model-selector");
const stage = await mkdtemp(path.join(os.tmpdir(), "fingertip-model-assets-"));

const families = Object.freeze({
  astra: { label: "ASTRA 6", accent: "#ffffff" },
  sol: { label: "SOL", accent: "#ffb224" },
  terra: { label: "TERRA", accent: "#45e6ff" },
  luna: { label: "LUNA", accent: "#c8a6ff" },
});
const efforts = Object.freeze({
  low: "LIGHT",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "EXTRA HIGH",
  max: "MAX",
});

function runMagick(args) {
  const result = spawnSync("magick", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`magick exited with ${result.status}`);
}

function optionOverlay(family, effort, selected) {
  const familySpec = families[family];
  const effortLabel = efforts[effort];
  const effortSize = effort === "xhigh" ? 24 : effort === "max" ? 29 : 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288" viewBox="0 0 288 288">
    <rect y="198" width="288" height="90" fill="#000"/>
    <rect y="198" width="288" height="4" fill="${familySpec.accent}"/>
    <text x="144" y="237" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="33" font-weight="900" letter-spacing="1.5" fill="#fff">${familySpec.label}</text>
    <text x="144" y="273" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${effortSize}" font-weight="900" letter-spacing="0" fill="#fff">${effortLabel}</text>
    ${selected ? `<rect x="6" y="6" width="276" height="276" rx="27" fill="none" stroke="#fff" stroke-width="3"/><rect x="11" y="11" width="266" height="266" rx="23" fill="none" stroke="${familySpec.accent}" stroke-width="8"/>` : ""}
  </svg>`;
}

function selectorOverlay(offline) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <rect y="82" width="144" height="62" fill="#000"/>
    <rect y="82" width="144" height="2" fill="${offline ? "#ffd166" : "#fff"}"/>
    <text x="72" y="108" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="20" font-weight="900" letter-spacing="0.2" fill="#fff">MODEL</text>
    <text x="72" y="132" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="17" font-weight="900" letter-spacing="0" fill="${offline ? "#ffd166" : "#fff"}">${offline ? "OFFLINE" : "SELECTOR"}</text>
  </svg>`;
}

try {
  await Promise.all([mkdir(optionOutputRoot, { recursive: true }), mkdir(selectorOutputRoot, { recursive: true })]);
  for (const family of Object.keys(families)) {
    for (const effort of Object.keys(efforts)) {
      const background = path.join(sourceRoot, "backgrounds", `${family}-${effort}.png`);
      for (const selected of [false, true]) {
        const suffix = selected ? "-selected" : "";
        const overlay = path.join(stage, `${family}-${effort}${suffix}.svg`);
        const output2x = path.join(optionOutputRoot, `${family}-${effort}${suffix}@2x.png`);
        const output = path.join(optionOutputRoot, `${family}-${effort}${suffix}.png`);
        await writeFile(overlay, optionOverlay(family, effort, selected));
        const composeArgs = [background, "(", "-background", "none", overlay, ")",
          "-compose", "over", "-composite"];
        if (selected) {
          composeArgs.push(
            "-fill", "none", "-stroke", "#fff", "-strokewidth", "3",
            "-draw", "roundrectangle 6,6 282,282 27,27",
            "-stroke", families[family].accent, "-strokewidth", "8",
            "-draw", "roundrectangle 11,11 277,277 23,23",
          );
        }
        composeArgs.push(output2x);
        runMagick(composeArgs);
        runMagick([output2x, "-filter", "Lanczos", "-resize", "144x144!", output]);
      }
    }
  }

  for (const offline of [false, true]) {
    const suffix = offline ? "-offline" : "";
    const source = path.join(sourceRoot, `selector-key${suffix}.png`);
    const overlay = path.join(stage, `selector-key${suffix}.svg`);
    const output2x = path.join(selectorOutputRoot, `key${suffix}@2x.png`);
    const output = path.join(selectorOutputRoot, `key${suffix}.png`);
    await writeFile(overlay, selectorOverlay(offline));
    runMagick([source, "(", "-background", "none", overlay, ")",
      "-compose", "over", "-composite", output2x]);
    runMagick([output2x, "-filter", "Lanczos", "-resize", "72x72!", output]);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
