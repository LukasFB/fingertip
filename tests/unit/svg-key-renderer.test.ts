import assert from "node:assert/strict";
import test from "node:test";

import { renderKeySvg, wrapKeyText } from "../../src/rendering/svg-key-renderer.ts";

test("a project Task renders the approved working key without leaking raw XML", () => {
  const svg = renderKeySvg({
    kind: "task",
    taskPosition: 1,
    titleFontSize: 10,
    projectFontSize: 8,
    title: "Build <Fingertip> & verify",
    projectLabel: "ChatGPT / Stream Deck",
    status: "working",
    activityLabel: "17 minutes ago",
    offlineWarning: false,
  });

  assert.match(svg, /^<svg[^>]+viewBox="0 0 144 144"/);
  assert.match(svg, /#9cd5fe/);
  assert.match(svg, />ChatGPT \/…<\/text>/);
  assert.match(svg, /Build &lt;Fingertip&gt; &amp; verify/);
  assert.match(svg, />17 minutes ago<\/text>/);
  assert.equal(svg.includes(">•••</text>"), false);
  assert.equal(svg.includes(">1</text>"), false);
  assert.equal(svg.includes("<Fingertip>"), false);
});

test("Task Change Stats use the footer without exposing a diff body", () => {
  const svg = renderKeySvg({
    kind: "task",
    taskPosition: 1,
    titleFontSize: 10,
    projectFontSize: 8,
    title: "Changed",
    status: "working",
    activityLabel: "17 minutes ago",
    taskChangeStats: { added: 12, deleted: 3, files: 2 },
    offlineWarning: false,
  });

  assert.match(svg, /fill="#9bf396">\+12<\/tspan>/u);
  assert.match(svg, /fill="#ff7373">&#160;-3<\/tspan>/u);
  assert.match(svg, /<rect data-footer="task-changes" x="4" y="116" width="136" height="24" fill="#2c3c47"\/>/u);
  assert.equal(svg.includes("17 minutes ago"), false);
});

test("Task Change footer background stays hidden when the offline warning takes precedence", () => {
  const svg = renderKeySvg({
    kind: "task",
    taskPosition: 1,
    titleFontSize: 10,
    projectFontSize: 8,
    title: "Changed",
    status: "done",
    taskChangeStats: { added: 12, deleted: 3, files: 2 },
    offlineWarning: true,
  });

  assert.equal(svg.includes('data-footer="task-changes"'), false);
  assert.equal(svg.includes(">OFFLINE</text>"), true);
});

test("Queue and Goal badges share the compact dark-blue top-right treatment", () => {
  const svg = renderKeySvg({
    kind: "task",
    taskPosition: 1,
    titleFontSize: 10,
    projectFontSize: 8,
    title: "Queued",
    status: "working",
    queuedMessageCount: 5,
    hasOngoingGoal: true,
    offlineWarning: false,
  });

  assert.equal(svg.includes('data-badge="queue"'), true);
  assert.equal(svg.includes('data-badge="goal"'), true);
  assert.equal(svg.includes('fill="#0b3155"'), true);
  assert.equal(svg.includes('fill="#ffffff">+5</text>'), true);
  assert.equal((svg.match(/data-badge=/gu) ?? []).length, 2);
});

test("Queue badge font size is configurable within its compact badge", () => {
  const svg = renderKeySvg({
    kind: "task",
    taskPosition: 1,
    titleFontSize: 10,
    projectFontSize: 8,
    title: "Queued",
    status: "working",
    queuedMessageCount: 12,
    badgeFontSize: 18,
    offlineWarning: false,
  });

  assert.equal(svg.includes('font-size="18"'), true);
  assert.equal(svg.includes('data-badge="queue"'), true);
});

test("Badge position supports all four corners", () => {
  const positions = [
    ["top-left", 'x="8" y="9"'],
    ["top-right", 'x="103" y="9"'],
    ["bottom-left", 'x="8" y="113"'],
    ["bottom-right", 'x="103" y="113"'],
  ] as const;
  for (const [badgePosition, coordinates] of positions) {
    const svg = renderKeySvg({
      kind: "task",
      taskPosition: 1,
      titleFontSize: 10,
      projectFontSize: 8,
      title: "Positioned",
      status: "idle",
      queuedMessageCount: 5,
      badgePosition,
      offlineWarning: false,
    });
    assert.equal(svg.includes(`data-badges-position="${badgePosition}"`), true);
    assert.equal(svg.includes(coordinates), true);
  }
});

test("Bottom replaces Git only while at least one badge exists", () => {
  const common = {
    kind: "task" as const,
    taskPosition: 1,
    titleFontSize: 10,
    projectFontSize: 8,
    title: "Footer",
    status: "working" as const,
    activityLabel: "17 minutes ago",
    taskChangeStats: { added: 12, deleted: 3, files: 2 },
    badgePosition: "bottom-replaces-git" as const,
    offlineWarning: false,
  };
  const withoutBadge = renderKeySvg(common);
  const withBadge = renderKeySvg({ ...common, hasOngoingGoal: true });

  assert.equal(withoutBadge.includes('data-footer="task-changes"'), true);
  assert.equal(withBadge.includes('data-footer="task-changes"'), false);
  assert.equal(withBadge.includes("+12"), false);
  assert.equal(withBadge.includes("17 minutes ago"), false);
  assert.equal(withBadge.includes('data-badges-position="bottom-replaces-git"'), true);
});

test("all five Task states use the configurable Codex Micro defaults without state markers or indexes", () => {
  const states = [
    ["idle", "#06090b"],
    ["working", "#9cd5fe"],
    ["done", "#9bf396"],
    ["waiting", "#ffd0b8"],
    ["confirmation", "#ffad28"],
  ] as const;
  for (const [status, color] of states) {
    const svg = renderKeySvg({
      kind: "task",
      taskPosition: 99,
      titleFontSize: 12,
      projectFontSize: 8,
      title: "A very long singlewordwithoutabreakthatmuststillfit on the final line",
      status,
      activityLabel: "4 days ago",
      offlineWarning: false,
    });
    assert.equal(svg.includes(color), true);
    assert.equal(svg.includes(">4 days ago</text>"), true);
    assert.equal(svg.includes(">99</text>"), false);
    assert.equal(svg.includes("<tspan"), false);
    assert.equal(svg.includes("textLength=\"124\""), false);
  }
});

test("long words, CamelCase and ordinary spaces wrap without squeezing or losing separators", () => {
  assert.deepEqual(wrapKeyText("Alpha Beta Gamma", 5, 4), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(wrapKeyText("AlphaBeta", 3, 4), ["Alpha", "Beta"]);
  assert.deepEqual(wrapKeyText("abcdefghij", 3, 4), ["abcde", "fghij"]);
  assert.deepEqual(wrapKeyText("abcdefghijklmno", 3, 2), ["abcde", "fghi…"]);

  const svg = renderKeySvg({
    kind: "task",
    taskPosition: 2,
    titleFontSize: 10,
    projectFontSize: 8,
    title: "Name Streamdeck Integration",
    status: "idle",
    offlineWarning: false,
  });
  assert.equal(svg.includes('xml:space="preserve"'), true);
  assert.equal(svg.includes('textLength="124"'), false);
  assert.equal(svg.includes("Name Streamdeck Integration"), true);
  for (const line of wrapKeyText("Name Streamdeck Integration", 6.2, 4)) {
    assert.equal(svg.includes(`>${line}</text>`), true);
  }
});

test("per-key colors override all five Task state defaults and select readable text contrast", () => {
  const colors = {
    idle: "#112233",
    working: "#224466",
    done: "#336699",
    waiting: "#ffeeaa",
    confirmation: "#880022",
  } as const;
  for (const status of ["idle", "working", "done", "waiting", "confirmation"] as const) {
    const svg = renderKeySvg({
      kind: "task",
      taskPosition: 1,
      titleFontSize: 10,
      projectFontSize: 8,
      title: "Contrast",
      status,
      colors,
      offlineWarning: false,
    });
    assert.equal(svg.includes(colors[status]), true);
  }
  assert.equal(renderKeySvg({
    kind: "task", taskPosition: 1, titleFontSize: 10, projectFontSize: 8, title: "Dark", status: "idle", colors, offlineWarning: false,
  }).includes('fill="#f7f9fc"'), true);
});

test("loading, empty, unavailable and Offline Warning remain visually distinct", () => {
  const loading = renderKeySvg({ kind: "loading", taskPosition: 1, titleFontSize: 10, projectFontSize: 8, offlineWarning: false });
  const empty = renderKeySvg({ kind: "empty", taskPosition: 2, titleFontSize: 10, projectFontSize: 8, offlineWarning: false });
  const unavailable = renderKeySvg({ kind: "unavailable", taskPosition: 3, titleFontSize: 10, projectFontSize: 8, offlineWarning: true });
  const staleTask = renderKeySvg({
    kind: "task",
    taskPosition: 4,
    titleFontSize: 8,
    projectFontSize: 8,
    title: "Still navigable",
    status: "done",
    activityLabel: "2:30 hours ago",
    offlineWarning: true,
  });

  assert.equal(loading.includes("Loading…"), true);
  assert.equal(loading.includes(">…</text>"), false);
  assert.equal(empty.includes("No Task"), true);
  assert.equal(empty.includes("#17191e"), true);
  assert.equal(unavailable.includes("Offline"), true);
  assert.equal(unavailable.includes("#ffd166"), true);
  assert.equal(staleTask.includes("#9bf396"), true);
  assert.equal(staleTask.includes("OFFLINE"), true);
  assert.equal(staleTask.includes("2:30 hours ago"), false);
  assert.equal(staleTask.includes('stroke-width="2"'), true);
});

test("project font size is independent from Task title size", () => {
  const svg = renderKeySvg({
    kind: "task",
    taskPosition: 1,
    titleFontSize: 12,
    projectFontSize: 6,
    projectLabel: "Tiny Project",
    title: "Large title",
    status: "idle",
    activityLabel: "just now",
    offlineWarning: false,
  });
  assert.match(svg, /font-size="12"[^>]*>Tiny Project<\/text>/);
  assert.match(svg, /font-size="24"[^>]*>Large<\/text>/);
});

test("time size and alignment apply consistently to project, title, and activity text", () => {
  const svg = renderKeySvg({
    kind: "task",
    taskPosition: 1,
    titleFontSize: 10,
    projectFontSize: 8,
    timeFontSize: 9,
    textAlignment: "center",
    borderEnabled: true,
    projectLabel: "Project",
    title: "Title",
    status: "working",
    activityLabel: "4 days ago",
    offlineWarning: false,
  });

  assert.match(svg, /x="72"[^>]*text-anchor="middle"[^>]*font-size="16"[^>]*>Project<\/text>/);
  assert.match(svg, /x="72"[^>]*text-anchor="middle"[^>]*font-size="20"[^>]*>Title<\/text>/);
  assert.match(svg, /x="72"[^>]*text-anchor="middle"[^>]*font-size="18"[^>]*>4 days ago<\/text>/);
});

test("project bar and optional border share a distinctly darker shade of the state background", () => {
  const withBorder = renderKeySvg({
    kind: "task",
    taskPosition: 1,
    titleFontSize: 10,
    projectFontSize: 8,
    projectLabel: "Fingertip",
    title: "Shade",
    status: "working",
    borderEnabled: true,
    offlineWarning: false,
  });
  const projectBar = withBorder.match(/height="32" fill="(#[0-9a-f]{6})"/u)?.[1];
  assert.ok(projectBar);
  assert.equal(projectBar, "#7099b7");
  assert.equal(withBorder.includes(`stroke="${projectBar}"`), true);

  const withoutBorder = renderKeySvg({
    kind: "task",
    taskPosition: 1,
    titleFontSize: 10,
    projectFontSize: 8,
    projectLabel: "Fingertip",
    title: "No border",
    status: "working",
    borderEnabled: false,
    offlineWarning: false,
  });
  assert.equal(withoutBorder.includes("stroke-width=\"2\""), false);
});
