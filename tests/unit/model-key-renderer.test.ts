import assert from "node:assert/strict";
import test from "node:test";

import { renderModelKeyDataUrl, renderModelKeySvg } from "../../src/rendering/model-key-renderer.ts";
import { normalizeModelKeySettings } from "../../src/settings/model-key-settings.ts";

test("model key displays its configured model and effort, with independently chosen fonts and alignment", () => {
  const settings = normalizeModelKeySettings({ model: "future/v1", effort: "adaptive", modelFontSize: 12, effortFontSize: 8, textAlignment: "right" });
  const svg = renderModelKeySvg({ settings, modelLabel: "Future Model" });
  assert.match(svg, /data-label="model"[^>]+x="66"[^>]+text-anchor="end"[^>]+font-size="12"/u);
  assert.match(svg, /data-label="effort"[^>]+font-size="8"/u);
  assert.match(svg, /adaptive/u);
  assert.equal(svg.includes("future/v1"), false);
  const url = renderModelKeyDataUrl({ settings, modelLabel: "Future Model" });
  assert.equal(decodeURIComponent(url.slice("data:image/svg+xml,".length)), svg);
});

test("model key chooses readable text colors for arbitrary backgrounds", () => {
  for (const [backgroundColor, expected] of [["#ffffff", "#000000"], ["#000000", "#ffffff"], ["#aaaaaa", "#000000"]]) {
    const svg = renderModelKeySvg({ settings: normalizeModelKeySettings({ backgroundColor }) });
    assert.match(svg, new RegExp(`<text data-label="model"[^>]+fill="${expected}"`, "u"));
  }
});

test("model names escape XML while long names and thinking levels stay within the key", () => {
  const escaped = renderModelKeySvg({ settings: normalizeModelKeySettings({ model: "A<&", effort: "B>'" }) });
  assert.match(escaped, /A&lt;&amp;/u);
  assert.match(escaped, /B&gt;&apos;/u);
  const svg = renderModelKeySvg({ settings: normalizeModelKeySettings({
    model: "A future model with a very long display name 🪐 that needs clipping",
    effort: "a very long adaptive thinking strategy",
    modelFontSize: 14,
    effortFontSize: 14,
  }) });
  assert.match(svg, /…/u);
  const baselines = [...svg.matchAll(/<text data-label="(?:model|effort)"[^>]+y="([\d.]+)"/gu)].map((match) => Number(match[1]));
  assert.equal(baselines.length, 2);
  assert.ok(baselines.every((baseline) => baseline > 0 && baseline < 68));
});

test("unconfigured and offline keys give explicit visual feedback without losing their chosen labels", () => {
  const unconfigured = renderModelKeySvg({ settings: normalizeModelKeySettings(undefined) });
  assert.match(unconfigured, /Choose/u);
  const offline = renderModelKeySvg({ settings: normalizeModelKeySettings({ model: "future", effort: "adaptive" }), offline: true });
  assert.match(offline, /future/u);
  assert.match(offline, /adaptive/u);
  assert.match(offline, /data-offline="true"/u);
});

test("long numeric model identifiers fit rather than overflowing with digit-one width estimates", () => {
  const svg = renderModelKeySvg({ settings: normalizeModelKeySettings({
    model: "11111111111111111111111111111111111",
    effort: "1111111111111111111111111",
    modelFontSize: 14,
    effortFontSize: 14,
  }) });
  const labels = [...svg.matchAll(/<text data-label="(?:model|effort)"[^>]+>([^<]+)<\/text>/gu)].map((match) => match[1] ?? "");
  assert.ok(labels.every((label) => label.replace("…", "").length * 14 * 0.556 + (label.includes("…") ? 14 : 0) <= 60));
  assert.equal(labels.length, 2);
  assert.ok(labels.some((label) => label.includes("…")));
});

test("model and thinking use two explicit Stream Deck text elements with visible coordinates", () => {
  const svg = renderModelKeySvg({ settings: normalizeModelKeySettings({ model: "gpt-6.1-sol", effort: "ultra" }), modelLabel: "GPT-6.1-Sol" });
  assert.match(svg, /<text data-label="model"[^>]+y="30"[^>]+font-family="Arial, Helvetica, sans-serif"[^>]+fill="#ffffff">GPT-6\.1-Sol<\/text>/u);
  assert.match(svg, /<text data-label="effort"[^>]+y="54"[^>]+fill="#ffffff">ultra<\/text>/u);
  assert.doesNotMatch(svg, /<tspan/u);
});

test("only an online active model key shows its border without changing its two labels", () => {
  const settings = normalizeModelKeySettings({ model: "gpt-6.1-sol", effort: "ultra" });
  const inactive = renderModelKeySvg({ settings });
  const active = renderModelKeySvg({ settings, active: true });
  const offline = renderModelKeySvg({ settings, active: true, offline: true });
  assert.doesNotMatch(inactive, /data-active/u);
  assert.match(active, /data-active="true"/u);
  assert.doesNotMatch(offline, /data-active/u);
  for (const svg of [inactive, active, offline]) {
    assert.equal([...svg.matchAll(/<text data-label="(?:model|effort)"/gu)].length, 2);
    assert.match(svg, />gpt-6\.1-sol<\/text>/u);
    assert.match(svg, />ultra<\/text>/u);
  }
});

test("active border has a readable edge against dark, light, and middle-tone backgrounds", () => {
  const luminance = (color: string): number => {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
  };
  for (const backgroundColor of ["#000000", "#ffffff", "#777777", "#96cff4", "#ffad28"]) {
    const svg = renderModelKeySvg({ settings: normalizeModelKeySettings({ backgroundColor }), active: true });
    const border = svg.match(/<g data-active="true">([\s\S]*?)<\/g>/u)?.[1] ?? "";
    const colors = [...border.matchAll(/stroke="(#[0-9a-f]{6})"/gu)].map((match) => match[1] ?? "");
    const background = luminance(backgroundColor);
    assert.equal(colors.length, 2);
    assert.ok(colors.some((color) => {
      const edge = luminance(color);
      return (Math.max(edge, background) + 0.05) / (Math.min(edge, background) + 0.05) >= 4.5;
    }), `No readable active edge against ${backgroundColor}`);
  }
});
