// CPU over the range as one area series on a 0–100% axis, with the thermal
// level as its own strip underneath and hot episodes shaded; memory used is
// a second, shorter plot below on its own 0–100% axis (never a second y-axis
// on one plot), sharing the time axis and the crosshair. Drawn at the measured pixel width so text and strokes stay crisp.
// A mouse hovers; a finger taps or drags; the keyboard steps with the arrows.
// Selecting picks the nearest episode, with a finger-sized tolerance.
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Timeline } from "../lib/contract";
import { thermalLabel } from "../lib/labels";
import { clockText, dayClockText, episodeNear, gapLabel, pct, timeTicks } from "../lib/present";
import { cn } from "../lib/utils";
import { thermalFill, thermalSwatch } from "./heat";

const GUTTER = 36;
const RIGHT = 8;
const STRIP_H = 8;
const STRIP_GAP = 6;
const TICKS_H = 20;
/** Space between the heat strip and the memory plot. */
const MEM_GAP = 14;
/** How far (px) a tap may land from a hot band and still select it. */
const TAP_SLOP = { mouse: 6, touch: 18 } as const;

type Point = Timeline["points"][number];

/** One path per run of sampled buckets, so sleep and "not yet recording" show as gaps. */
function sampledRuns(points: Point[], bucketMs: number, value: (point: Point) => number | null) {
  const out: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  for (const point of points) {
    const reading = value(point);
    if (reading === null) {
      if (run.length > 0) out.push(run);
      run = [];
    } else run.push([point.at + bucketMs / 2, reading]);
  }
  if (run.length > 0) out.push(run);
  return out;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function TimelineChart({
  timeline,
  cpuThreshold,
  selectedId,
  onSelect,
}: {
  timeline: Timeline;
  cpuThreshold: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const { from, to, bucketMs, points, episodes } = timeline;
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [touch, setTouch] = useState(false);
  const compact = width > 0 && width < 520;
  const plotH = compact ? 132 : 176;
  const memH = compact ? 48 : 64;
  const plotW = Math.max(1, width - GUTTER - RIGHT);
  const stripBottom = plotH + STRIP_GAP + STRIP_H;
  const memTop = stripBottom + MEM_GAP;
  const memBottom = memTop + memH;
  const height = memBottom + TICKS_H;
  const span = to - from;
  const x = (at: number) => GUTTER + ((at - from) / span) * plotW;
  const y = (cpu: number) => plotH - (Math.min(100, Math.max(0, cpu)) / 100) * (plotH - 2);
  const yMem = (mem: number) => memBottom - (Math.min(100, Math.max(0, mem)) / 100) * (memH - 2);

  const runs = useMemo(() => sampledRuns(points, bucketMs, (point) => point.cpu), [points, bucketMs]);
  const memRuns = useMemo(() => sampledRuns(points, bucketMs, (point) => point.mem), [points, bucketMs]);
  const hasMemory = memRuns.length > 0;

  const firstSampled = points.findIndex((point) => point.cpu !== null);
  const firstX = firstSampled === -1 ? null : x(points[firstSampled].at);
  const gap = firstSampled === 0 ? null : gapLabel(GUTTER, GUTTER + plotW, firstX, firstSampled === -1 ? null : points[firstSampled].at);
  const ticks = timeTicks(from, to, Math.max(3, Math.floor(plotW / (compact ? 64 : 88))));
  const hovered = hover === null ? null : (points[hover] ?? null);
  const hoveredEpisode =
    hovered === null ? null : episodeNear(episodes, hovered.at + bucketMs / 2, bucketMs / 2, to);

  const indexAtClientX = (clientX: number, element: Element) => {
    const rect = element.getBoundingClientRect();
    const ratio = (clientX - rect.left - GUTTER) / plotW;
    if (ratio < 0 || ratio > 1) return null;
    return Math.min(points.length - 1, Math.floor(ratio * points.length));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    setTouch(event.pointerType !== "mouse");
    const index = indexAtClientX(event.clientX, event.currentTarget);
    if (index !== null) setHover(index);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const index = indexAtClientX(event.clientX, event.currentTarget);
    if (index === null) return;
    // A tap has no hover, so it also pins the reading under the finger.
    setTouch(event.pointerType !== "mouse");
    setHover(index);
    const slopMs = (TAP_SLOP[event.pointerType === "mouse" ? "mouse" : "touch"] / plotW) * span;
    const episode = episodeNear(episodes, points[index].at + bucketMs / 2, slopMs + bucketMs / 2, to);
    onSelect(episode?.id ?? null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = points.length - 1;
    const current = hover ?? last;
    const step = event.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = Math.max(0, current - step);
    else if (event.key === "ArrowRight") next = Math.min(last, current + step);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Enter" || event.key === " ") {
      const episode = hovered === null ? null : episodeNear(episodes, hovered.at + bucketMs / 2, bucketMs, to);
      onSelect(episode?.id ?? null);
    } else if (event.key === "Escape") setHover(null);
    else return;
    event.preventDefault();
    if (next !== null) {
      setTouch(false);
      setHover(next);
    }
  };

  const hoverX = hovered === null ? 0 : x(hovered.at + bucketMs / 2);
  const leftHalf = hoverX < GUTTER + plotW / 2;

  return (
    <div className="rounded-lg border border-border bg-card px-3 pt-3 pb-2">
      <div
        ref={ref}
        role="group"
        tabIndex={0}
        aria-label="CPU and memory over time. Use the arrow keys to step through it and Enter to open a hot spell."
        className="relative touch-pan-y select-none rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        style={{ height }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setHover(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
      >
        {width === 0 ? null : (
          <svg width={width} height={height} className="absolute inset-0 overflow-visible" aria-hidden="true">
            {[0, 50, 100].map((grid) => (
              <g key={grid}>
                <line x1={GUTTER} x2={GUTTER + plotW} y1={y(grid)} y2={y(grid)} className="stroke-border" />
                <text
                  x={GUTTER - 6}
                  y={y(grid)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px] tabular-nums"
                >
                  {grid === 0 ? "0" : `${grid}%`}
                </text>
              </g>
            ))}

            {episodes.map((episode) => {
              const start = x(Math.max(from, episode.startAt));
              const end = x(Math.min(to, episode.endAt ?? to));
              const selected = episode.id === selectedId;
              return (
                <g key={episode.id}>
                  <rect
                    x={start}
                    width={Math.max(3, end - start)}
                    y={0}
                    height={plotH}
                    className={cn("fill-destructive", selected ? "opacity-25" : "opacity-10")}
                  />
                  <rect x={start} width={Math.max(3, end - start)} y={0} height={3} rx={1} className="fill-destructive" />
                </g>
              );
            })}

            {firstSampled === 0 ? null : (
              <rect
                x={GUTTER}
                width={Math.max(0, (firstX ?? GUTTER + plotW) - GUTTER)}
                y={0}
                height={plotH}
                className="fill-muted-foreground opacity-[0.06]"
              />
            )}
            {gap === null ? null : (
              <text x={gap.x} y={plotH / 2} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                {gap.text}
              </text>
            )}

            {runs.map((run, index) => {
              const line = run.map(([at, cpu]) => `${x(at).toFixed(1)},${y(cpu).toFixed(1)}`).join(" L");
              const area = `M${x(run[0][0]).toFixed(1)},${plotH} L${line} L${x(run[run.length - 1][0]).toFixed(1)},${plotH} Z`;
              return (
                <g key={index}>
                  <path d={area} className="fill-primary opacity-10" />
                  <path d={`M${line}`} className="fill-none stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}

            <line
              x1={GUTTER}
              x2={GUTTER + plotW}
              y1={y(cpuThreshold)}
              y2={y(cpuThreshold)}
              className="stroke-destructive opacity-70"
              strokeDasharray="4 4"
            />
            <text
              x={GUTTER + 4}
              y={y(cpuThreshold) - 4}
              textAnchor="start"
              className="fill-muted-foreground text-[10px]"
            >
              Hot at {pct(cpuThreshold)}
            </text>

            <text
              x={GUTTER + 4}
              y={10}
              className="fill-muted-foreground stroke-card text-[10px] font-medium"
              strokeWidth={3}
              paintOrder="stroke"
            >
              CPU
            </text>

            <text
              x={GUTTER - 6}
              y={plotH + STRIP_GAP + STRIP_H / 2}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              Heat
            </text>

            {[0, 100].map((grid) => (
              <g key={`mem-${grid}`}>
                <line x1={GUTTER} x2={GUTTER + plotW} y1={yMem(grid)} y2={yMem(grid)} className="stroke-border" />
                <text
                  x={GUTTER - 6}
                  y={yMem(grid)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px] tabular-nums"
                >
                  {grid === 0 ? "0" : "100%"}
                </text>
              </g>
            ))}
            {memRuns.map((run, index) => {
              const line = run.map(([at, mem]) => `${x(at).toFixed(1)},${yMem(mem).toFixed(1)}`).join(" L");
              const area = `M${x(run[0][0]).toFixed(1)},${memBottom} L${line} L${x(run[run.length - 1][0]).toFixed(1)},${memBottom} Z`;
              return (
                <g key={index}>
                  <path d={area} className="fill-primary opacity-10" />
                  <path d={`M${line}`} className="fill-none stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}
            <text
              x={GUTTER + 4}
              y={memTop + 10}
              className="fill-muted-foreground stroke-card text-[10px] font-medium"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {hasMemory ? "Memory used" : "Memory used · no readings in this range yet"}
            </text>
            {points.map((point) =>
              point.thermal === null ? null : (
                <rect
                  key={point.at}
                  x={x(point.at)}
                  width={Math.max(1, (bucketMs / span) * plotW + 0.5)}
                  y={plotH + STRIP_GAP}
                  height={STRIP_H}
                  className={thermalFill(point.thermal)}
                />
              ),
            )}

            {ticks.map((tick) => {
              const tx = x(tick.at);
              const anchor = tx - GUTTER < 16 ? "start" : GUTTER + plotW - tx < 16 ? "end" : "middle";
              return (
                <g key={tick.at}>
                  <line x1={tx} x2={tx} y1={memBottom} y2={memBottom + 3} className="stroke-border" />
                  <text
                    x={tx}
                    y={height - 4}
                    textAnchor={anchor}
                    className="fill-muted-foreground text-[10px] tabular-nums"
                  >
                    {tick.label}
                  </text>
                </g>
              );
            })}

            {hovered === null ? null : (
              <g>
                <line x1={hoverX} x2={hoverX} y1={0} y2={memBottom} className="stroke-foreground opacity-40" />
                {hovered.cpu === null ? null : (
                  <circle cx={hoverX} cy={y(hovered.cpu)} r={4} strokeWidth={2} className="fill-primary stroke-card" />
                )}
                {hovered.mem === null ? null : (
                  <circle cx={hoverX} cy={yMem(hovered.mem)} r={4} strokeWidth={2} className="fill-primary stroke-card" />
                )}
              </g>
            )}
          </svg>
        )}

        {hovered === null ? null : (
          <div
            className="pointer-events-none absolute top-1 z-10 w-max max-w-[12rem] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
            style={leftHalf ? { left: hoverX + 10 } : { right: width - hoverX + 10 }}
          >
            <div className="text-sm font-semibold tabular-nums">
              {hovered.cpu === null ? "No reading" : `${pct(hovered.cpu)} CPU`}
            </div>
            <div className="text-muted-foreground">
              {dayClockText(hovered.at, Date.now())}–{clockText(hovered.at + bucketMs)}
            </div>
            {hovered.mem === null ? null : <div className="tabular-nums">{pct(hovered.mem)} memory</div>}
            {hovered.thermal === null ? null : (
              <div className="text-muted-foreground">Heat: {thermalLabel(hovered.thermal)}</div>
            )}
            {hoveredEpisode === null ? null : (
              <div className="mt-1 font-medium text-destructive">Hot spell · {touch ? "tap" : "click"} for details</div>
            )}
          </div>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" style={{ paddingLeft: GUTTER }}>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-3 w-2.5 rounded-sm bg-destructive/20 shadow-[inset_0_2px_0_var(--destructive)]" />
          Hot spell
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="sr-only">Heat:</span>
          {[0, 1, 2, 3].map((level) => (
            <span key={level} className="inline-flex items-center gap-1 pr-1.5">
              <span aria-hidden="true" className={cn("size-2.5 rounded-sm", thermalSwatch(level))} />
              {thermalLabel(level)}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
