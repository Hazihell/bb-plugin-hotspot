import assert from "node:assert/strict";
import { test } from "node:test";
import { STACK_GAP, fitFooter, footerLines, footerView, footerWidth, shortTitle } from "../lib/footer.ts";

const GB = 1024 ** 3;
const threads = [
  { threadId: "thr_home000001", title: "Home page Craft redesign", cpu: 41.6, memBytes: 1.24 * GB },
  { threadId: "thr_tests00001", title: null, cpu: 12.2, memBytes: null },
  { threadId: "thr_build00001", title: "Build", cpu: 3, memBytes: 300 * 1024 ** 2 },
  { threadId: "thr_quiet00001", title: "Quiet", cpu: 1 },
];
const memory = (percent, pressure = "normal") => ({ percent, swapUsedBytes: 5.7 * GB, pressure });
const latest = (overrides) => ({ thermal: 0, cpu: 13.4, load: 0.42, memory: memory(62.4), threads, ...overrides });

/** About 7px a character in the footer's 12px, 6px in the stacked 11px: close to system sans for these strings. */
const measure = (text, size) => text.length * (size === "stack" ? 6 : 7);
const shape = (line) => `${line.layout}: ${line.text}`;

test("calm: labelled CPU and memory, no heat word, no title", () => {
  const view = footerView({ latest: latest({}), hot: false, cpuThreshold: 80 });
  assert.equal(view.tone, "calm");
  assert.equal(view.heat, null);
  assert.deepEqual(footerLines(view).map(shape), ["row: CPU 13% · MEM 62%", "stack: CPU 13% · MEM 62%", "stack: CPU 13%"]);
  assert.equal(
    view.tooltip,
    "Hotspot: Thermal nominal · CPU 13% · Memory 62% (swap 5.7 GB, pressure normal) · load 0.42/core\n" +
      "Top threads: Home page Craft redesign 42% CPU · 1.2 GB, thr_tests00001 12% CPU, Build 3% CPU · 300 MB",
  );
});

test("hot: the heat word, both metrics and the top thread's short title", () => {
  const view = footerView({ latest: latest({ thermal: 2, cpu: 83.2, load: 1.2 }), hot: true, cpuThreshold: 80 });
  assert.equal(view.tone, "hot");
  assert.equal(view.heat, "Hot");
  assert.equal(view.cpu.alert, "hot");
  assert.equal(footerLines(view)[0].text, "Hot · CPU 83% · MEM 62% · Home page Craft red…");
  assert.match(view.tooltip, /^Hotspot \(hot episode\): Thermal heavy · CPU 83% · Memory 62%/);
});

test("the footer sheds the title, stacks the metrics, then sheds the heat word, then a metric, never a label", () => {
  const view = footerView({ latest: latest({ thermal: 2, cpu: 83.2 }), hot: true, cpuThreshold: 80 });
  const lines = footerLines(view);
  assert.deepEqual(lines.map(shape), [
    "row: Hot · CPU 83% · MEM 62% · Home page Craft red…",
    "row: Hot · CPU 83% · MEM 62%",
    "stack: Hot · CPU 83% · MEM 62%",
    "stack: CPU 83% · MEM 62%",
    "stack: CPU 83%",
  ]);
  // Every number on every line has its label right before it.
  for (const { text } of lines) assert.doesNotMatch(text.replace(/(CPU|MEM) \d+%/g, ""), /\d+%/);

  // A stack is as wide as its widest metric line, plus the heat word beside it.
  assert.equal(footerWidth(lines[2], measure), 7 * 6 + STACK_GAP + 3 * 7);
  assert.equal(footerWidth(lines[3], measure), 7 * 6);

  const at = (width) => shape(fitFooter(view, width, measure));
  assert.equal(at(400), shape(lines[0]));
  for (let index = 1; index < lines.length; index += 1) {
    assert.equal(at(footerWidth(lines[index - 1], measure) - 1), shape(lines[index]));
  }
  // The desktop sidebar leaves about 80px of text: both numbers and "Hot" still fit.
  assert.equal(at(80), "stack: Hot · CPU 83% · MEM 62%");
  // Narrower than anything: the last line, still labelled.
  assert.equal(at(10), "stack: CPU 83%");
});

test("the one-metric line keeps memory when memory is the problem", () => {
  const view = footerView({ latest: latest({ memory: memory(94, "critical") }), hot: false, cpuThreshold: 80 });
  assert.equal(view.mem?.alert, "hot");
  assert.equal(view.heat, null);
  assert.equal(fitFooter(view, 0, measure).text, "MEM 94%");
  const warn = footerView({ latest: latest({ memory: memory(88, "warn") }), hot: false, cpuThreshold: 80 });
  assert.equal(warn.mem?.alert, "warn");
});

test("moderate thermal says Warm; CPU over the threshold alone says Busy", () => {
  const warm = footerView({ latest: latest({ thermal: 1, cpu: 30 }), hot: false, cpuThreshold: 80 });
  assert.equal(warm.tone, "warm");
  assert.equal(footerLines(warm)[0].text, "Warm · CPU 30% · MEM 62% · Home page Craft red…");
  const busy = footerView({ latest: latest({ cpu: 91 }), hot: false, cpuThreshold: 80 });
  assert.equal(busy.tone, "calm");
  assert.equal(busy.heat, "Busy");
  assert.equal(footerLines(busy)[1].text, "Busy · CPU 91% · MEM 62%");
});

test("unknown thermal colours by the CPU rule; unread memory leaves MEM out", () => {
  const over = footerView({
    latest: { thermal: null, cpu: 90, load: 1, memory: null, threads: [] },
    hot: false,
    cpuThreshold: 80,
  });
  assert.equal(over.tone, "hot");
  assert.equal(over.heat, "Hot");
  assert.deepEqual(footerLines(over).map(shape), ["row: Hot · CPU 90%", "row: CPU 90%"]);
  assert.match(over.tooltip, /Thermal unknown · CPU 90% · Memory not read/);
  assert.match(over.tooltip, /No BB thread is using CPU/);
  const under = footerView({ latest: { thermal: null, cpu: 20, load: 1, threads: [] }, hot: false, cpuThreshold: 80 });
  assert.equal(under.tone, "calm");
});

test("no sample yet: a labelled dash", () => {
  const view = footerView({ latest: null, hot: false, cpuThreshold: 80 });
  assert.equal(view.tone, "idle");
  assert.deepEqual(footerLines(view).map(shape), ["row: CPU —"]);
  assert.equal(view.tooltip, "Hotspot: waiting for the first sample");
});

test("shortTitle collapses whitespace and cuts at 20 characters", () => {
  assert.equal(shortTitle("  Fix   the  build "), "Fix the build");
  assert.equal(shortTitle("12345678901234567890"), "12345678901234567890");
  assert.equal(shortTitle("123456789012345678901"), "1234567890123456789…");
});
