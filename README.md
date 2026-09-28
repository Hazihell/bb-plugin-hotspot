# bb-plugin-hotspot

Tells you when your Mac ran hot and which BB thread did it.

A background service stores a sample every minute: the macOS thermal pressure level
(`notifyutil`), machine-wide CPU and load, memory (used %, app, wired and
compressed memory, swap used and the kernel's memory pressure level, from
`vm_stat` and `sysctl`), and one `ps` table, rolled up into the five BB
threads and five other processes using the most CPU, with each thread's
resident memory. Three hot
samples in a row (thermal pressure above nominal, or CPU at 80% of all cores)
open a **hot episode**; three normal ones close it. Each episode keeps its
culprit threads, ranked by CPU summed across the episode. When one opens, BB
shows a toast naming the top thread.

While a BB window is on screen, the same service also takes a live reading
every 2 seconds and pushes it to the footer, the popover and the page's
numbers. Each open window renews a 20-second watch lease every 5 seconds
while it is visible (and a second after a failed renewal); when every lease
lapses, only the minute samples run.
Live readings are never stored and never open or close an episode. Thread
and process CPU is the CPU time each process used since the previous
reading (`ps` `time`, keyed by pid and start time so a reused pid is not a
spike; a process that started inside the window counts all its CPU time),
not `ps`'s minute-long decaying `%cpu`, so a stored sample measures
its whole minute and a live one its last 2 seconds. One reading costs about
30 ms and one `ps`.

The sidebar footer always shows Hotspot's flame and labelled figures, `CPU
16%` and `MEM 62%`. The flame turns amber or red with the heat, and a word
(`Hot`, `Warm`, `Busy`) and the top thread join the figures when there is
room. In the 320px sidebar beside other readouts the two figures stack on
two short lines; narrower still, the word goes first, then one figure, but
a figure never appears without its label. Hover for the full line. Clicking
it opens a popover that leads with the verdict ("Running hot since 2:13 PM,
mostly <thread>"), then a numbers row (heat, CPU, memory with swap, load per
core, each with a line for the last hour and colour only when it crosses a
line), then the busiest threads, one line each with CPU and memory. The
list's header row carries **BB total** in the same CPU and memory columns:
BB's own processes (everything running from `bb.app`, its helpers and
server, and the `bb` CLI) plus every process attributed to a thread, with
the app/threads split in its tooltip. Children of BB that no thread claims
(a plugin's build toolchain, say) are not counted. Memory is summed
resident size, so pages shared between processes count more than once. Clicking a
title opens the thread; its "…" button unfolds the process count, Stop turn
and Kill processes…, which kills its work processes after a confirmation
that names what gets SIGTERM and lists what is spared. Threads under 1% CPU
and 1 GB of memory fold into an "N idle threads" line, and only the thread
list scrolls, so the verdict, numbers and last hot spells stay in view.
Readings change the numbers in place; the list itself holds steady. A row
climbs over a row only when it leads it by more than 5 points, at most every
6 s; a thread folds after 15 s idle and comes back at once above 5% or after
6 s busy; a thread missing from a reading keeps its row, CPU shown as "—",
for 10 s. While the pointer or keyboard focus is in the list, or a row's
"…" is unfolded, no row moves, joins or leaves, so Stop turn and Kill stay
on the thread you opened them for. The list keeps room for three rows and
never shrinks while the popover is open, except when you hide the idle
threads, so the popover does not jump. Below the list, the line naming
busy processes outside BB ends in an **Activity Monitor** button that opens
macOS Activity Monitor (on Linux, GNOME System Monitor or KDE's) on the
machine running BB's server; the page has the same button under its
numbers. It shows only when the server found a monitor, its tooltip names
that machine, and a failure replaces the line's text for a few seconds. On a
phone (BB Connect) the indicator sits in the sidebar drawer's footer, the
popover opens as a bottom sheet with 44px targets, the Activity Monitor
button is hidden (it would open on the Mac, not the phone), and the drawer
closes when you jump to a thread or the page.

The **Hotspot** page in the sidebar shows the same verdict and numbers row,
a 24-hour or 7-day timeline of CPU with the thermal level beneath it and hot
spells (episodes) shaded, a shorter memory plot under it on the same time
axis, and the list of hot spells. Hover, tap or step through
the chart with the arrow keys; selecting a shaded band, or a recent hot
spell in the popover, opens that episode's culprits. Agents answer "why was my Mac hot at 3pm?" with the
`hotspot_history` tool, and `bb hotspot status` / `bb hotspot episodes` do the
same from a terminal. `skills/hotspot/SKILL.md` documents the commands,
settings and limits.

Sampling only reads, and Hotspot talks to no network service. Besides
opening Activity Monitor (`open -a "Activity Monitor"`, fixed arguments, no
shell), the one thing that signals a process is **Kill processes** (popover, or
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
`memory.ts` (memory and swap),
`sample.ts` (one reading over the live and stored windows), `episodes.ts` (the detector, a pure state machine), `store.ts`
(the plugin's SQLite database), `report.ts` (text and timeline shaping),
`kill.ts` (the kill planner and apply), `monitor.ts` (finding and
opening the OS process monitor) and `footer.ts` (the footer wording
and how it narrows).
`lib/present.ts` holds the verdict and the time, tick and kill-summary
wording the UI shows. `app.tsx` is the page, the sidebar badge and the
toast; `components/footer-indicator.tsx` is the footer indicator and
popover, `components/metrics.tsx` the numbers row,
`components/kill-confirm.tsx` the kill confirmation,
`components/monitor-button.tsx` the Activity Monitor button,
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

Process parsing and thread attribution in `lib/procs.ts`, the plan/apply
pattern in `lib/kill.ts`, and the memory reader in `lib/memory.ts` are
adapted from
[Ballast](https://github.com/braedonsaunders/bb-plugin-ballast) by Braedon
Saunders, under the MIT License. See `NOTICE`. The footer placement follows
the approach of the usage-tracker plugin, which also lives in BB's footer
row.
