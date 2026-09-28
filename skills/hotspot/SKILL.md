---
name: hotspot
description: Answer when the user's Mac ran hot and which BB thread caused it, using the Hotspot plugin's `hotspot_history` tool or `bb hotspot` CLI. Use when the user asks why the Mac was hot, loud, throttled or slow at some time, or which thread is using the CPU now.
---

# Hotspot

Hotspot samples the Mac BB's server runs on, every 60 seconds by default: the
macOS thermal pressure level, machine-wide CPU, load per core, the five BB
threads using the most CPU, and the five busiest processes that belong to no
thread. It keeps seven days of samples and records **hot episodes**.

An episode opens after three consecutive hot samples. A sample is hot when
thermal pressure is above nominal or CPU is at or above the threshold (80% of
all cores by default). Three normal samples close it at its last hot sample.
Its culprits are threads ranked by CPU summed over its hot samples.

## Answering "why was my Mac hot at 3pm?"

Call `hotspot_history` with a window around the time the user names:

- `since`: `90m`, `3h`, `2d`, `1w` back from now; `15:00` for the most recent
  15:00 in server-local time; or an ISO date/time. Default `24h`.
- `until`: same forms, default now.
- `limit`: most episodes to list, 1–20, default 5.

It returns a summary of the whole window (average and peak CPU, peak thermal
level, busiest threads) and every episode overlapping it with its ranked
culprits. When there is no episode, the window summary still says what was
busy. Name the culprit thread by title and give its id as `@thread:<id>` so
BB renders a link.

## Commands

```
bb hotspot status [--json]
bb hotspot episodes [--since 24h] [--until <time>] [--limit 10] [--json]
```

`status` prints the latest sample and the episode in progress, if any.
`episodes` lists episodes newest first; `--limit` is 1–50 and the JSON form
keeps the top five culprits per episode.

## Settings

Set with `bb plugin config hotspot set <key> <value>`:

| Key | Default | Range |
| --- | --- | --- |
| `sampleIntervalSeconds` | 60 | 15–3600 |
| `retentionDays` | 7 | 1–30 |
| `cpuThreshold` | 80 (% of all cores) | 10–100 |
| `toast` | true | show a toast in BB when an episode opens |

## Limits

- Thread and process CPU is a share of the whole Mac (all cores = 100%). It
  comes from `ps`, which on macOS is a decaying average over about a minute,
  so a burst shows up late and fades slowly. Machine CPU is exact over the
  sample interval.
- Thermal pressure is a level (nominal, moderate, heavy, trapping, sleeping),
  not a temperature; degree readings need root. On Linux it is unknown and
  only the CPU rule applies; thread attribution there reads
  `/proc/<pid>/environ`. If `ps` fails, samples still record CPU and load
  with no threads.
- A process belongs to a thread through `BB_THREAD_ID` in its own
  environment, else a `thr_…` id that is a folder directly under a BB
  `worktrees/` or `workspaces/` directory in its arguments, else its nearest
  ancestor with either. A bare `thr_…` in a command line (`grep thr_x`) or a
  worktree path in another variable (`PWD`) does not count. Processes owned
  by other users, such as root daemons, never map to a thread.
- Thread titles are looked up when shown, so a renamed thread shows its
  current title everywhere, and an id BB no longer knows is left out.
- Only the machine the BB server runs on is sampled, never remote hosts.
- Nothing is sampled while the Mac sleeps or the plugin is off; a gap longer
  than three intervals (the larger of the old and new interval, if the
  setting changed) ends an open episode.
- Hotspot only reads. It never signals, renices or stops a process.
