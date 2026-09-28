import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { DAY_MS, MIGRATIONS, createStore } from "../lib/store.ts";

function openStore() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return createStore(db);
}

function sample(at, extra = {}) {
  return { at, thermal: 0, cpu: 10, load: 0.2, memory: null, threads: [], procs: [], ...extra };
}

const MEMORY = {
  percent: 76.2,
  totalBytes: 16 * 1024 ** 3,
  usedBytes: 12.2 * 1024 ** 3,
  appBytes: 5 * 1024 ** 3,
  wiredBytes: 3 * 1024 ** 3,
  compressedBytes: 4.2 * 1024 ** 3,
  swapUsedBytes: 1024 ** 3,
  pressure: "normal",
};

test("samples round-trip with their thread lists", () => {
  const store = openStore();
  const threads = [{ threadId: "thr_aaaaaaaaaa", cpu: 90, processes: 3, memBytes: 512 * 1024 ** 2 }];
  store.addSample(sample(1_000, { threads, thermal: null, memory: MEMORY }));
  store.addSample(sample(2_000));
  assert.deepEqual(store.samples(0, 1_500), [sample(1_000, { threads, thermal: null, memory: MEMORY })]);
  assert.equal(store.latest()?.at, 2_000);
});

test("prune drops samples older than the retention window only", () => {
  const store = openStore();
  const now = 30 * DAY_MS;
  store.addSample(sample(now - 8 * DAY_MS));
  store.addSample(sample(now - 7 * DAY_MS - 1));
  store.addSample(sample(now - 7 * DAY_MS));
  store.addSample(sample(now - 60_000));
  assert.deepEqual(store.prune(now, 7), { samples: 2, episodes: 0 });
  assert.deepEqual(
    store.samples(0, now).map((row) => row.at),
    [now - 7 * DAY_MS, now - 60_000],
  );
});

test("rows that do not parse are skipped, not cast", () => {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = createStore(db);
  store.addSample(sample(1_000));
  db.prepare(
    `INSERT INTO samples (at, thermal, cpu, load, threads, procs) VALUES (2000, 0, 5, 0, 'not json', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO samples (at, thermal, cpu, load, threads, procs) VALUES (3000, 0, 5, 0, '[{"threadId":7}]', '[]')`,
  ).run();
  db.prepare(
    `INSERT INTO episodes (start_at, end_at, last_hot_at, peak_thermal, peak_cpu, samples, culprits, others)
     VALUES (1, 2, 2, 0, 90, 3, '{"oops":true}', '[]')`,
  ).run();
  assert.deepEqual(store.samples(0, 10_000).map((row) => row.at), [1_000]);
  assert.equal(store.latest()?.at, 1_000);
  assert.deepEqual(store.episodes(0, 10, 10), []);
});

test("a title stored by an older build is stripped when the row is read", () => {
  const store = openStore();
  store.addSample(
    sample(1_000, { threads: [{ threadId: "thr_aaaaaaaaaa", title: "Old title", cpu: 9, processes: 1 }] }),
  );
  assert.deepEqual(store.latest().threads, [{ threadId: "thr_aaaaaaaaaa", cpu: 9, processes: 1, memBytes: null }]);
});

test("readings carry only time, CPU, thermal level, load and memory %", () => {
  const store = openStore();
  store.addSample(sample(1_000, { threads: [{ threadId: "thr_aaaaaaaaaa", cpu: 9, processes: 1 }], memory: MEMORY }));
  store.addSample(sample(2_000, { thermal: null, cpu: 55 }));
  assert.deepEqual(store.readings(0, 5_000), [
    { at: 1_000, cpu: 10, thermal: 0, load: 0.2, mem: 76.2 },
    { at: 2_000, cpu: 55, thermal: null, load: 0.2, mem: null },
  ]);
});

test("the memory migration keeps rows stored before it, which read back without memory", () => {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS.slice(0, 4)) db.exec(statement);
  db.prepare(
    `INSERT INTO samples (at, thermal, cpu, load, threads, procs)
     VALUES (1000, 1, 42, 0.5, '[{"threadId":"thr_aaaaaaaaaa","cpu":30,"processes":2}]', '[]')`,
  ).run();
  for (const statement of MIGRATIONS.slice(4)) db.exec(statement);
  const store = createStore(db);
  assert.deepEqual(store.latest(), {
    at: 1000,
    thermal: 1,
    cpu: 42,
    load: 0.5,
    memory: null,
    threads: [{ threadId: "thr_aaaaaaaaaa", cpu: 30, processes: 2, memBytes: null }],
    procs: [],
  });
  assert.deepEqual(store.readings(0, 5_000), [{ at: 1000, cpu: 42, thermal: 1, load: 0.5, mem: null }]);
});

test("closeStrayEpisodes ends every open episode but the detector's own", () => {
  const store = openStore();
  const base = { endAt: null, peakThermal: 1, peakCpu: 90, samples: 3, culprits: [], others: [] };
  const stray = store.saveEpisode({ ...base, id: null, startAt: 1_000, lastHotAt: 5_000 });
  const current = store.saveEpisode({ ...base, id: null, startAt: 9_000, lastHotAt: 9_500 });
  const closed = store.saveEpisode({ ...base, id: null, startAt: 100, lastHotAt: 200, endAt: 200 });

  assert.equal(store.closeStrayEpisodes(current.id), 1);
  assert.equal(store.episode(stray.id).endAt, 5_000);
  assert.equal(store.episode(current.id).endAt, null);
  assert.equal(store.episode(closed.id).endAt, 200);

  // With no current episode, every open one is closed and can age out.
  assert.equal(store.closeStrayEpisodes(null), 1);
  assert.equal(store.episode(current.id).endAt, 9_500);
  assert.equal(store.prune(30 * DAY_MS, 7).episodes, 3);
});
