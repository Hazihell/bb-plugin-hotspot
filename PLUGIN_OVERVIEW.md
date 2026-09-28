Find out when your Mac ran hot and which BB thread caused it, without
watching Activity Monitor.

## What you get

- A live readout in the sidebar footer: a heat dot, CPU, and the busiest
  thread while the Mac is hot. Click it to open a thread, stop its running
  turn, or kill the dev servers and builds it left running, after a
  confirmation that lists exactly what gets stopped.
- A **Hotspot** page with a 24-hour and 7-day timeline of CPU and macOS
  thermal pressure, with hot episodes highlighted.
- For each episode, the BB threads that used the most CPU during it, linked
  so you can jump straight to them.
- A toast when your Mac starts running hot, naming the thread responsible.
- `bb hotspot status` and `bb hotspot episodes` in a terminal, and a
  `hotspot_history` tool so you can ask an agent "why was my Mac hot at 3pm?".

## How it works

Hotspot samples once a minute using `ps`, `notifyutil` and the kernel's CPU
counters, and keeps seven days of history in its own database on the BB
server. Sampling only reads, and it needs no account, root access or
network service. The only processes it ever signals are the ones you
confirm in a kill plan: a thread's own work, never its agent, BB, your apps
or system processes. Turn that off with the `allowKill` setting.
