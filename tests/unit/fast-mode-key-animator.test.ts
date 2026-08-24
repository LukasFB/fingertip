import assert from "node:assert/strict";
import test from "node:test";

import {
  FAST_MODE_ANIMATION_FPS,
  FAST_MODE_ANIMATION_FRAME_COUNT,
  renderFastModeKeyDataUrl,
} from "../../src/rendering/fast-mode-key-renderer.ts";
import { FastModeKeyAnimator } from "../../src/runtime/fast-mode-key-animator.ts";

test("Fast Mode renders the recovered electric bolt as a seamless four-second loop", () => {
  const first = decodeURIComponent(renderFastModeKeyDataUrl({
    state: "fast", offline: false, animationPhase: 0,
  }));
  const loop = decodeURIComponent(renderFastModeKeyDataUrl({
    state: "fast", offline: false, animationPhase: 1,
  }));
  const standard = decodeURIComponent(renderFastModeKeyDataUrl({
    state: "standard", offline: false,
  }));

  assert.equal(FAST_MODE_ANIMATION_FPS, 30);
  assert.equal(FAST_MODE_ANIMATION_FRAME_COUNT, 120);
  assert.equal(first, loop);
  assert.match(first, /data-animation="fast-electric"/u);
  assert.match(first, /data-arcs="12"/u);
  assert.match(first, /data-sparks="60"/u);
  assert.doesNotMatch(first, /<text/u);
  assert.doesNotMatch(first, /<rect y="116"/u);
  assert.doesNotMatch(standard, /data-animation=/u);
  assert.doesNotMatch(standard, /<text/u);
  assert.match(standard, /stroke="#ffffff"/u);
});

test("Fast Mode animation coalesces slow frames and stops atomically on Standard", async () => {
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const images: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const animator = new FastModeKeyAnimator({
    setImage(image) {
      images.push(decodeURIComponent(image));
      if (images.length === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
      return Promise.resolve();
    },
  }, {
    setTimer(callback, delay) {
      timers.push({ callback, delay, cleared: false });
      return timers.length;
    },
    clearTimer(timer) {
      const entry = timers[Number(timer) - 1];
      if (entry !== undefined) entry.cleared = true;
    },
  });

  animator.render({ signature: "fast", state: "fast", offline: false });
  assert.equal(timers[0]?.delay, 1_000 / FAST_MODE_ANIMATION_FPS);
  timers[0]?.callback();
  timers[1]?.callback();
  assert.equal(images.length, 1);

  animator.render({ signature: "standard", state: "standard", offline: false });
  assert.equal(timers[2]?.cleared, true);
  releaseFirst?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(images.length, 2);
  assert.doesNotMatch(images[1] ?? "", /<text/u);
  assert.match(images[1] ?? "", /stroke="#ffffff"/u);

  animator.dispose();
});
