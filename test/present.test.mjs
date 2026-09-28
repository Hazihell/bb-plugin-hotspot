import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clockText,
  cpuText,
  dayClockText,
  durationText,
  episodeNear,
  gapLabel,
  labelWidth,
  processSummary,
  threadMeta,
  timeTicks,
  verdict,
} from "../lib/present.ts";

const L = "en-US";
const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const threads = [
  { threadId: "thr_home000001", title: "Home page", cpu: 41.6 },
  { threadId: "thr_quiet00001", title: "Quiet", cpu: 1 },
];
const sample = (over) => ({ thermal: 0, cpu: 12, load: 0.4, threads, ...over });

test("verdict: no sample yet", () => {
  const view = verdict({ latest: null, hot: false, cpuThreshold: 80, openSince: null });
  assert.equal(view.tone, "idle");
  assert.equal(view.headline, "Waiting for the first reading");
});

test("verdict: calm and nothing busy reassures", () => {
  const view = verdict({ latest: sample({ threads: [threads[1]] }), hot: false, cpuThreshold: 80, openSince: null });
  assert.deepEqual([view.tone, view.headline, view.culprit, view.reassurance], [
    "calm",
    "Running cool",
    null,
    "Nothing in BB is working hard.",
  ]);
  assert.equal(view.detail, "12% CPU · thermal pressure nominal");
});

test("verdict: calm but a thread is busy names it", () => {
  const view = verdict({ latest: sample(), hot: false, cpuThreshold: 80, openSince: null });
  assert.equal(view.culprit?.threadId, "thr_home000001");
  assert.equal(view.reassurance, null);
});

test("verdict: an open episode is hot and carries its start", () => {
  const view = verdict({ latest: sample({ thermal: 2, cpu: 83 }), hot: true, cpuThreshold: 80, openSince: 123 });
  assert.deepEqual([view.tone, view.headline, view.since], ["hot", "Running hot", 123]);
});

test("verdict: moderate warms, CPU over the line works hard, unknown thermal over the line is hot", () => {
  assert.equal(verdict({ latest: sample({ thermal: 1 }), hot: false, cpuThreshold: 80, openSince: null }).headline, "Warming up");
  const busy = verdict({ latest: sample({ cpu: 90 }), hot: false, cpuThreshold: 80, openSince: null });
  assert.deepEqual([busy.headline, busy.tone], ["Working hard", "calm"]);
  const linux = verdict({ latest: sample({ thermal: null, cpu: 90, threads: [] }), hot: false, cpuThreshold: 80, openSince: 5 });
  assert.deepEqual([linux.headline, linux.detail, linux.since, linux.reassurance], [
    "Running hot",
    "90% CPU",
    null,
    "No BB thread is the main cause.",
  ]);
});

test("clock and day-relative times", () => {
  const now = at(28, 16);
  assert.equal(clockText(at(28, 14, 13), L), "2:13 PM");
  assert.equal(dayClockText(at(28, 14, 13), now, L), "2:13 PM");
  assert.equal(dayClockText(at(27, 23, 5), now, L), "Yesterday 11:05 PM");
  assert.equal(dayClockText(at(24, 9), now, L), "Thu 9:00 AM");
  assert.equal(dayClockText(at(10, 9), now, L), "Sep 10, 9:00 AM");
});

test("durations", () => {
  assert.equal(durationText(10_000), "1 min");
  assert.equal(durationText(2 * 60_000), "2 min");
  assert.equal(durationText(60 * 60_000), "1 h");
  assert.equal(durationText(65 * 60_000), "1 h 5 min");
});

test("thread CPU and meta line", () => {
  assert.equal(cpuText(0.2), "<1%");
  assert.equal(cpuText(41.6), "42%");
  assert.equal(threadMeta(7, true), "7 processes · running a turn");
  assert.equal(threadMeta(1, false), "1 process · no turn running");
  assert.equal(threadMeta(2, null), "2 processes");
});

test("day ticks land on whole hours and thin out when narrow", () => {
  const from = at(27, 15, 51);
  const to = at(28, 15, 51);
  const wide = timeTicks(from, to, 8, L);
  assert.deepEqual(wide.map((tick) => tick.label), ["6 PM", "9 PM", "12 AM", "3 AM", "6 AM", "9 AM", "12 PM", "3 PM"]);
  assert.ok(wide.every((tick) => tick.at >= from && tick.at <= to));
  const narrow = timeTicks(from, to, 4, L);
  assert.deepEqual(narrow.map((tick) => tick.label), ["6 PM", "12 AM", "6 AM", "12 PM"]);
});

test("week ticks land on local midnights as weekdays", () => {
  const ticks = timeTicks(at(21, 15, 51), at(28, 15, 51), 8, L);
  assert.deepEqual(ticks.map((tick) => tick.label), ["Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Mon"]);
  assert.equal(new Date(ticks[0].at).getHours(), 0);
  assert.deepEqual(timeTicks(at(21, 15, 51), at(28, 15, 51), 4, L).map((tick) => tick.label), ["Tue", "Thu", "Sat", "Mon"]);
});

test("process summary groups names, most common first", () => {
  const names = ["esbuild", "node", "node", "esbuild", "node", "next-server", "cli start", "node", "zsh", "sh"];
  assert.equal(processSummary(names), "node ×4 · esbuild ×2 · next-server · cli start · 2 more");
  assert.equal(processSummary(["node"]), "node");
  assert.equal(processSummary([]), "");
});

test("episodeNear hits a band, the nearest within tolerance, or nothing", () => {
  const episodes = [
    { id: 1, startAt: 1_000, endAt: 2_000, lastHotAt: 2_000 },
    { id: 2, startAt: 5_000, endAt: null, lastHotAt: 5_500 },
  ];
  assert.equal(episodeNear(episodes, 1_500, 0, 9_000)?.id, 1);
  assert.equal(episodeNear(episodes, 2_300, 500, 9_000)?.id, 1);
  assert.equal(episodeNear(episodes, 4_800, 500, 9_000)?.id, 2);
  assert.equal(episodeNear(episodes, 8_000, 0, 9_000)?.id, 2);
  assert.equal(episodeNear(episodes, 3_500, 500, 9_000), null);
});

test("gap label sits centred in the stretch before the first reading, or not at all", () => {
  const first = at(28, 13, 31);
  const text = "No readings before 1:31 PM";
  assert.deepEqual(gapLabel(36, 382, 300, first, L), { text, x: 168 });
  // Too narrow for the text plus 8px each side: left out rather than spilling over the data.
  const tight = 36 + labelWidth(text) + 16;
  assert.equal(gapLabel(36, 382, tight - 1, first, L), null);
  assert.equal(gapLabel(36, 382, tight, first, L)?.x, (36 + tight) / 2);
  // No reading at all: the whole plot is the stretch.
  assert.deepEqual(gapLabel(36, 382, null, null, L), { text: "No readings yet", x: 209 });
});
