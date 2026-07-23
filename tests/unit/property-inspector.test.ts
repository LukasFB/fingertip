import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("Property Inspector is fully local and exposes only the approved controls and notice", async () => {
  const html = await readFile("com.lukas-bhm.fingertip.sdPlugin/ui/task-key.html", "utf8");
  const bridge = await readFile("com.lukas-bhm.fingertip.sdPlugin/ui/sdpi-components.js", "utf8");

  assert.equal(html.includes('src="sdpi-components.js"'), true);
  assert.equal(html.includes('id="task-source"'), true);
  assert.equal(html.includes('value="pinned-projects"'), true);
  assert.equal(html.includes('value="tasks"'), true);
  assert.equal(html.includes('id="window-target"'), true);
  for (const target of ["last-active", "leftmost", "rightmost"]) {
    assert.equal(html.includes(`value="${target}"`), true);
  }
  assert.equal(html.includes("https://"), false);
  assert.match(html, /id="task-position" type="number" min="1" max="99" step="1"/u);
  assert.match(html, /id="title-size" type="range" min="8" max="12" step="1"/u);
  assert.match(html, /id="project-size" type="range" min="6" max="12" step="1"/u);
  assert.match(html, /id="time-size" type="range" min="5" max="10" step="1"/u);
  assert.equal(html.includes("Time / Lines Mod. Size"), true);
  assert.equal(html.includes('id="border-enabled" type="checkbox"'), true);
  assert.equal(html.includes('id="git-diff-stats" type="checkbox"'), true);
  assert.equal(html.includes('id="queue-badge" type="checkbox"'), true);
  assert.equal(html.includes('id="goal-badge" type="checkbox"'), true);
  assert.equal(html.includes('id="badge-position"'), true);
  for (const position of ["top-right", "top-left", "bottom-left", "bottom-right", "bottom-replaces-git"]) {
    assert.equal(html.includes(`value="${position}"`), true);
  }
  assert.equal(html.includes("Task Changes"), true);
  assert.equal(html.includes("Show Lines Modified by Task"), true);
  for (const alignment of ["left", "center", "right"]) {
    assert.equal(html.includes(`data-alignment="${alignment}"`), true);
  }
  assert.equal(html.includes('id="reset-appearance"'), true);
  assert.match(html, /position\.addEventListener\("input"/u);
  assert.match(html, /Number\.isInteger\(taskPosition\)/u);
  assert.match(html, /taskPosition < 1/u);
  assert.match(html, /taskPosition > 99/u);
  for (const id of ["idle-color", "working-color", "done-color", "waiting-color", "confirmation-color"]) {
    assert.equal(html.includes(`id="${id}" type="color"`), true);
  }
  assert.equal(html.includes('value="#06090b"'), true);
  assert.equal(html.includes("1 is the first Task within the selected sidebar section."), true);
  assert.equal(html.includes("Dynamic Task status requires this key's custom image to be reset to Default."), true);
  assert.equal(html.includes("Reconnect ChatGPT"), true);
  assert.equal(html.includes("once per minute"), true);
  assert.equal(html.includes("Applies to every Codex Task key."), true);
  assert.equal(bridge.includes("ws://127.0.0.1"), true);
  assert.equal(bridge.includes("fetch("), false);
  assert.equal(bridge.includes("XMLHttpRequest"), false);
  assert.equal(bridge.includes("localStorage"), false);
  assert.equal(bridge.includes("sessionStorage"), false);
});

test("manifest exposes only the Codex Task action", async () => {
  const manifest = JSON.parse(await readFile(
    "com.lukas-bhm.fingertip.sdPlugin/manifest.json",
    "utf8",
  )) as {
    Profiles?: unknown;
    Actions: Array<{
      UUID: string;
      Name: string;
    }>;
  };
  assert.equal(manifest.Profiles, undefined);
  assert.deepEqual(manifest.Actions.map(({ UUID, Name }) => ({ UUID, Name })), [{
    UUID: "com.lukas-bhm.fingertip.task",
    Name: "Codex Task",
  }]);
});

test("Property Inspector keeps Task Position local and persists appearance globally", async () => {
  const bridge = await readFile("com.lukas-bhm.fingertip.sdPlugin/ui/sdpi-components.js", "utf8");
  const sent: Record<string, unknown>[] = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    static instance: FakeWebSocket | undefined;
    readonly listeners = new Map<string, (event: { data: string }) => void>();
    readonly readyState = FakeWebSocket.OPEN;

    constructor(_url: string) {
      FakeWebSocket.instance = this;
    }

    addEventListener(type: string, listener: (event: { data: string }) => void): void {
      this.listeners.set(type, listener);
    }

    send(message: string): void {
      sent.push(JSON.parse(message) as Record<string, unknown>);
    }
  }

  const window: Record<string, unknown> = {};
  vm.runInNewContext(bridge, { window, WebSocket: FakeWebSocket });
  const connect = window.connectElgatoStreamDeckSocket as (
    port: number,
    uuid: string,
    registerEvent: string,
    info: string,
    actionInfo: string,
  ) => void;
  connect(1234, "pi-context", "registerPropertyInspector", "{}", JSON.stringify({
    action: "com.lukas-bhm.fingertip.task",
    payload: {
      settings: {
        version: 4,
        taskPosition: 4,
        taskSource: "tasks",
      },
    },
  }));
  FakeWebSocket.instance?.listeners.get("open")?.({ data: "" });

  const api = window.FingertipPI as { setSetting(key: string, value: unknown): void };
  assert.equal(sent.some((message) => message.event === "getGlobalSettings"), true);

  FakeWebSocket.instance?.listeners.get("message")?.({ data: JSON.stringify({
    event: "didReceiveGlobalSettings",
    payload: {
      settings: {
        version: 1,
        titleFontSize: 11,
        projectFontSize: 9,
        timeFontSize: 7,
        textAlignment: "center",
        borderEnabled: false,
        idleColor: "#343842",
        workingColor: "#9cd5fe",
        doneColor: "#9bf396",
        waitingColor: "#ffd0b8",
        confirmationColor: "#ff7373",
      },
    },
  }) });
  api.setSetting("idleColor", "#112233");

  const message = sent.at(-1) as { event?: string; payload?: Record<string, unknown> } | undefined;
  assert.equal(message?.event, "setGlobalSettings");
  assert.deepEqual(message?.payload, {
    version: 8,
    windowTarget: "last-active",
    titleFontSize: 11,
    projectFontSize: 9,
    timeFontSize: 7,
    textAlignment: "center",
    borderEnabled: false,
    showGitDiffStats: false,
    showQueueBadge: false,
    showGoalBadge: false,
    badgePosition: "top-right",
    badgeFontSize: 15,
    idleColor: "#112233",
    workingColor: "#9cd5fe",
    doneColor: "#9bf396",
    waitingColor: "#ffd0b8",
    confirmationColor: "#ffad28",
  });

  api.setSetting("taskPosition", 7);
  const local = sent.at(-1) as { event?: string; payload?: Record<string, unknown> } | undefined;
  assert.equal(local?.event, "setSettings");
  assert.deepEqual(local?.payload, {
    version: 7,
    taskPosition: 7,
    taskSource: "tasks",
  });

  api.setSetting("taskSource", "pinned-projects");
  const source = sent.at(-1) as { event?: string; payload?: Record<string, unknown> } | undefined;
  assert.equal(source?.event, "setSettings");
  assert.deepEqual(source?.payload, {
    version: 7,
    taskPosition: 7,
    taskSource: "pinned-projects",
  });

  api.setSetting("showQueueBadge", true);
  const queueBadge = sent.at(-1) as { event?: string; payload?: Record<string, unknown> } | undefined;
  assert.equal(queueBadge?.event, "setGlobalSettings");
  assert.equal(queueBadge?.payload?.showQueueBadge, true);

  api.setSetting("badgePosition", "bottom-replaces-git");
  const badgePosition = sent.at(-1) as { event?: string; payload?: Record<string, unknown> } | undefined;
  assert.equal(badgePosition?.event, "setGlobalSettings");
  assert.equal(badgePosition?.payload?.badgePosition, "bottom-replaces-git");

  api.setSetting("badgeFontSize", 18);
  const badgeSize = sent.at(-1) as { event?: string; payload?: Record<string, unknown> } | undefined;
  assert.equal(badgeSize?.event, "setGlobalSettings");
  assert.equal(badgeSize?.payload?.badgeFontSize, 18);

  api.setSetting("windowTarget", "rightmost");
  const target = sent.at(-1) as { event?: string; payload?: Record<string, unknown> } | undefined;
  assert.equal(target?.event, "setGlobalSettings");
  assert.equal(target?.payload?.windowTarget, "rightmost");

  const resetApi = window.FingertipPI as { resetAppearance(): void };
  resetApi.resetAppearance();
  const reset = sent.at(-1) as { event?: string; payload?: Record<string, unknown> } | undefined;
  assert.equal(reset?.event, "setGlobalSettings");
  assert.deepEqual(reset?.payload, {
    version: 8,
    windowTarget: "rightmost",
    titleFontSize: 10,
    projectFontSize: 8,
    timeFontSize: 6,
    textAlignment: "left",
    borderEnabled: true,
    showGitDiffStats: false,
    showQueueBadge: false,
    showGoalBadge: false,
    badgePosition: "top-right",
    badgeFontSize: 15,
    idleColor: "#06090b",
    workingColor: "#9cd5fe",
    doneColor: "#9bf396",
    waitingColor: "#ffd0b8",
    confirmationColor: "#ffad28",
  });
});
