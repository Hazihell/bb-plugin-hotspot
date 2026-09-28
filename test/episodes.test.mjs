import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initialState, isHot, step } from "../lib/episodes.ts";
import { DAY_MS, MIGRATIONS, createStore } from "../lib/store.ts";

const MINUTE = 60_000;
const CONFIG = { cpuThreshold: 80, openAfter: 3, closeAfter: 3, maxGapMs: 3 * MINUTE };

function sample(minute, { cpu = 10, thermal = 0, threads = [], procs = [] } = {}) {
  return { at: minute * MINUTE, thermal, cpu, load: 0.1, threads, procs };
}
const hot = (minute, threads = []) => sample(minute, { cpu: 90, threads });
const cool = (minute) => sample(minute);
const thread = (threadId, cpu, title = null) => ({ threadId, title, cpu, processes: 1 });

/** Feed samples through the detector and collect what it announced. */
function run(samples, state = initialState()) {
  const events = [];
  for (const next of samples) {
    const result = step(state, next, CONFIG);
    state = result.state;
    if (result.opened) events.push(["opened", next.at / MINUTE]);
    if (result.closed) events.push(["closed", next.at / MINUTE, result.closed]);
  }
  return { state, events };
}

test("a sample is hot on any thermal pressure or CPU at the threshold", () => {
  assert.equal(isHot({ thermal: 1, cpu: 0 }, 80), true);
  assert.equal(isHot({ thermal: 0, cpu: 80 }, 80), true);
  assert.equal(isHot({ thermal: 0, cpu: 79.9 }, 80), false);
  assert.equal(isHot({ thermal: null, cpu: 50 }, 80), false);
});

test("two hot samples are not an episode; the third opens one", () => {
  assert.deepEqual(run([hot(0), hot(1), cool(2)]).events, []);
  const { state, events } = run([hot(0), hot(1), hot(2)]);
  assert.deepEqual(events, [["opened", 2]]);
  assert.equal(state.open.startAt, 0);
  assert.equal(state.open.samples, 3);
});

test("thermal pressure alone opens an episode with CPU idle", () => {
  const warm = (minute) => sample(minute, { thermal: 2, cpu: 5 });
  const { state } = run([warm(0), warm(1), warm(2)]);
  assert.equal(state.open.peakThermal, 2);
});

test("an episode closes after three normal samples at its last hot sample", () => {
  const { state, events } = run([hot(0), hot(1), hot(2), hot(3), cool(4), cool(5), cool(6)]);
  assert.equal(state.open, null);
  const [, at, closed] = events[1];
  assert.equal(at, 6);
  assert.equal(closed.endAt, 3 * MINUTE);
  assert.equal(closed.samples, 4);
});

test("a hot sample inside the cool-down keeps the episode open", () => {
  const { state, events } = run([
    hot(0), hot(1), hot(2), cool(3), cool(4), hot(5), cool(6), cool(7),
  ]);
  assert.deepEqual(events, [["opened", 2]]);
  assert.equal(state.open.lastHotAt, 5 * MINUTE);
  assert.equal(state.normalStreak, 2);
});

test("culprits are ranked by CPU summed over the hot samples", () => {
  const { state } = run([
    hot(0, [thread("thr_spikyyyyyy", 70), thread("thr_steadyyyyy", 30)]),
    hot(1, [thread("thr_steadyyyyy", 30, "Steady build")]),
    hot(2, [thread("thr_steadyyyyy", 30)]),
    cool(3),
  ]);
  const culprits = state.open.culprits;
  assert.deepEqual(
    culprits.map((entry) => [entry.threadId, entry.cpuSum, entry.samples]),
    [
      ["thr_spikyyyyyy", 70, 1],
      ["thr_steadyyyyy", 90, 3],
    ].sort((a, b) => b[1] - a[1]),
  );
  assert.equal(culprits[0].title, "Steady build");
  assert.equal(culprits[0].peakCpu, 30);
});

test("a long gap between samples closes the open episode and resets the streak", () => {
  const { state, events } = run([hot(0), hot(1), hot(2), hot(60), hot(61)]);
  assert.equal(events[1][0], "closed");
  assert.equal(events[1][2].endAt, 2 * MINUTE);
  assert.equal(state.open, null);
  assert.equal(state.streak.samples, 2);
});

test("episodes round-trip through the store and prune by end time", () => {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = createStore(db);
  const now = 30 * DAY_MS;

  const { state } = run([hot(0, [thread("thr_aaaaaaaaaa", 50)]), hot(1), hot(2)]);
  const old = store.saveEpisode({ ...state.open, startAt: now - 9 * DAY_MS, endAt: now - 8 * DAY_MS });
  const open = store.saveEpisode({ ...state.open, startAt: now - 10 * DAY_MS, endAt: null });
  const recent = store.saveEpisode({ ...state.open, startAt: now - DAY_MS, endAt: now - DAY_MS + MINUTE });
  assert.equal(typeof old.id, "number");
  assert.deepEqual(store.episode(recent.id), recent);

  assert.deepEqual(store.prune(now, 7), { samples: 0, episodes: 1 });
  assert.equal(store.episode(old.id), null);
  assert.notEqual(store.episode(open.id), null);

  assert.deepEqual(
    store.episodes(now - 2 * DAY_MS, now, 10).map((episode) => episode.id),
    [recent.id, open.id],
  );
  store.saveEpisode({ ...open, endAt: now - 9 * DAY_MS });
  assert.deepEqual(store.prune(now, 7).episodes, 1);
});
