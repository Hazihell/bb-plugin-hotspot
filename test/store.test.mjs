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
  const threads = [{ threadId: "thr_aaaaaaaaaa", title: "Build", cpu: 90, processes: 3 }];
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
