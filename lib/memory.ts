/**
 * Physical memory: how full it is, and how close the Mac is to paging.
 *
 * Adapted from Ballast's `lib/memory.ts`
 * (https://github.com/braedonsaunders/bb-plugin-ballast).
 * Copyright (c) Braedon Saunders. Licensed under the MIT License; see NOTICE.
 *
 * Changes from the original: one exec per reading instead of two, no swap
 * rate cursor, no headroom or compression ratio, and a used percentage.
 * Ballast's reason for reading `vm_stat` page classes stands: macOS's
 * `memory_pressure` "free percentage" counts inactive and speculative pages
 * as free and stays reassuring until the Mac is already swapping. "Used" is
 * Activity Monitor's Memory Used: app memory (anonymous pages minus
 * purgeable) plus wired plus compressed. The kernel's own pressure level
 * (normal, warn, critical) is what decides whether the number deserves a
 * colour. On Linux `/proc/meminfo` gives the same shape.
 */
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Memory } from "./schemas";

const run = promisify(exec);

/** Where the readings come from; injected so tests can fake any OS. */
export interface MemorySource {
  platform: NodeJS.Platform;
  exec(command: string): Promise<string>;
  readFile(path: string): Promise<string>;
}

export const systemMemorySource: MemorySource = {
  platform: process.platform,
  async exec(command) {
    const { stdout } = await run(command, { timeout: 5_000 });
    return stdout;
  },
  readFile: (path) => readFile(path, "utf8"),
};

const SYSCTL_MARK = "--sysctl--";
/** One shell for both readers; the marker splits their output. */
export const DARWIN_MEMORY = `vm_stat; echo ${SYSCTL_MARK}; sysctl -n hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level`;

/** `vm_stat` prints `Pages free: 11887.`; keys vary by OS version, values don't. */
export function parseVmStat(text: string): { pageSize: number; pages: Map<string, number> } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (match === null) continue;
    pages.set(match[1].trim().toLowerCase(), Number(match[2]));
  }
  return { pageSize, pages };
}

/** `total = 6144.00M  used = 5192.50M  free = 951.50M  (encrypted)` */
export function parseSwapUsage(text: string): { totalBytes: number; usedBytes: number } {
  const scale = (value: string, unit: string): number => {
    const n = Number(value);
    if (unit === "G") return n * 1024 ** 3;
    if (unit === "M") return n * 1024 ** 2;
    if (unit === "K") return n * 1024;
    return n;
  };
  const total = /total\s*=\s*([\d.]+)([KMG]?)/.exec(text);
  const used = /used\s*=\s*([\d.]+)([KMG]?)/.exec(text);
  return {
    totalBytes: total === null ? 0 : scale(total[1], total[2]),
    usedBytes: used === null ? 0 : scale(used[1], used[2]),
  };
}

/**
 * `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. The
 * same ladder drives the kernel's own jetsam decisions, so it beats any
 * threshold on the percentage.
 */
export function parsePressure(text: string): Memory["pressure"] {
  const value = Number(/(\d+)/.exec(text)?.[1] ?? Number.NaN);
  if (value === 4) return "critical";
  if (value === 2) return "warn";
  if (value === 1) return "normal";
  return null;
}

const percentOf = (part: number, total: number) =>
  total <= 0 ? 0 : Math.round(Math.min(100, Math.max(0, (part / total) * 100)) * 10) / 10;

/** The output of `DARWIN_MEMORY`. Null when it holds no total. */
export function parseDarwinMemory(stdout: string): Memory | null {
  const [vmStatText, sysctlText = ""] = stdout.split(SYSCTL_MARK);
  const { pageSize, pages } = parseVmStat(vmStatText);
  const [memsizeLine = "", swapLine = "", pressureLine = ""] = sysctlText.trim().split("\n");
  const totalBytes = Number(memsizeLine.trim());
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const bytes = (key: string) => (pages.get(key) ?? 0) * pageSize;
  // Purgeable pages are anonymous too, but the kernel may drop them on
  // demand, so they are not "app memory".
  const appBytes = Math.max(0, bytes("anonymous pages") - bytes("pages purgeable"));
  const wiredBytes = bytes("pages wired down");
  const compressedBytes = bytes("pages occupied by compressor");
  const usedBytes = appBytes + wiredBytes + compressedBytes;
  return {
    percent: percentOf(usedBytes, totalBytes),
    totalBytes,
    usedBytes,
    appBytes,
    wiredBytes,
    compressedBytes,
    swapUsedBytes: parseSwapUsage(swapLine).usedBytes,
    pressure: parsePressure(pressureLine),
  };
}

/** `/proc/meminfo`: every value is in kB. Null when it holds no total. */
export function parseMeminfo(text: string): Memory | null {
  const info = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([^:]+):\s+(\d+)\s*kB/.exec(line);
    if (match !== null) info.set(match[1].toLowerCase(), Number(match[2]) * 1024);
  }
  const get = (key: string) => info.get(key) ?? 0;
  const totalBytes = get("memtotal");
  if (totalBytes <= 0) return null;
  // MemAvailable is the kernel's own estimate of what a new allocation can
  // get without swapping; used is everything else.
  const available = info.has("memavailable")
    ? get("memavailable")
    : get("memfree") + get("cached") + get("buffers");
  const usedBytes = Math.max(0, totalBytes - available);
  const compressedBytes = get("zswap");
  return {
    percent: percentOf(usedBytes, totalBytes),
    totalBytes,
    usedBytes,
    appBytes: Math.max(0, usedBytes - compressedBytes - get("sunreclaim")),
    wiredBytes: get("sunreclaim"),
    compressedBytes,
    swapUsedBytes: Math.max(0, get("swaptotal") - get("swapfree")),
    pressure: null,
  };
}

/** One reading: one shell on macOS, one file read on Linux. Throws when the reader fails. */
export async function readMemory(source: MemorySource = systemMemorySource): Promise<Memory | null> {
  if (source.platform === "darwin") return parseDarwinMemory(await source.exec(DARWIN_MEMORY));
  return parseMeminfo(await source.readFile("/proc/meminfo"));
}
