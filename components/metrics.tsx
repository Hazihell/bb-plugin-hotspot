// The numbers row on the popover and the page: heat, CPU, memory and load
// now, each over the last hour. One quiet stroke per metric on its own true
// scale (CPU and memory 0–100%, load from 0), and colour only on a number
// that crossed a line: CPU at the hot threshold, memory under kernel
// pressure, load above one per core, thermal above nominal.
import type { ReactNode } from "react";
import type { Status, TimelinePoint } from "../lib/contract";
import { bytesText, thermalLabel } from "../lib/labels";
import { pct } from "../lib/present";
import { cn } from "../lib/utils";
import { thermalSwatch } from "./heat";

type Alert = "warn" | "hot" | null;

const VALUE_ALERT: Record<Exclude<Alert, null>, string> = {
  warn: "text-[var(--warning-text)]",
  hot: "text-destructive",
};
const STROKE: Record<Exclude<Alert, null> | "calm", string> = {
  calm: "stroke-muted-foreground",
  warn: "stroke-[var(--warning)]",
  hot: "stroke-destructive",
};
const FILL: Record<Exclude<Alert, null> | "calm", string> = {
  calm: "fill-muted-foreground",
  warn: "fill-[var(--warning)]",
  hot: "fill-destructive",
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A last-hour line; gaps where nothing was sampled. `max` is the top of its true scale. */
function Spark({ values, max, alert }: { values: Array<number | null>; max: number; alert: Alert }) {
  const width = 100;
  const height = 20;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (value: number) => height - 1 - (Math.min(max, Math.max(0, value)) / max) * (height - 2);
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push([index * step, y(value)]);
  });
  if (run.length > 0) runs.push(run);
  const tone = alert ?? "calm";
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-5 w-full overflow-visible" aria-hidden="true">
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} className="stroke-border" vectorEffect="non-scaling-stroke" />
      {runs.map((points, index) => {
        const line = points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" L");
        if (points.length === 1) {
          const [[px, py]] = points;
          return <line key={index} x1={px - 1} x2={px + 1} y1={py} y2={py} strokeWidth={1.5} className={STROKE[tone]} vectorEffect="non-scaling-stroke" />;
        }
        const first = points[0][0].toFixed(1);
        const last = points[points.length - 1][0].toFixed(1);
        return (
          <g key={index}>
            <path d={`M${first},${height} L${line} L${last},${height} Z`} className={cn(FILL[tone], "opacity-10")} />
            <path
              d={`M${line}`}
              className={cn("fill-none", STROKE[tone], alert === null && "opacity-70")}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </svg>
  );
}

/** Thermal level per bucket as a strip of swatches; the same colours as the page chart. */
function HeatStrip({ levels }: { levels: Array<number | null> }) {
  return (
    <div className="flex h-5 items-center gap-px" aria-hidden="true">
      {levels.map((level, index) => (
        <span
          key={index}
          className={cn("h-2 min-w-0 flex-1 rounded-[1px]", level === null ? "bg-muted-foreground/10" : thermalSwatch(level))}
        />
      ))}
    </div>
  );
}

function Metric({
  label,
  value,
  alert,
  caption,
  note = null,
  description,
  size,
  children,
}: {
  label: string;
  value: string;
  alert: Alert;
  caption: string;
  /** A second caption line in the alert colour, for a state the colour alone must not carry. */
  note?: string | null;
  /** The whole cell in words, for screen readers and the hover title. */
  description: string;
  size: "sheet" | "page";
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={description} title={description} className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "truncate font-semibold text-foreground",
          size === "page" ? "text-xl" : "text-base",
          alert !== null && VALUE_ALERT[alert],
        )}
      >
        {value}
      </div>
      <div className="mt-1">{children}</div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{caption}</div>
      {note === null ? null : (
        <div className={cn("truncate text-[11px] font-medium", alert === null ? "text-muted-foreground" : VALUE_ALERT[alert])}>
          {note}
        </div>
      )}
    </div>
  );
}

const peakOf = (values: Array<number | null>) =>
  values.reduce<number | null>((peak, value) => (value === null ? peak : Math.max(peak ?? 0, value)), null);

