import assert from "node:assert/strict";
import test from "node:test";

import { createKeySnapshot, type KeySnapshot } from "../../src/runtime/key-snapshot.ts";
import { TaskKeyRenderQueue } from "../../src/runtime/task-key-render-queue.ts";
import { DEFAULT_TASK_KEY_APPEARANCE, normalizeTaskKeySettings } from "../../src/settings/task-key-settings.ts";
import type { TaskStatus } from "../../src/status/task-status-projector.ts";

function snapshot(title: string, idSuffix: string, status: TaskStatus = "idle"): KeySnapshot {
  const id = `00000000-0000-4000-8000-${idSuffix.padStart(12, "0")}`;
  return createKeySnapshot({
    settings: normalizeTaskKeySettings(undefined),
    appearance: DEFAULT_TASK_KEY_APPEARANCE,
    now: 1_000,
    catalog: { state: "fresh", feed: [{ id, createdAt: 1, activityAt: 1, title, source: "pinned-projects" }] },
    desktopState: "online",
    liveByTaskId: new Map([[id, { freshness: "fresh", status }]]),
  });
}

class FakeTimers {
  #nextId = 1;
  readonly pending = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  readonly delays: number[] = [];

  readonly setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.pending.set(id, { callback, delayMs });
    this.delays.push(delayMs);
    return id;
  };

  readonly clearTimer = (timer: ReturnType<typeof setTimeout> | number): void => {
    if (typeof timer === "number") this.pending.delete(timer);
  };

  runNext(): void {
    const next = this.pending.entries().next().value as [number, { readonly callback: () => void }] | undefined;
    assert.ok(next, "expected an animation timer");
    this.pending.delete(next[0]);
    next[1].callback();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Task Key commits only sent snapshots and coalesces only pending candidates", async () => {
  const gates = [deferred(), deferred()];
  const images: string[] = [];
  const queue = new TaskKeyRenderQueue({
    async setImage(image) {
      images.push(decodeURIComponent(image));
      await gates[images.length - 1]?.promise;
    },
    async showAlert() {},
  });
  const first = snapshot("First Task", "1");
  const skipped = snapshot("Skipped Task", "2");
  const latest = snapshot("Latest Task", "3");

  queue.enqueue(first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(images.length, 1);
  assert.equal(queue.displayedSnapshot, null);

  queue.enqueue(skipped);
  queue.enqueue(latest);
  gates[0]?.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.displayedSnapshot, first);
  assert.equal(images.length, 2);
  assert.equal(images[1]?.includes("Latest Task"), true);
  assert.equal(images[1]?.includes("Skipped Task"), false);

  gates[1]?.resolve();
  await queue.whenIdle();
  assert.equal(queue.displayedSnapshot, latest);
});

test("a rejected image retains the old press target and retries only the latest candidate with bounded backoff", async () => {
  const delays: number[] = [];
  const alerts: number[] = [];
  const submittedTitles: string[] = [];
  let failuresRemaining = 2;
  const queue = new TaskKeyRenderQueue({
    async setImage(image) {
      const svg = decodeURIComponent(image);
      submittedTitles.push(svg.includes("Replacement Task") ? "replacement" : "original");
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("fixture rejection");
      }
    },
    async showAlert() { alerts.push(1); },
  }, {
    async sleep(delayMs) {
      delays.push(delayMs);
      if (delays.length === 1) queue.enqueue(snapshot("Replacement Task", "2"));
    },
  });
  const original = snapshot("Original Task", "1");

  queue.enqueue(original);
  await queue.whenIdle();

  assert.deepEqual(delays, [500, 1_000]);
  assert.deepEqual(alerts, [1]);
  assert.deepEqual(submittedTitles, ["original", "replacement", "replacement"]);
  const displayed = queue.displayedSnapshot;
  assert.equal(displayed?.kind, "task");
  assert.equal(displayed?.kind === "task" && displayed.taskId.endsWith("000000000002"), true);
  assert.equal(queue.retryAttempt, 0);
  assert.equal(queue.imageUpdateFailed, false);
});

test("image retry backoff stays capped at ten seconds for one alert burst", async () => {
  const delays: number[] = [];
  let alerts = 0;
  let attempts = 0;
  const queue = new TaskKeyRenderQueue({
    async setImage() {
      attempts += 1;
      if (attempts <= 6) throw new Error("fixture rejection");
    },
    async showAlert() { alerts += 1; },
  }, {
    async sleep(delayMs) { delays.push(delayMs); },
  });

  queue.enqueue(snapshot("Eventually rendered", "9"));
  await queue.whenIdle();

  assert.deepEqual(delays, [500, 1_000, 2_000, 5_000, 10_000, 10_000]);
  assert.equal(alerts, 1);
  assert.equal(queue.imageUpdateFailed, false);
});

