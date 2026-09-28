/**
 * Persistence in the plugin's own SQLite database (`bb.storage.database()`).
 *
 * A week of one-minute samples is ~10k rows. KV storage holds one JSON value
 * per key, so a history there would mean rewriting a growing blob every
 * minute or inventing a key scheme to page and prune; SQLite gives indexed
 * range reads and a one-statement prune. The database handle comes from the
 * host, so the plugin ships no native module of its own.
 */
import type Database from "better-sqlite3";
import type { Sample } from "./sample";

type Db = Database.Database;

/** Append-only: the index is the migration id. Never edit a shipped entry. */
export const MIGRATIONS = [
  `CREATE TABLE samples (
     at INTEGER PRIMARY KEY,
     thermal INTEGER,
     cpu REAL NOT NULL,
     load REAL NOT NULL,
     threads TEXT NOT NULL,
     procs TEXT NOT NULL
   )`,
];

export const DAY_MS = 86_400_000;

interface SampleRow {
  at: number;
  thermal: number | null;
  cpu: number;
  load: number;
  threads: string;
  procs: string;
}

function toSample(row: SampleRow): Sample {
  return {
    at: row.at,
    thermal: row.thermal,
    cpu: row.cpu,
    load: row.load,
    threads: JSON.parse(row.threads),
    procs: JSON.parse(row.procs),
  };
}

export function createStore(db: Db) {
  const insertSample = db.prepare(
    `INSERT OR REPLACE INTO samples (at, thermal, cpu, load, threads, procs)
     VALUES (@at, @thermal, @cpu, @load, @threads, @procs)`,
  );
  const selectSamples = db.prepare(
    `SELECT * FROM samples WHERE at >= ? AND at <= ? ORDER BY at`,
  );
  const selectLatest = db.prepare(`SELECT * FROM samples ORDER BY at DESC LIMIT 1`);
  const deleteSamples = db.prepare(`DELETE FROM samples WHERE at < ?`);

  return {
    addSample(sample: Sample): void {
      insertSample.run({
        ...sample,
        threads: JSON.stringify(sample.threads),
        procs: JSON.stringify(sample.procs),
      });
    },
    samples(from: number, to: number): Sample[] {
      return (selectSamples.all(from, to) as SampleRow[]).map(toSample);
    },
    latest(): Sample | null {
      const row = selectLatest.get() as SampleRow | undefined;
      return row === undefined ? null : toSample(row);
    },
    /** Drop everything older than the retention window. */
    prune(now: number, retentionDays: number): { samples: number } {
      const cutoff = now - retentionDays * DAY_MS;
      return { samples: deleteSamples.run(cutoff).changes };
    },
  };
}

export type Store = ReturnType<typeof createStore>;
