import assert from "node:assert/strict";
import { test } from "node:test";
import { createThreadDirectory, isNotFound, named } from "../lib/threads.ts";

function fakeLookup(answers) {
  const calls = [];
  const lookup = async (threadId) => {
    calls.push(threadId);
    const answer = answers[threadId];
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  };
  return { calls, lookup };
}

test("found and not-found answers are cached; failures are retried", async () => {
  const flaky = new Error("socket hang up");
  const { calls, lookup } = fakeLookup({
    thr_foundthread: { title: "Build" },
    thr_flakythread: flaky,
  });
  let now = 0;
  const directory = createThreadDirectory(lookup, { ttlMs: 1_000, now: () => now });

  const first = await directory.resolve(["thr_foundthread", "thr_missingone", "thr_flakythread"]);
  assert.deepEqual([...first], [
    ["thr_foundthread", "Build"],
    ["thr_flakythread", null],
  ]);

  now = 500;
  await directory.resolve(["thr_foundthread", "thr_missingone", "thr_flakythread"]);
  assert.deepEqual(calls.sort(), [
    "thr_flakythread",
    "thr_flakythread",
    "thr_foundthread",
    "thr_missingone",
  ]);

  now = 2_000;
  await directory.resolve(["thr_foundthread"]);
  assert.equal(calls.filter((id) => id === "thr_foundthread").length, 2);
});

test("named drops unknown ids, attaches titles and keeps order", () => {
  const known = new Map([
    ["thr_b", "Beta"],
    ["thr_c", null],
  ]);
  const entries = [{ threadId: "thr_a", cpu: 9 }, { threadId: "thr_b", cpu: 5 }, { threadId: "thr_c", cpu: 1 }];
  assert.deepEqual(named(entries, known, 5), [
    { threadId: "thr_b", cpu: 5, title: "Beta" },
    { threadId: "thr_c", cpu: 1, title: null },
  ]);
  assert.equal(named(entries, known, 1).length, 1);
});

test("isNotFound recognises BB's 404 and nothing else", () => {
  assert.equal(isNotFound(new Error("HTTP 404: Thread not found")), true);
  assert.equal(isNotFound({ code: "thread_not_found" }), true);
  assert.equal(isNotFound(Object.assign(new Error("x"), { status: 404 })), true);
  assert.equal(isNotFound(new Error("HTTP 500: boom")), false);
  assert.equal(isNotFound(new Error("fetch failed")), false);
});
