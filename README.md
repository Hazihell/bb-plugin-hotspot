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
popover that leads with the verdict ("Running hot since 2:13 PM, mostly
<thread>"), then the busiest threads, where each one can be opened, have its
running turn stopped, or have its work processes killed after a
confirmation that names what gets SIGTERM and lists what is spared. On a
phone (BB Connect) the indicator sits in the sidebar drawer's footer, the
popover opens as a bottom sheet with 44px targets, and the drawer closes
when you jump to a thread or the page.

The **Hotspot** page in the sidebar shows the same verdict, a 24-hour or
7-day timeline of CPU with the thermal level beneath it and hot spells
(episodes) shaded, and the list of hot spells. Hover, tap or step through
the chart with the arrow keys; selecting a shaded band, or a recent hot
spell in the popover, opens that episode's culprits. Agents answer "why was my Mac hot at 3pm?" with the
`hotspot_history` tool, and `bb hotspot status` / `bb hotspot episodes` do the
same from a terminal. `skills/hotspot/SKILL.md` documents the commands,
settings and limits.

Sampling only reads, and Hotspot talks to no network service. The one thing
that signals a process is **Kill processes** (popover, or
`bb hotspot kill <threadId> --yes` typed by a person in a terminal). It
targets only the thread's own work: what the agent's shells started and
detached processes carrying the thread's id (dev servers, builds, test
runners, headless browsers). BB, apps (any `.app` bundle, and everything under an app a
thread happened to open, such as its terminals), terminal emulators and
tmux, other users' processes, system binaries and interactive shells end a
thread's claim. The agent's whole
chain (wrappers, relaunches) and its MCP servers are spared. The server
mints a two-minute, single-use plan id; apply accepts only that id,
re-reads the process table and refuses any pid whose start time or command
changed before sending SIGTERM, then SIGKILL after 5 seconds to verified
survivors. Agents get no tool for killing or stopping turns, and the CLI
refuses `--yes` without a terminal or from under a provider bridge. That
guards against an agent applying a kill by accident, not against one set on
signalling processes itself. Set `allowKill` to `false` to remove the action.

`server.ts` is the sampler loop, RPC, tool and CLI; `lib/` holds the pieces
with tests: `procs.ts` (process table and thread attribution), `thermal.ts`,
`sample.ts`, `episodes.ts` (the detector, a pure state machine), `store.ts`
(the plugin's SQLite database), `report.ts` (text and timeline shaping),
`kill.ts` (the kill planner and apply) and `footer.ts` (the footer wording).
`lib/present.ts` holds the verdict and the time, tick and kill-summary
wording the UI shows. `app.tsx` is the page, the sidebar badge and the
toast; `components/footer-indicator.tsx` is the footer indicator and
popover, `components/kill-confirm.tsx` the kill confirmation,
`components/timeline-chart.tsx` the chart and `components/heat.tsx` the
shared verdict block and heat colours.
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
