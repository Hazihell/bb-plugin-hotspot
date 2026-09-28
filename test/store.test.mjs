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
  return { at, thermal: 0, cpu: 10, load: 0.2, threads: [], procs: [], ...extra };
}

test("samples round-trip with their thread lists", () => {
  const store = openStore();
  const threads = [{ threadId: "thr_aaaaaaaaaa", cpu: 90, processes: 3 }];
  store.addSample(sample(1_000, { threads, thermal: null }));
  store.addSample(sample(2_000));
  assert.deepEqual(store.samples(0, 1_500), [sample(1_000, { threads, thermal: null })]);
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
  assert.deepEqual(store.latest().threads, [{ threadId: "thr_aaaaaaaaaa", cpu: 9, processes: 1 }]);
});

test("readings carry only time, CPU and thermal level", () => {
  const store = openStore();
  store.addSample(sample(1_000, { threads: [{ threadId: "thr_aaaaaaaaaa", cpu: 9, processes: 1 }] }));
  store.addSample(sample(2_000, { thermal: null, cpu: 55 }));
  assert.deepEqual(store.readings(0, 5_000), [
    { at: 1_000, cpu: 10, thermal: 0 },
    { at: 2_000, cpu: 55, thermal: null },
  ]);
});
