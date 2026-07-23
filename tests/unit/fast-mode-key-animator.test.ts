import assert from "node:assert/strict";
import test from "node:test";

import {
  FAST_MODE_ANIMATION_FPS,
  FAST_MODE_ANIMATION_FRAME_COUNT,
} from "../../src/rendering/utility-key-renderer.ts";
import { FastModeKeyAnimator } from "../../src/runtime/fast-mode-key-animator.ts";

test("active Fast Mode runs a 120-frame 30 fps loop and stops atomically on Standard", async () => {
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

  assert.equal(FAST_MODE_ANIMATION_FPS, 30);
  assert.equal(FAST_MODE_ANIMATION_FRAME_COUNT, 120);
  animator.render({ signature: "fast", state: "fast", offline: false });
  assert.match(images[0] ?? "", /data-animation="fast-electric"/u);
  assert.equal(timers[0]?.delay, 1_000 / 30);

  timers[0]?.callback();
  timers[1]?.callback();
  assert.equal(images.length, 1, "slow hardware coalesces decorative frames");

  animator.render({ signature: "standard", state: "standard", offline: false });
  assert.equal(timers[2]?.cleared, true);
  releaseFirst?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(images.length, 2);
  assert.doesNotMatch(images[1] ?? "", /data-animation=/u);
  assert.match(images[1] ?? "", />STANDARD<\/text>/u);

  animator.dispose();
});
