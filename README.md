# bb-plugin-hotspot

Tells you when your Mac ran hot and which BB thread did it.

A background service samples every minute: the macOS thermal pressure level
(`notifyutil`), machine-wide CPU and load, and one `ps` table, rolled up into
the five BB threads and five other processes using the most CPU. Three hot
samples in a row (thermal pressure above nominal, or CPU at 80% of all cores)
open a **hot episode**; three normal ones close it. Each episode keeps its
culprit threads, ranked by CPU summed across the episode. When one opens, BB
shows a toast naming the top thread.

The sidebar footer always shows a heat dot and machine CPU, and the level
and top thread while hot; hover for the full line. Clicking it opens a
popover with the busiest threads, where each one can be opened, have its
running turn stopped, or have its work processes killed after a
confirmation that lists exactly what gets SIGTERM and what is spared.

The **Hotspot** page in the sidebar shows the current reading, a 24-hour or
7-day timeline of CPU with the thermal level beneath it and episodes shaded,
and the episode list. Expand an episode to see its culprits and jump to their
threads. Agents answer "why was my Mac hot at 3pm?" with the
`hotspot_history` tool, and `bb hotspot status` / `bb hotspot episodes` do the
same from a terminal. `skills/hotspot/SKILL.md` documents the commands,
settings and limits.

Sampling only reads, and Hotspot talks to no network service. The one thing
that signals a process is **Kill processes** (popover, or
`bb hotspot kill <threadId> --yes`). It targets only the thread's own work
(dev servers, builds, test runners, headless browsers) and never the agent
itself, BB, the shell running the command, other users' processes, system
binaries or apps. The server mints a two-minute, single-use plan id; apply
accepts only that id, re-reads the process table and refuses any pid whose
start time or command changed before sending SIGTERM, then SIGKILL after 5
seconds to verified survivors. Agents get no tool for killing or stopping
turns. Set `allowKill` to `false` to remove the action.

`server.ts` is the sampler loop, RPC, tool and CLI; `lib/` holds the pieces
with tests: `procs.ts` (process table and thread attribution), `thermal.ts`,
`sample.ts`, `episodes.ts` (the detector, a pure state machine), `store.ts`
(the plugin's SQLite database), `report.ts` (text and timeline shaping),
`kill.ts` (the kill planner and apply) and `footer.ts` (the footer wording).
`app.tsx` is the page, the sidebar badge and the toast;
`components/footer-indicator.tsx` is the footer indicator and popover.
`components/ui/` is vendored source you own.

## Install

```
npm install
bb plugin install .
bb plugin reload hotspot   # after editing sources
npm test                   # unit tests
```

## Credits

Process parsing and thread attribution in `lib/procs.ts`, and the plan/apply
pattern in `lib/kill.ts`, are adapted from
[Ballast](https://github.com/braedonsaunders/bb-plugin-ballast) by Braedon
Saunders, under the MIT License. See `NOTICE`. The footer placement follows
the approach of the usage-tracker plugin, which also lives in BB's footer
row.
