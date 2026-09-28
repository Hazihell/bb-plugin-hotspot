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
import { z } from "zod";
import { type DetectorState, type Episode, type Sample, episodeSchema, sampleSchema } from "./schemas";

/** The columns the timeline reads; `mem` is null in rows from before memory was sampled. */
const readingSchema = sampleSchema
  .pick({ at: true, cpu: true, thermal: true, load: true })
  .extend({ mem: z.number().nullable() });
export type Reading = z.infer<typeof readingSchema>;

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
  `CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Memory: the used % as its own column for cheap timeline reads, and the
  // full reading as JSON. Older rows keep NULL in both.
  `ALTER TABLE samples ADD COLUMN mem REAL`,
  `ALTER TABLE samples ADD COLUMN memory TEXT`,
  // BB's total and its app/threads split, as JSON. Older rows keep NULL.
  `ALTER TABLE samples ADD COLUMN bb TEXT`,
  // Process names written before lib/proc-name.ts named every process by
  // allowlist could hold command-line arguments. Clear them: each culprit's
  // process list (`procs`), each episode's outside-BB list (`others`), each
  // sample's outside-BB list (`procs`), and the same in the detector's open
  // episode and streak. Thread ids, CPU and memory stay.
  `UPDATE episodes SET
     culprits = (SELECT json_group_array(json_remove(value, '$.procs')) FROM json_each(episodes.culprits)),
     others = '[]'`,
  `UPDATE samples SET procs = '[]'`,
  `UPDATE state SET value = json_set(value,
     '$.open.culprits', (SELECT json_group_array(json_remove(c.value, '$.procs')) FROM json_each(state.value, '$.open.culprits') c),
     '$.open.others', json('[]'))
   WHERE key = 'detector' AND json_type(value, '$.open') = 'object'`,
  `UPDATE state SET value = json_set(value,
     '$.streak.culprits', (SELECT json_group_array(json_remove(c.value, '$.procs')) FROM json_each(state.value, '$.streak.culprits') c),
     '$.streak.others', json('[]'))
   WHERE key = 'detector' AND json_type(value, '$.streak') = 'object'`,
];

export const DAY_MS = 86_400_000;
const DETECTOR_KEY = "detector";

interface SampleRow {
  at: number;
  thermal: number | null;
  cpu: number;
  load: number;
  memory: string | null;
  threads: string;
  procs: string;
  /** Absent before the column's migration ran on this row's table; NULL in older rows. */
  bb?: string | null;
}

/**
 * Stored rows are untrusted: an older build or a hand edit may have written
 * anything. A row that does not parse is skipped, never cast.
 */
function parseRow<T>(schema: z.ZodType<T>, build: () => unknown): T | null {
  try {
    const parsed = schema.safeParse(build());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toSample(row: SampleRow): Sample | null {
  return parseRow(sampleSchema, () => ({
    at: row.at,
    thermal: row.thermal,
    cpu: row.cpu,
    load: row.load,
    memory: row.memory === null ? null : JSON.parse(row.memory),
    threads: JSON.parse(row.threads),
    procs: JSON.parse(row.procs),
    bb: row.bb == null ? null : JSON.parse(row.bb),
  }));
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

function toEpisode(row: EpisodeRow): Episode | null {
  return parseRow(episodeSchema, () => ({
    id: row.id,
    startAt: row.start_at,
    endAt: row.end_at,
    lastHotAt: row.last_hot_at,
    peakThermal: row.peak_thermal,
    peakCpu: row.peak_cpu,
    samples: row.samples,
    culprits: JSON.parse(row.culprits),
    others: JSON.parse(row.others),
  }));
}

const present = <T>(value: T | null): value is T => value !== null;

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
    `INSERT OR REPLACE INTO samples (at, thermal, cpu, load, mem, memory, threads, procs, bb)
     VALUES (@at, @thermal, @cpu, @load, @mem, @memory, @threads, @procs, @bb)`,
  );
  const selectSamples = db.prepare(
    `SELECT * FROM samples WHERE at >= ? AND at <= ? ORDER BY at`,
  );
  // The timeline only needs these columns; skipping the thread, process and
  // memory JSON keeps a 7-day read cheap.
  const selectReadings = db.prepare(
    `SELECT at, cpu, thermal, load, mem FROM samples WHERE at >= ? AND at <= ? ORDER BY at`,
  );
  const selectLatestAt = db.prepare(`SELECT MAX(at) AS at FROM samples`);
  const selectLatest = db.prepare(`SELECT * FROM samples ORDER BY at DESC LIMIT 10`);
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
  const selectState = db.prepare(`SELECT value FROM state WHERE key = ?`);
  const upsertState = db.prepare(
    `INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );
  const closeStray = db.prepare(
    `UPDATE episodes SET end_at = last_hot_at WHERE end_at IS NULL AND id IS NOT @keep`,
  );
  const deleteEpisodes = db.prepare(
    `DELETE FROM episodes WHERE end_at IS NOT NULL AND end_at < ?`,
  );

  function addSample(sample: Sample): void {
    insertSample.run({
      at: sample.at,
      thermal: sample.thermal,
      cpu: sample.cpu,
      load: sample.load,
      mem: sample.memory?.percent ?? null,
      memory: sample.memory === null ? null : JSON.stringify(sample.memory),
      // A thread's processes feed the open episode's culprits (lib/episodes.ts)
      // and are not kept per sample.
      threads: JSON.stringify(sample.threads.map(({ top: _top, ...thread }) => thread)),
      procs: JSON.stringify(sample.procs),
      bb: sample.bb === null ? null : JSON.stringify(sample.bb),
    });
  }

  function saveEpisode(episode: Episode): Episode {
    if (episode.id === null) {
      const id = Number(insertEpisode.run(episodeParams(episode)).lastInsertRowid);
      return { ...episode, id };
    }
    updateEpisode.run({ ...episodeParams(episode), id: episode.id });
    return episode;
  }

  /**
   * One sample's writes, all or nothing: the sample, the episode it closed,
   * the episode it opened or extended, and the detector state that points
   * at that episode's id. A crash can no longer leave state without the id
   * of an episode already stored, which made the next sample insert it again.
   */
  const commitStep = db.transaction(
    (step: { sample: Sample; closed: Episode | null; updated: Episode | null; state: DetectorState }) => {
      addSample(step.sample);
      const closed = step.closed === null ? null : saveEpisode(step.closed);
      const open = step.updated === null ? step.state.open : saveEpisode(step.updated);
      const state = { ...step.state, open };
      upsertState.run(DETECTOR_KEY, JSON.stringify(state));
      return { closed, open, state };
    },
  );

  return {
    commitStep,
    /**
     * End every stored open episode except `keepId` at its last hot sample.
     * An episode is only open while the detector holds it; one left open by
     * a reset or unreadable detector state would otherwise read "ongoing"
     * forever and never age out.
     */
    closeStrayEpisodes(keepId: number | null): number {
      return closeStray.run({ keep: keepId }).changes;
    },
    saveDetectorState(state: DetectorState): void {
      upsertState.run(DETECTOR_KEY, JSON.stringify(state));
    },
    /** The stored detector state as raw JSON, or null; parse it with restoreState. */
    detectorState(): unknown {
      const row = selectState.get(DETECTOR_KEY) as { value: string } | undefined;
      if (row === undefined) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    },
    addSample,
    samples(from: number, to: number): Sample[] {
      return (selectSamples.all(from, to) as SampleRow[]).map(toSample).filter(present);
    },
    /** Time, CPU, thermal level, load and memory % only, for the timeline. */
    readings(from: number, to: number): Reading[] {
      return (selectReadings.all(from, to) as unknown[])
        .map((row) => parseRow(readingSchema, () => row))
        .filter(present);
    },
    /** Time of the newest stored sample, parsed or not. */
    latestAt(): number | null {
      const row = selectLatestAt.get() as { at: number | null } | undefined;
      return typeof row?.at === "number" ? row.at : null;
    },
    /** The newest sample that parses. */
    latest(): Sample | null {
      return (selectLatest.all() as SampleRow[]).map(toSample).find(present) ?? null;
    },
    /** Insert a new episode or update a stored one; returns it with its id. */
    saveEpisode,
    /** Episodes overlapping [from, to], newest first. */
    episodes(from: number, to: number, limit: number): Episode[] {
      return (selectEpisodes.all({ from, to, limit }) as EpisodeRow[]).map(toEpisode).filter(present);
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
