# bb-plugin-hotspot

Tells you when your Mac ran hot and which BB thread did it.

A background service samples every minute: the macOS thermal pressure level
(`notifyutil`), machine-wide CPU and load, and one `ps` table, rolled up into
the five BB threads and five other processes using the most CPU. Three hot
samples in a row (thermal pressure above nominal, or CPU at 80% of all cores)
open a **hot episode**; three normal ones close it. Each episode keeps its
culprit threads, ranked by CPU summed across the episode. When one opens, BB
shows a toast naming the top thread.

The **Hotspot** page in the sidebar shows the current reading, a 24-hour or
7-day timeline of CPU with the thermal level beneath it and episodes shaded,
and the episode list. Expand an episode to see its culprits and jump to their
threads. Agents answer "why was my Mac hot at 3pm?" with the
`hotspot_history` tool, and `bb hotspot status` / `bb hotspot episodes` do the
same from a terminal. `skills/hotspot/SKILL.md` documents the commands,
settings and limits.

Hotspot only reads. It never signals, renices or stops a process, and it
talks to no network service.

`server.ts` is the sampler loop, RPC, tool and CLI; `lib/` holds the pieces
with tests: `procs.ts` (process table and thread attribution), `thermal.ts`,
`sample.ts`, `episodes.ts` (the detector, a pure state machine), `store.ts`
(the plugin's SQLite database) and `report.ts` (text and timeline shaping).
`app.tsx` is the page, the sidebar badge and the toast. `components/ui/` is
vendored source you own.

## Install

```
npm install
bb plugin install .
bb plugin reload hotspot   # after editing sources
npm test                   # unit tests
```

## Credits

Process parsing and thread attribution in `lib/procs.ts` are adapted from
[Ballast](https://github.com/braedonsaunders/bb-plugin-ballast) by Braedon
Saunders, under the MIT License. See `NOTICE`.
