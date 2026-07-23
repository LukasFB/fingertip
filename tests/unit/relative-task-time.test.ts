import assert from "node:assert/strict";
import test from "node:test";

import { formatTaskActivityTime } from "../../src/rendering/relative-task-time.ts";

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);

test("recent Task Activity Times use compact relative English labels", () => {
  assert.equal(formatTaskActivityTime(NOW, NOW), "just now");
  assert.equal(formatTaskActivityTime(NOW - 59_000, NOW), "just now");
  assert.equal(formatTaskActivityTime(NOW - 60_000, NOW), "1 minute ago");
  assert.equal(formatTaskActivityTime(NOW - 17 * 60_000, NOW), "17 minutes ago");
  assert.equal(formatTaskActivityTime(NOW - 90 * 60_000, NOW), "1:30 hour ago");
  assert.equal(formatTaskActivityTime(NOW - 150 * 60_000, NOW), "2:30 hours ago");
});

test("older Task Activity Times use yesterday and day labels", () => {
  assert.equal(formatTaskActivityTime(NOW - 24 * 60 * 60_000, NOW), "yesterday");
  assert.equal(formatTaskActivityTime(NOW - 47 * 60 * 60_000, NOW), "yesterday");
  assert.equal(formatTaskActivityTime(NOW - 4 * 24 * 60 * 60_000, NOW), "4 days ago");
});

test("app-server Unix-second timestamps and future clock skew are handled", () => {
  assert.equal(formatTaskActivityTime((NOW - 5 * 60_000) / 1_000, NOW), "5 minutes ago");
  assert.equal(formatTaskActivityTime(NOW + 60_000, NOW), "just now");
});
