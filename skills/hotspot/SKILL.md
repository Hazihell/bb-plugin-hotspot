---
name: hotspot
description: Answer when the user's Mac ran hot and which BB thread caused it, using the Hotspot plugin's `hotspot_history` tool or `bb hotspot` CLI. Use when the user asks why the Mac was hot, loud, throttled or slow at some time, or which thread is using the CPU or memory now.
---

# Hotspot

Hotspot samples the Mac BB's server runs on, every 60 seconds by default: the
macOS thermal pressure level, machine-wide CPU, load per core, memory (used
%, app, wired and compressed memory, swap used, and the kernel's memory
pressure level: normal, warn or critical), the five BB threads using the
most CPU with each one's resident memory, and the five busiest processes
that belong to no thread. It keeps seven days of samples and records **hot
episodes**. Memory does not open or close episodes.

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

It returns a summary of the whole window (average and peak CPU, average and
peak memory used, peak swap, worst memory pressure, peak thermal level, and
the busiest threads with their CPU and peak memory) and every episode
overlapping it with its ranked culprits. Samples taken before memory was
recorded say "Memory: not recorded". When there is no episode, the window summary still says what was
busy. Name the culprit thread by title and give its id as `@thread:<id>` so
BB renders a link.

## Commands

```
bb hotspot status [--json]
bb hotspot episodes [--since 24h] [--until <time>] [--limit 10] [--json]
bb hotspot kill <threadId> [--yes] [--json]
```

`status` prints the latest sample (including a memory line and each
thread's memory) and the episode in progress, if any; `--json` carries the
full memory reading under `latest.memory` and `memBytes` per thread.
`episodes` lists episodes newest first; `--limit` is 1–50 and the JSON form
keeps the top five culprits per episode.

`kill` prints which of a thread's processes would get SIGTERM and which are
spared, with the reason; nothing is signalled without `--yes`. With `--yes`
it applies that plan: SIGTERM, then SIGKILL after 5 seconds for survivors
that are still the same process. `--yes` is refused unless a person typed
the command in a terminal: the calling `bb` process must have a
controlling terminal and no provider bridge above it. That stops an agent
applying a kill by accident; it does not stop a determined one, which could
signal the processes itself. Agents may run the dry run; to kill, point the
user to the popover. There is no agent tool for killing processes or stopping a
thread's turn, on purpose.

## What a kill touches

A process belongs to a thread for a kill only when walking up from it
reaches a process BB launched with that thread's `BB_THREAD_ID`, or a
detached process (parent launchd) carrying that id, without first crossing
a **wall**. Walls are never targets, and nothing below a wall belongs to the
thread, even when it inherited the id:

- BB itself (anything under `bb.app`, `bb`, `bb Helper`, a `bb` CLI call)
  and Hotspot's own process chain;
- other users' processes (`login`, `sudo`), system binaries (`/System`,
  `/usr/libexec`, `/usr/sbin`, `/sbin`);
- any executable inside a `*.app/Contents/` bundle, wherever it is installed
  (`/Applications`, `~/Applications`, a Homebrew cask), unless it runs
  `--headless` or with a remote-debugging port, so an app opened from a
  thread (Orca, VS Code, Docker) keeps its terminals and helpers;
- terminal emulators and multiplexers wherever installed: alacritty, kitty,
  WezTerm, Ghostty, iTerm2, Terminal, tmux, screen, zellij;
- interactive shells: a login shell (`-zsh`) or one with no `-c` and no
  script.

Below the process BB launched, the **agent chain** is spared: the launched
process and everything down to its first work shell, passing through
wrappers (`npx`, `npm exec`, `uvx`, `sh -c`) and a program relaunching its
own executable (Gemini's `node` → `node`). `sandbox-exec` is transparent:
Codex's sandboxed command shell is work, Codex itself is not. Any other child of the agent (an
MCP server, `rg`) is a helper and is spared with everything under it. Work
starts at a shell the agent runs (`zsh -c`, `bash -lc`), and detached
processes carrying the id (a dev server reparented to launchd) are work
too. The shell running a spared process and the rest of a `bb` CLI call's
command (`bb hotspot kill … | head`) are also spared.

The plan lists the thread's targets and spared processes, plus any process
the id reached only through a wall. The plan id expires after two minutes
and works once. Before each signal the server re-reads the process table
and refuses a target whose start time or command line changed (a recycled
pid) or that no longer passes these rules. Every kill is logged with its
counts (`bb plugin logs hotspot`).

## In the BB window

The sidebar footer shows Hotspot's flame and labelled figures, `CPU 16%`
and `MEM 62%`. The flame is grey while calm, amber when warm or busy, red
when hot; a word (`Hot`, `Warm`, `Busy`) and the top thread's title join
the figures when they fit. In the usual 320px sidebar the two figures stack
on two lines with `Hot` beside them; narrower, the word goes, then MEM (or
CPU, when only memory is flagged). A figure never shows without its label.
A figure turns red at the CPU threshold, and MEM turns amber or red under
kernel memory pressure. Hovering shows the full line; clicking opens a
popover that leads with a verdict (running cool, warming up, working hard
or running hot, and the thread to blame), then heat, CPU, memory (with
swap) and load per core with a line for the last hour, then the five
busiest threads with CPU and memory, one line each (the title opens the
thread; "…" unfolds Stop turn and Kill processes…; threads under 1% CPU and
1 GB fold into "N idle threads"), other
busy processes, the last three episodes ("hot spells" in the UI; each
opens on the Hotspot page) and a link to the page. The page adds a memory
plot under the CPU timeline. On a phone the
indicator is in the sidebar drawer's footer and the popover is a bottom
sheet.

## Settings

Set with `bb plugin config hotspot set <key> <value>`:

| Key | Default | Range |
| --- | --- | --- |
| `sampleIntervalSeconds` | 60 | 15–3600 |
| `retentionDays` | 7 | 1–30 |
| `cpuThreshold` | 80 (% of all cores) | 10–100 |
| `toast` | true | show a toast in BB when an episode opens |
| `allowKill` | true | offer Kill processes; `false` hides the button and refuses `bb hotspot kill` |

## Limits

- Thread and process CPU is a share of the whole Mac (all cores = 100%). It
  comes from `ps`, which on macOS is a decaying average over about a minute,
  so a burst shows up late and fades slowly. Machine CPU is exact over the
  sample interval.
- Memory used is Activity Monitor's Memory Used (app + wired + compressed)
  over physical memory, read from `vm_stat` and `sysctl`; on Linux it is
  total minus `MemAvailable`, with no pressure level. A thread's memory is
  the resident size summed over its processes, so pages they share are
  counted more than once.
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
- Sampling only reads. The only signals Hotspot sends are the user's own
  kills, and it never renices anything. Stop turn interrupts a thread's
  running turn through BB, like BB's own stop button; the thread can be
  resumed.
- A process whose environment `ps` cannot read and whose parent has exited
  belongs to no thread, so a kill cannot reach it. In practice detached dev
  servers keep `BB_THREAD_ID` in their environment and are reachable.
