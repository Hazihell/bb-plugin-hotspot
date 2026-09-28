import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOLD_AFTER_MS,
  LINGER_MS,
  RERANK_MS,
  SHOW_AFTER_MS,
  emptyList,
  listRows,
  nextList,
  readsIdle,
} from "../lib/thread-list.ts";

const GB = 1024 ** 3;
const t = (threadId, cpu, memBytes = 100 * 1024 ** 2) => ({ threadId, cpu, memBytes });

/** Feeds readings two seconds apart, as the live readings arrive; returns the final state. */
function feed(readings, { from = emptyList(), start = 0, frozen = () => false } = {}) {
  let state = from;
  readings.forEach((threads, index) => {
    const now = start + index * 2_000;
    state = nextList(state, threads, now, frozen(now));
  });
  return state;
}
const shown = (state) => listRows(state).shown.map((row) => row.thread.threadId);
const folded = (state) => listRows(state).folded.map((row) => row.thread.threadId);
const repeat = (count, threads) => Array.from({ length: count }, () => threads);

test("the idle line is under 1% as shown and under 1 GB", () => {
  assert.equal(readsIdle(t("a", 0.4)), true);
  assert.equal(readsIdle(t("a", 0.5)), false);
  assert.equal(readsIdle(t("a", 0.1, 1.5 * GB)), false);
  assert.equal(readsIdle({ threadId: "a", cpu: 0, memBytes: null }), true);
});

test("the first reading ranks by CPU and folds idle threads at once", () => {
  const state = feed([[t("a", 3), t("b", 40), t("c", 0.2), t("d", 0.1, 2 * GB), t("e", 12)]]);
  assert.deepEqual(shown(state), ["b", "e", "a", "d"]);
  assert.deepEqual(folded(state), ["c"]);
});

test("neighbours within the margin never swap", () => {
  // a and b trade the lead by a few points on every reading.
  const readings = Array.from({ length: 20 }, (_, index) =>
    index % 2 === 0 ? [t("a", 30), t("b", 33)] : [t("b", 28), t("a", 31)],
  );
  let state = emptyList();
  const orders = new Set();
  readings.forEach((threads, index) => {
    state = nextList(state, threads, index * 2_000, false);
    orders.add(shown(state).join());
  });
  assert.deepEqual([...orders], ["b,a"]);
});

test("a lead beyond the margin swaps, at most once per rerank interval", () => {
  let state = feed([[t("a", 50), t("b", 40), t("c", 30)]]);
  // c overtakes b clearly: swapped at the next reading.
  state = nextList(state, [t("c", 60), t("a", 50), t("b", 40)], 2_000, false);
  assert.deepEqual(shown(state), ["c", "a", "b"]);
  // b overtakes everyone two seconds later: held until the interval has passed.
  const b = [t("b", 90), t("c", 60), t("a", 50)];
  state = nextList(state, b, 4_000, false);
  assert.deepEqual(shown(state), ["c", "a", "b"]);
  state = nextList(state, b, 2_000 + RERANK_MS, false);
  assert.deepEqual(shown(state), ["b", "c", "a"]);
});

test("numbers update in place without a reorder", () => {
  let state = feed([[t("a", 50), t("b", 40)]]);
  state = nextList(state, [t("a", 52), t("b", 47)], 2_000, false);
  assert.deepEqual(
    listRows(state).shown.map((row) => [row.thread.threadId, row.thread.cpu, row.present]),
    [["a", 52, true], ["b", 47, true]],
  );
});

test("a thread near the idle line does not flicker in and out of the fold", () => {
  // b and c hover around 0.5% for a minute: b, first seen busy, stays shown; c, first seen idle, stays folded.
  const hovering = Array.from({ length: 30 }, (_, index) => [
    t("a", 20),
    t("b", index === 0 ? 10 : index % 2 === 0 ? 0.3 : 0.8),
    t("c", index % 2 === 0 ? 0.3 : 0.8),
  ]);
  let state = emptyList();
  const views = new Set();
  hovering.forEach((threads, index) => {
    state = nextList(state, threads, index * 2_000, false);
    views.add(JSON.stringify([shown(state), folded(state)]));
  });
  assert.deepEqual([...views], [JSON.stringify([["a", "b"], ["c"]])]);
});

