import assert from "node:assert/strict";
import test from "node:test";

import { CatalogCompatibilityTracker } from "../../src/catalog/catalog-compatibility.ts";

test("three identical catalog compatibility failures latch one bundle generation", () => {
  const tracker = new CatalogCompatibilityTracker();
  tracker.observeFingerprint("bundle-a");

  assert.equal(tracker.recordFailure("schema:thread-list"), false);
  assert.equal(tracker.recordFailure("schema:thread-list"), false);
  assert.equal(tracker.recordFailure("schema:thread-list"), true);
  assert.equal(tracker.incompatible, true);
});

test("different catalog failure signatures do not accumulate", () => {
  const tracker = new CatalogCompatibilityTracker();
  tracker.observeFingerprint("bundle-a");

  tracker.recordFailure("schema:thread-list");
  tracker.recordFailure("protocol:response");
  tracker.recordFailure("schema:thread-list");

  assert.equal(tracker.incompatible, false);
});

test("explicit retry clears a catalog incompatibility latch", () => {
  const tracker = new CatalogCompatibilityTracker();
  tracker.observeFingerprint("bundle-a");
  tracker.recordFailure("schema:thread-list");
  tracker.recordFailure("schema:thread-list");
  tracker.recordFailure("schema:thread-list");

  tracker.clearFailures();

  assert.equal(tracker.incompatible, false);
  assert.equal(tracker.recordFailure("schema:thread-list"), false);
});

test("a successful catalog query or changed bundle fingerprint starts a fresh compatibility window", () => {
  const tracker = new CatalogCompatibilityTracker();
  tracker.observeFingerprint("bundle-a");
  tracker.recordFailure("schema:thread-list");
  tracker.recordFailure("schema:thread-list");
  tracker.recordSuccess();
  assert.equal(tracker.recordFailure("schema:thread-list"), false);
  tracker.recordFailure("schema:thread-list");
  tracker.recordFailure("schema:thread-list");
  assert.equal(tracker.incompatible, true);

  tracker.observeFingerprint("bundle-b");

  assert.equal(tracker.incompatible, false);
  assert.equal(tracker.recordFailure("schema:thread-list"), false);
});
