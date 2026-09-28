import assert from "node:assert/strict";
import { test } from "node:test";
import { footerView, shortTitle } from "../lib/footer.ts";

const threads = [
  { threadId: "thr_home000001", title: "Home page Craft redesign", cpu: 41.6 },
  { threadId: "thr_tests00001", title: null, cpu: 12.2 },
  { threadId: "thr_build00001", title: "Build", cpu: 3 },
  { threadId: "thr_quiet00001", title: "Quiet", cpu: 1 },
];

test("calm: dot and CPU only", () => {
  const view = footerView({ latest: { thermal: 0, cpu: 13.4, load: 0.42, threads }, hot: false, cpuThreshold: 80 });
  assert.equal(view.tone, "calm");
  assert.equal(view.text, "13%");
  assert.deepEqual([view.level, view.cpu, view.title], [null, "13%", null]);
  assert.equal(
    view.tooltip,
    "Hotspot: Thermal nominal · CPU 13% · load 0.42/core\n" +
      "Top threads: Home page Craft redesign 42%, thr_tests00001 12%, Build 3%",
  );
});

test("hot: level, CPU and the top thread's short title", () => {
  const view = footerView({ latest: { thermal: 2, cpu: 83.2, load: 1.2, threads }, hot: true, cpuThreshold: 80 });
  assert.equal(view.tone, "hot");
  assert.equal(view.text, "Heavy · 83% · Home page Craft red…");
  assert.deepEqual([view.level, view.cpu, view.title], ["Heavy", "83%", "Home page Craft red…"]);
  assert.match(view.tooltip, /^Hotspot \(hot episode\): Thermal heavy · CPU 83% · load 1.20\/core\n/);
});

test("moderate thermal is amber and names the top thread", () => {
  const view = footerView({ latest: { thermal: 1, cpu: 30, load: 0.5, threads }, hot: false, cpuThreshold: 80 });
  assert.equal(view.tone, "warm");
  assert.equal(view.text, "Moderate · 30% · Home page Craft red…");
});

test("CPU over the threshold names the top thread without a level word", () => {
  const view = footerView({ latest: { thermal: 0, cpu: 91, load: 2, threads }, hot: false, cpuThreshold: 80 });
  assert.equal(view.tone, "calm");
  assert.equal(view.text, "91% · Home page Craft red…");
});

test("unknown thermal colours by the CPU rule", () => {
  const over = footerView({ latest: { thermal: null, cpu: 90, load: 1, threads: [] }, hot: false, cpuThreshold: 80 });
  assert.equal(over.tone, "hot");
  assert.equal(over.text, "90%");
  assert.match(over.tooltip, /Thermal unknown/);
  assert.match(over.tooltip, /No BB thread is using CPU/);
  const under = footerView({ latest: { thermal: null, cpu: 20, load: 1, threads: [] }, hot: false, cpuThreshold: 80 });
  assert.equal(under.tone, "calm");
});

test("no sample yet", () => {
  const view = footerView({ latest: null, hot: false, cpuThreshold: 80 });
  assert.deepEqual(view, {
    tone: "idle",
    text: "—",
    level: null,
    cpu: "—",
    title: null,
    tooltip: "Hotspot: waiting for the first sample",
  });
});

test("shortTitle collapses whitespace and cuts at 20 characters", () => {
  assert.equal(shortTitle("  Fix   the  build "), "Fix the build");
  assert.equal(shortTitle("12345678901234567890"), "12345678901234567890");
  assert.equal(shortTitle("123456789012345678901"), "1234567890123456789…");
});
