Find out when your Mac ran hot and which BB thread caused it, without
watching Activity Monitor.

## What you get

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
server. It only reads: it never slows, stops or changes a process, and it
needs no account, root access or network service.