/**
 * Heat, CPU, memory and load. Four columns; two on a narrow page. Renders
 * nothing before the first sample.
 */
export function MetricsRow({ status, size }: { status: Status | null; size: "sheet" | "page" }) {
  const latest = status?.latest ?? null;
  if (status === null || latest === null) return null;
  const recent: TimelinePoint[] = status.recent;
  const threshold = status.cpuThreshold;

  const thermal = latest.thermal;
  const heatAlert: Alert = thermal === null || thermal === 0 ? null : thermal === 1 ? "warn" : "hot";
  const levels = recent.map((point) => point.thermal);
  const peakHeat = peakOf(levels);

  const cpuValues = recent.map((point) => point.cpu);
  const cpuPeak = peakOf(cpuValues);
  const cpuAlert: Alert = latest.cpu >= threshold ? "hot" : null;

  const memory = latest.memory;
  const memValues = recent.map((point) => point.mem);
  const memAlert: Alert = memory?.pressure === "critical" ? "hot" : memory?.pressure === "warn" ? "warn" : null;
  const pressureNote =
    memory?.pressure === "critical" ? "critical" : memory?.pressure === "warn" ? "high pressure" : null;
  const memCaption = memory === null ? "not read yet" : `swap ${bytesText(memory.swapUsedBytes)}`;

  const loadValues = recent.map((point) => point.load);
  const loadPeak = peakOf(loadValues);
  const loadAlert: Alert = latest.load >= 1 ? "warn" : null;

  return (
    <div
      className={cn(
        "grid gap-x-4 gap-y-3",
        size === "page" ? "grid-cols-2 rounded-lg border border-border bg-card p-4 sm:grid-cols-4 sm:gap-x-6" : "grid-cols-4",
      )}
    >
      <Metric
        label="Heat"
        value={capitalize(thermalLabel(thermal))}
        alert={heatAlert}
        caption={peakHeat !== null && peakHeat > (thermal ?? 0) ? `1h peak ${thermalLabel(peakHeat)}` : "thermal level"}
        description={`Heat: thermal pressure ${thermalLabel(thermal)}${peakHeat === null ? "" : `; peak ${thermalLabel(peakHeat)} in the last hour`}`}
        size={size}
      >
        <HeatStrip levels={levels} />
      </Metric>
      <Metric
        label="CPU"
        value={pct(latest.cpu)}
        alert={cpuAlert}
        caption={cpuPeak === null ? `hot at ${pct(threshold)}` : `1h peak ${pct(cpuPeak)}`}
        description={`CPU ${pct(latest.cpu)} of all cores${cpuPeak === null ? "" : `; peak ${pct(cpuPeak)} in the last hour`}; hot at ${pct(threshold)}`}
        size={size}
      >
        <Spark values={cpuValues} max={100} alert={cpuAlert} />
      </Metric>
      <Metric
        label="Memory"
        value={memory === null ? "—" : pct(memory.percent)}
        alert={memAlert}
        caption={memCaption}
        note={pressureNote}
        description={
          memory === null
            ? "Memory: not read yet"
            : `Memory ${pct(memory.percent)} used (${bytesText(memory.usedBytes)} of ${bytesText(memory.totalBytes)}: app ${bytesText(memory.appBytes)}, wired ${bytesText(memory.wiredBytes)}, compressed ${bytesText(memory.compressedBytes)}); swap ${bytesText(memory.swapUsedBytes)}; pressure ${memory.pressure ?? "unknown"}`
        }
        size={size}
      >
        <Spark values={memValues} max={100} alert={memAlert} />
      </Metric>
      <Metric
        label="Load"
        value={latest.load.toFixed(2)}
        alert={loadAlert}
        caption={size === "page" && loadPeak !== null ? `per core · 1h peak ${loadPeak.toFixed(2)}` : "per core"}
        description={`Load ${latest.load.toFixed(2)} per core${loadPeak === null ? "" : `; peak ${loadPeak.toFixed(2)} in the last hour`}. Above 1, work waits for a core.`}
        size={size}
      >
        <Spark values={loadValues} max={Math.max(1, loadPeak ?? 0)} alert={loadAlert} />
      </Metric>
    </div>
  );
}