test("a live Working Task scrolls a loopable noise texture right-to-left and stops on dispose", async () => {
  const timers = new FakeTimers();
  const images: string[] = [];
  const queue = new TaskKeyRenderQueue({
    async setImage(image) { images.push(decodeURIComponent(image)); },
    async showAlert() {},
  }, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  queue.enqueue(snapshot("Animated Task", "1", "working"));
  await queue.whenIdle();
  assert.equal(images.length, 1);
  assert.match(images[0] ?? "", /data-animation="working-noise"/u);
  assert.match(images[0] ?? "", /patternTransform="translate\(0 0\)"/u);
  assert.equal(Math.abs((timers.delays[0] ?? 0) - 1_000 / 24) < 0.001, true);

  timers.runNext();
  await queue.whenIdle();
  assert.equal(images.length, 2);
  assert.match(images[1] ?? "", /data-animation="working-noise"/u);
  assert.match(images[0] ?? "", /width="172\.8" height="172\.8"/u);
  assert.match(images[0] ?? "", /stop-color="#ffffff"/u);
  assert.match(images[0] ?? "", /stop-color="#57778e"/u);
  assert.match(images[0] ?? "", /fill-opacity="0\.72"/u);
  assert.match(images[0] ?? "", /stdDeviation="11\.4"/u);
  assert.match(images[1] ?? "", /patternTransform="translate\(-2\.47 0\)"/u);
  assert.notEqual(images[1], images[0]);
  assert.equal(timers.pending.size, 1);

  for (let frame = 1; frame < 70; frame += 1) {
    timers.runNext();
    await queue.whenIdle();
  }
  assert.equal(images.length, 71);
  assert.match(images.at(-1) ?? "", /patternTransform="translate\(0 0\)"/u);
  assert.equal(timers.delays.every((delay) => Math.abs(delay - 1_000 / 24) < 0.001), true);

  queue.dispose();
  assert.equal(timers.pending.size, 0);
});

test("Working to Waiting or Confirmation flashes twice and settles without delaying the new state", async () => {
  for (const status of ["waiting", "confirmation"] as const) {
    const timers = new FakeTimers();
    const images: string[] = [];
    const queue = new TaskKeyRenderQueue({
      async setImage(image) { images.push(decodeURIComponent(image)); },
      async showAlert() {},
    }, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    queue.enqueue(snapshot("Transition Task", "1", "working"));
    await queue.whenIdle();
    queue.enqueue(snapshot("Transition Task", "1", status));
    await queue.whenIdle();

    assert.match(images.at(-1) ?? "", /data-animation="status-flash"/u);
    assert.equal(queue.displayedSnapshot?.kind === "task" && queue.displayedSnapshot.status, status);
    assert.equal(timers.pending.size, 1);

    for (let frame = 0; frame < 4; frame += 1) {
      timers.runNext();
      await queue.whenIdle();
    }
    const transitionImages = images.slice(1);
    assert.equal(transitionImages.length, 5);
    assert.equal(transitionImages.filter((image) => image.includes('data-animation="status-flash"')).length, 4);
    assert.doesNotMatch(transitionImages.at(-1) ?? "", /data-animation=/u);
    assert.equal(timers.pending.size, 0);
    queue.dispose();
  }
});

test("every real transition into Done gets a long double success burst, even when Working was not observed", async () => {
  const timers = new FakeTimers();
  const images: string[] = [];
  const queue = new TaskKeyRenderQueue({
    async setImage(image) { images.push(decodeURIComponent(image)); },
    async showAlert() {},
  }, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  queue.enqueue(snapshot("Completed Task", "1", "idle"));
  await queue.whenIdle();
  queue.enqueue(snapshot("Completed Task", "1", "done"));
  await queue.whenIdle();

  assert.match(images.at(-1) ?? "", /data-animation="done-burst"/u);
  assert.equal(queue.displayedSnapshot?.kind === "task" && queue.displayedSnapshot.status, "done");
  for (let frame = 0; frame < 10; frame += 1) {
    timers.runNext();
    await queue.whenIdle();
  }

  const doneImages = images.slice(1);
  assert.equal(doneImages.length, 11);
  assert.equal(doneImages.filter((image) => image.includes('data-animation="done-burst"')).length, 10);
  assert.doesNotMatch(doneImages.at(-1) ?? "", /data-animation=/u);
  assert.equal(timers.pending.size, 0);
  assert.equal(timers.delays.every((delay) => delay === 165), true);
});

test("a visible Task completing directly from Working to Idle still gets the green Done burst", async () => {
  const timers = new FakeTimers();
  const images: string[] = [];
  const queue = new TaskKeyRenderQueue({
    async setImage(image) { images.push(decodeURIComponent(image)); },
    async showAlert() {},
  }, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  queue.enqueue(snapshot("Visible Task", "1", "working"));
  await queue.whenIdle();
  queue.enqueue(snapshot("Visible Task", "1", "idle"));
  await queue.whenIdle();

  const completion = images.at(-1) ?? "";
  assert.match(completion, /data-animation="done-burst"/u);
  assert.match(completion, /fill="#dffbdd"/u);
  assert.equal(queue.displayedSnapshot?.kind === "task" && queue.displayedSnapshot.status, "idle");
  assert.equal(timers.pending.size, 1);
  queue.dispose();
});

test("moving a key from one Task to another cancels Working animation without a false completion flash", async () => {
  const timers = new FakeTimers();
  const images: string[] = [];
  const queue = new TaskKeyRenderQueue({
    async setImage(image) { images.push(decodeURIComponent(image)); },
    async showAlert() {},
  }, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  queue.enqueue(snapshot("Old Task", "1", "working"));
  await queue.whenIdle();
  assert.equal(timers.pending.size, 1);

  queue.enqueue(snapshot("New Task", "2", "done"));
  await queue.whenIdle();
  assert.equal(timers.pending.size, 0);
  assert.doesNotMatch(images.at(-1) ?? "", /data-animation=/u);
  assert.equal(images.at(-1)?.includes("New Task"), true);
});
