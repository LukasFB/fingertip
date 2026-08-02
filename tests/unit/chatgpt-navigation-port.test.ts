import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ChatGptNavigationPort, type SpawnProcess } from "../../src/chatgpt/chatgpt-navigation-port.ts";
import { parseTaskId } from "../../src/catalog/catalog-projection.ts";

class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

test("navigation launches the canonical Task deep link with an exact no-shell invocation", async () => {
  const calls: unknown[][] = [];
  const spawn: SpawnProcess = (command, args, options) => {
    calls.push([command, args, options]);
    const child = new FakeChild();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  assert.ok(taskId);

  const result = await new ChatGptNavigationPort({ spawn }).openTask(taskId);

  assert.equal(result, true);
  assert.deepEqual(calls, [
    [
      "/usr/bin/open",
      ["-b", "com.openai.codex"],
      { shell: false, stdio: "ignore" },
    ],
    [
      "/usr/bin/open",
      ["-b", "com.openai.codex", "codex://threads/00000000-0000-4000-8000-000000000001"],
      { shell: false, stdio: "ignore" },
    ],
  ]);
});

test("navigation does not wait for the best-effort activation request", async () => {
  const calls: unknown[][] = [];
  const spawn: SpawnProcess = (command, args, options) => {
    calls.push([command, args, options]);
    const child = new FakeChild();
    if (args.length > 2) queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  assert.ok(taskId);

  assert.equal(await new ChatGptNavigationPort({ spawn }).openTask(taskId), true);
  assert.equal(calls.length, 2);
});

test("new-chat navigation targets ChatGPT and invokes its native command-N command", async () => {
  const calls: unknown[][] = [];
  const spawn: SpawnProcess = (command, args, options) => {
    calls.push([command, args, options]);
    const child = new FakeChild();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };

  assert.equal(await new ChatGptNavigationPort({ spawn }).openNewChat(), true);
  assert.deepEqual(calls[0], [
    "/usr/bin/open",
    ["-b", "com.openai.codex"],
    { shell: false, stdio: "ignore" },
  ]);
  assert.equal(calls[1]?.[0], "/usr/bin/osascript");
  const script = (calls[1]?.[1] as readonly string[] | undefined)?.[1] ?? "";
  assert.match(script, /bundle identifier is "com\.openai\.codex"/u);
  assert.match(script, /keystroke "n" using command down/u);
});

test("navigation focuses the selected physical ChatGPT window before opening the Task", async () => {
  const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  assert.ok(taskId);

  for (const [target, comparison] of [["leftmost", "candidateX < targetX"], ["rightmost", "candidateX > targetX"]] as const) {
    const calls: unknown[][] = [];
    const spawn: SpawnProcess = (command, args, options) => {
      calls.push([command, args, options]);
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    };
    const port = new ChatGptNavigationPort({ spawn });
    port.setWindowTarget(target);

    assert.equal(await port.openTask(taskId), true);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], [
      "/usr/bin/open",
      ["-b", "com.openai.codex"],
      { shell: false, stdio: "ignore" },
    ]);
    const focus = calls[1] as [string, readonly string[], unknown];
    assert.equal(focus[0], "/usr/bin/osascript");
    assert.equal(focus[1][0], "-e");
    assert.match(focus[1][1] ?? "", new RegExp(comparison.replaceAll(" ", "\\s+"), "u"));
    assert.match(focus[1][1] ?? "", /bundle identifier is "com\.openai\.codex"/u);
    assert.match(focus[1][1] ?? "", /set targetPosition to position of targetWindow/u);
    assert.doesNotMatch(focus[1][1] ?? "", /item 1 of position of/u);
    assert.deepEqual(calls[2], [
      "/usr/bin/open",
      ["-b", "com.openai.codex", "codex://threads/00000000-0000-4000-8000-000000000001"],
      { shell: false, stdio: "ignore" },
    ]);
  }
});

