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
import type { Episode, Sample } from "./schemas";

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
  `CREATE TABLE episodes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     start_at INTEGER NOT NULL,
     end_at INTEGER,
     last_hot_at INTEGER NOT NULL,
     peak_thermal INTEGER,
     peak_cpu REAL NOT NULL,
     samples INTEGER NOT NULL,
     culprits TEXT NOT NULL,
     others TEXT NOT NULL
   )`,
  `CREATE INDEX episodes_start_at ON episodes (start_at)`,
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

interface EpisodeRow {
  id: number;
  start_at: number;
  end_at: number | null;
  last_hot_at: number;
  peak_thermal: number | null;
  peak_cpu: number;
  samples: number;
  culprits: string;
  others: string;
}

function toEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    startAt: row.start_at,
    endAt: row.end_at,
    lastHotAt: row.last_hot_at,
    peakThermal: row.peak_thermal,
    peakCpu: row.peak_cpu,
    samples: row.samples,
    culprits: JSON.parse(row.culprits),
    others: JSON.parse(row.others),
  };
}

function episodeParams(episode: Episode) {
  return {
    start_at: episode.startAt,
    end_at: episode.endAt,
    last_hot_at: episode.lastHotAt,
    peak_thermal: episode.peakThermal,
    peak_cpu: episode.peakCpu,
    samples: episode.samples,
    culprits: JSON.stringify(episode.culprits),
    others: JSON.stringify(episode.others),
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
  const insertEpisode = db.prepare(
    `INSERT INTO episodes
       (start_at, end_at, last_hot_at, peak_thermal, peak_cpu, samples, culprits, others)
     VALUES
       (@start_at, @end_at, @last_hot_at, @peak_thermal, @peak_cpu, @samples, @culprits, @others)`,
  );
  const updateEpisode = db.prepare(
    `UPDATE episodes SET start_at = @start_at, end_at = @end_at, last_hot_at = @last_hot_at,
       peak_thermal = @peak_thermal, peak_cpu = @peak_cpu, samples = @samples,
       culprits = @culprits, others = @others
     WHERE id = @id`,
  );
  // Overlap, not containment: an episode that began before the window and
  // ran into it belongs to the window.
  const selectEpisodes = db.prepare(
    `SELECT * FROM episodes
     WHERE start_at <= @to AND (end_at IS NULL OR end_at >= @from)
     ORDER BY start_at DESC LIMIT @limit`,
  );
  const selectEpisode = db.prepare(`SELECT * FROM episodes WHERE id = ?`);
  const deleteEpisodes = db.prepare(
    `DELETE FROM episodes WHERE end_at IS NOT NULL AND end_at < ?`,
  );

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
    /** Insert a new episode or update a stored one; returns it with its id. */
    saveEpisode(episode: Episode): Episode {
      if (episode.id === null) {
        const id = Number(insertEpisode.run(episodeParams(episode)).lastInsertRowid);
        return { ...episode, id };
      }
      updateEpisode.run({ ...episodeParams(episode), id: episode.id });
      return episode;
    },
    /** Episodes overlapping [from, to], newest first. */
    episodes(from: number, to: number, limit: number): Episode[] {
      return (selectEpisodes.all({ from, to, limit }) as EpisodeRow[]).map(toEpisode);
    },
    episode(id: number): Episode | null {
      const row = selectEpisode.get(id) as EpisodeRow | undefined;
      return row === undefined ? null : toEpisode(row);
    },
    /**
     * Drop everything older than the retention window. An open episode is
     * kept however old its start, until it closes and ages out.
     */
    prune(now: number, retentionDays: number): { samples: number; episodes: number } {
      const cutoff = now - retentionDays * DAY_MS;
      return {
        samples: deleteSamples.run(cutoff).changes,
        episodes: deleteEpisodes.run(cutoff).changes,
      };
    },
  };
}

export type Store = ReturnType<typeof createStore>;