test("a shown thread folds only after reading idle for the fold interval", () => {
  let state = feed([[t("a", 20), t("b", 10)]]);
  const idleReadings = FOLD_AFTER_MS / 2_000;
  state = feed(repeat(idleReadings, [t("a", 20), t("b", 0.1)]), { from: state, start: 2_000 });
  assert.deepEqual(shown(state), ["a", "b"], "still shown just before the interval");
  state = nextList(state, [t("a", 20), t("b", 0.1)], 2_000 + FOLD_AFTER_MS, false);
  assert.deepEqual([shown(state), folded(state)], [["a"], ["b"]]);
});

test("a folded thread comes back at once over 5%, or after reading busy a while", () => {
  let state = feed([[t("a", 20), t("b", 0.1), t("c", 0.2)]]);
  assert.deepEqual(folded(state), ["b", "c"]);
  state = nextList(state, [t("a", 20), t("b", 9), t("c", 0.2)], 2_000, false);
  assert.deepEqual([shown(state), folded(state)], [["a", "b"], ["c"]]);
  // c creeps above the idle line: shown only once it has stayed there.
  state = feed(repeat(SHOW_AFTER_MS / 2_000, [t("a", 20), t("b", 9), t("c", 1)]), { from: state, start: 4_000 });
  assert.deepEqual(folded(state), ["c"]);
  state = nextList(state, [t("a", 20), t("b", 9), t("c", 1)], 4_000 + SHOW_AFTER_MS, false);
  assert.deepEqual([shown(state), folded(state)], [["a", "b", "c"], []]);
  // A single busy reading does not bring it back.
  const blip = feed([[t("a", 20), t("d", 0.1)], [t("a", 20), t("d", 2)], [t("a", 20), t("d", 0.1)]]);
  assert.deepEqual(folded(blip), ["d"]);
});

test("a thread missing from a reading keeps its row, marked, until it has lingered", () => {
  let state = feed([[t("a", 20), t("b", 10), t("c", 5)]]);
  state = nextList(state, [t("a", 20), t("c", 5)], 2_000, false);
  assert.deepEqual(
    listRows(state).shown.map((row) => [row.thread.threadId, row.present]),
    [["a", true], ["b", false], ["c", true]],
  );
  state = feed(repeat(LINGER_MS / 2_000 - 2, [t("a", 20), t("c", 5)]), { from: state, start: 4_000 });
  assert.deepEqual(shown(state), ["a", "b", "c"]);
  state = nextList(state, [t("a", 20), t("c", 5)], LINGER_MS, false);
  assert.deepEqual(shown(state), ["a", "c"]);
  // Back within the linger: the same row, present again, in the same place.
  const back = feed([[t("a", 20), t("b", 10), t("c", 5)], [t("a", 20), t("c", 5)], [t("a", 20), t("b", 10), t("c", 5)]]);
  assert.deepEqual(listRows(back).shown.map((row) => [row.thread.threadId, row.present]), [["a", true], ["b", true], ["c", true]]);
});

test("while frozen nothing moves, joins or leaves; numbers still update", () => {
  let state = feed([[t("a", 50), t("b", 40), t("c", 0.1)]]);
  const frozenReadings = [
    // b overtakes, a newcomer arrives, c turns busy, and a goes missing: a minute of it.
    ...repeat(30, [t("b", 95), t("d", 70), t("c", 30)]),
  ];
  state = feed(frozenReadings, { from: state, start: 2_000, frozen: () => true });
  assert.deepEqual([shown(state), folded(state)], [["a", "b"], ["c"]]);
  const rows = listRows(state);
  assert.deepEqual(
    [...rows.shown, ...rows.folded].map((row) => [row.thread.threadId, row.thread.cpu, row.present]),
    [["a", 50, false], ["b", 95, true], ["c", 30, true]],
  );
  // Let go: the held changes land at the next reading.
  state = nextList(state, [t("b", 95), t("d", 70), t("c", 30)], 70_000, false);
  assert.deepEqual([shown(state), folded(state)], [["b", "d", "c"], []]);
});

test("an unfolded row's thread keeps its place however its numbers move while frozen", () => {
  let state = feed([[t("a", 50), t("b", 40), t("c", 30)]]);
  const before = shown(state).indexOf("b");
  // b falls idle and then out of the readings entirely while its row is unfolded.
  state = feed([...repeat(10, [t("a", 50), t("b", 0.1), t("c", 60)]), ...repeat(10, [t("a", 50), t("c", 60)])], {
    from: state,
    start: 2_000,
    frozen: () => true,
  });
  assert.equal(shown(state).indexOf("b"), before);
  assert.deepEqual(shown(state), ["a", "b", "c"]);
});