test("navigation skips physical window selection when ChatGPT has only one standard window", async () => {
  const calls: unknown[][] = [];
  const spawn: SpawnProcess = (command, args, options) => {
    calls.push([command, args, options]);
    const child = new FakeChild();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  assert.ok(taskId);
  const port = new ChatGptNavigationPort({ spawn });
  port.setWindowTarget("leftmost");

  assert.equal(await port.openTask(taskId), true);

  const script = (calls[1]?.[1] as readonly string[] | undefined)?.[1] ?? "";
  const singleWindowFastPath = script.indexOf("if (count of candidateWindows) is 1 then return");
  const physicalSelection = script.indexOf("set targetWindow to item 1 of candidateWindows");
  assert.notEqual(singleWindowFastPath, -1);
  assert.ok(singleWindowFastPath < physicalSelection);
});

test("composer activation reuses the same last-active, leftmost and rightmost window target", async () => {
  for (const target of ["last-active", "leftmost", "rightmost"] as const) {
    const calls: unknown[][] = [];
    const spawn: SpawnProcess = (command, args, options) => {
      calls.push([command, args, options]);
      const child = new FakeChild();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    };
    const port = new ChatGptNavigationPort({ spawn });
    port.setWindowTarget(target);

    assert.equal(port.windowTarget, target);
    assert.equal(await port.activateTargetWindow(), true);
    assert.equal(calls.length, 1);
    if (target === "last-active") {
      assert.deepEqual(calls[0], [
        "/usr/bin/open",
        ["-b", "com.openai.codex"],
        { shell: false, stdio: "ignore" },
      ]);
    } else {
      assert.equal(calls[0]?.[0], "/usr/bin/osascript");
      const script = (calls[0]?.[1] as readonly string[] | undefined)?.[1] ?? "";
      assert.match(script, new RegExp(target === "leftmost"
        ? "candidateX < targetX"
        : "candidateX > targetX", "u"));
    }
  }
});

test("navigation falls back to ChatGPT's last active window when physical window focusing fails", async () => {
  const calls: unknown[][] = [];
  const spawn: SpawnProcess = (command, args, options) => {
    calls.push([command, args, options]);
    const child = new FakeChild();
    queueMicrotask(() => child.emit("exit", command === "/usr/bin/osascript" ? 1 : 0, null));
    return child;
  };
  const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  assert.ok(taskId);
  const port = new ChatGptNavigationPort({ spawn });
  port.setWindowTarget("leftmost");

  assert.equal(await port.openTask(taskId), true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.[0], "/usr/bin/open");
  assert.equal(calls[1]?.[0], "/usr/bin/osascript");
  assert.equal(calls[2]?.[0], "/usr/bin/open");
});

test("navigation rejects spawn errors, non-zero exits and timeouts without retrying", async () => {
  let spawns = 0;
  let navigationAttempts = 0;
  const children: FakeChild[] = [];
  const spawn: SpawnProcess = (_command, args) => {
    spawns += 1;
    const child = new FakeChild();
    children.push(child);
    if (args.length === 2) {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }
    navigationAttempts += 1;
    if (navigationAttempts === 1) queueMicrotask(() => child.emit("error", new Error("fixture")));
    if (navigationAttempts === 2) queueMicrotask(() => child.emit("exit", 1, null));
    return child;
  };
  const taskId = parseTaskId("00000000-0000-4000-8000-000000000001");
  assert.ok(taskId);
  const timers: (() => void)[] = [];
  const port = new ChatGptNavigationPort({
    spawn,
    setTimer(callback) { timers.push(callback); return timers.length; },
    clearTimer() {},
  });

  assert.equal(await port.openTask(taskId), false);
  assert.equal(await port.openTask(taskId), false);
  const timedOut = port.openTask(taskId);
  timers.at(-1)?.();
  assert.equal(await timedOut, false);
  assert.equal(children.at(-1)?.killed, true);
  assert.equal(navigationAttempts, 3);
  assert.equal(spawns, 6);
});
