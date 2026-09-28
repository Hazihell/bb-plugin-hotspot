// bb-plugin-hotspot — frontend entry.
//
// Three surfaces, all reading the server over RPC and refreshing on its
// realtime signals: the Hotspot page (timeline + episodes + culprits), a
// one-word badge on its sidebar row while the Mac is hot, and an app-wide
// overlay that turns the server's "episode opened" signal into a toast.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Episode, Range, Status, Timeline, rpcContract } from "./lib/contract";
import { EPISODE_OPENED, type EpisodeOpenedSignal, SAMPLED } from "./lib/signals";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const THERMAL_LABELS = ["nominal", "moderate", "heavy", "trapping", "sleeping"];

function thermalLabel(level: number | null): string {
  return level === null ? "unknown" : (THERMAL_LABELS[level] ?? `level ${level}`);
}

/** Status colors for the thermal strip; always shown beside a text label. */
function thermalClass(level: number | null): string {
  if (level === null) return "bg-transparent";
  if (level === 0) return "bg-muted-foreground/20";
  if (level === 1) return "bg-amber-400";
  if (level === 2) return "bg-orange-500";
  return "bg-destructive";
}

const pct = (value: number) => `${Math.round(value)}%`;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayClock(at: number): string {
  return new Date(at).toLocaleString([], {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function threadLabel(culprit: { threadId: string; title: string | null }): string {
  return culprit.title ?? culprit.threadId;
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

function useStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const refetch = useCallback(() => {
    rpc.call("status").then(setStatus, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(SAMPLED, refetch);
  return status;
}

function useTimeline(range: Range) {
  const rpc = useRpc<typeof rpcContract>();
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("timeline", { range }).then(
      (next) => {
        setTimeline(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, range]);
  useEffect(refetch, [refetch]);
  useRealtime(SAMPLED, refetch);
  return { timeline, error };
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-lg font-medium tabular-nums">{value}</div>
      {detail === undefined ? null : (
        <div className="truncate text-xs text-muted-foreground">{detail}</div>
      )}
    </div>
  );
}

function NowStrip({ status }: { status: Status | null }) {
  const latest = status?.latest ?? null;
  if (latest === null) {
    return <EmptyState>Waiting for the first sample…</EmptyState>;
  }
  const top = latest.threads[0] ?? null;
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Stat
        label="Thermal pressure"
        value={
          <span className="inline-flex items-center gap-2">
            <span className={cn("size-2.5 rounded-full", thermalClass(latest.thermal))} />
            {thermalLabel(latest.thermal)}
          </span>
        }
        detail={status?.open ? `Hot since ${clock(status.open.startAt)}` : `at ${clock(latest.at)}`}
      />
      <Stat label="CPU" value={pct(latest.cpu)} detail={`threshold ${pct(status?.cpuThreshold ?? 80)}`} />
      <Stat label="Load per core" value={latest.load.toFixed(2)} detail="1-minute average" />
      <Stat
        label="Busiest thread"
        value={top === null ? "none" : pct(top.cpu)}
        detail={top === null ? "no thread is using CPU" : threadLabel(top)}
      />
    </div>
  );
}

const CHART_W = 1000;
const CHART_H = 160;

/**
 * CPU over the range as one area series on a 0–100% axis, with the thermal
 * level as a separate strip underneath (never a second y-axis). Episodes are
 * shaded; hovering shows the bucket, clicking inside an episode selects it.
 */
function TimelineChart({
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
  const span = to - from;
  const x = useCallback((at: number) => ((at - from) / span) * CHART_W, [from, span]);
  const y = (cpu: number) => CHART_H - (cpu / 100) * CHART_H;
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  // One path per run of sampled buckets, so sleep shows as a gap.
  const areas = useMemo(() => {
    const runs: string[] = [];
    let run: Array<[number, number]> = [];
    const flush = () => {
      if (run.length > 0) {
        const line = run.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" L");
        runs.push(`M${run[0][0].toFixed(1)},${CHART_H} L${line} L${run[run.length - 1][0].toFixed(1)},${CHART_H} Z`);
      }
      run = [];
    };
    for (const point of points) {
      if (point.cpu === null) flush();
      else run.push([x(point.at + bucketMs / 2), CHART_H - (point.cpu / 100) * CHART_H]);
    }
    flush();
    return runs;
  }, [points, bucketMs, x]);

  const indexAt = (event: MouseEvent<HTMLDivElement>) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return null;
    const ratio = Math.min(0.9999, Math.max(0, (event.clientX - rect.left) / rect.width));
    return Math.floor(ratio * points.length);
  };
  const episodeAt = (at: number) =>
    episodes.find((episode) => at + bucketMs >= episode.startAt && at <= (episode.endAt ?? to)) ?? null;

  const hovered = hover === null ? null : (points[hover] ?? null);
  const hoveredEpisode = hovered === null ? null : episodeAt(hovered.at);
  const tickCount = span > 2 * 86_400_000 ? 7 : 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => from + (span * index) / tickCount);

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex gap-2">
        <div className="relative w-8 shrink-0 text-right text-[10px] text-muted-foreground" style={{ height: CHART_H }}>
          <span className="absolute right-0 top-0 -translate-y-1/2">100%</span>
          <span className="absolute right-0 top-1/2 -translate-y-1/2">50%</span>
          <span className="absolute bottom-0 right-0 translate-y-1/2">0%</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            ref={plotRef}
            className="relative cursor-crosshair"
            style={{ height: CHART_H }}
            onMouseMove={(event) => setHover(indexAt(event))}
            onMouseLeave={() => setHover(null)}
            onClick={(event) => {
              const index = indexAt(event);
              const point = index === null ? null : points[index];
              const episode = point ? episodeAt(point.at) : null;
              onSelect(episode?.id ?? null);
            }}
          >
            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full overflow-visible"
              aria-label="CPU over time"
              role="img"
            >
              {[0, 50, 100].map((grid) => (
                <line
                  key={grid}
                  x1={0}
                  x2={CHART_W}
                  y1={y(grid)}
                  y2={y(grid)}
                  className="stroke-border"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {episodes.map((episode) => (
                <rect
                  key={episode.id}
                  x={x(episode.startAt)}
                  width={Math.max(x(from + bucketMs), x(episode.endAt ?? to) - x(episode.startAt))}
                  y={0}
                  height={CHART_H}
                  className={cn(
                    "fill-destructive",
                    episode.id === selectedId ? "opacity-25" : "opacity-10",
                  )}
                />
              ))}
              {areas.map((d, index) => (
                <path
                  key={index}
                  d={d}
                  className="fill-primary/15 stroke-primary"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <line
                x1={0}
                x2={CHART_W}
                y1={y(cpuThreshold)}
                y2={y(cpuThreshold)}
                className="stroke-destructive"
                strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke"
              />
              {hovered === null ? null : (
                <line
                  x1={x(hovered.at + bucketMs / 2)}
                  x2={x(hovered.at + bucketMs / 2)}
                  y1={0}
                  y2={CHART_H}
                  className="stroke-foreground/40"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {hovered === null ? null : (
              <div
                className="pointer-events-none absolute top-1 z-10 w-44 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md"
                style={
                  hover !== null && hover > points.length / 2
                    ? { right: `${100 - (hover / points.length) * 100 + 1}%` }
                    : { left: `${((hover ?? 0) / points.length) * 100 + 1}%` }
                }
              >
                <div className="font-medium">
                  {dayClock(hovered.at)}–{clock(hovered.at + bucketMs)}
                </div>
                <div className="text-muted-foreground">
                  CPU peak {hovered.cpu === null ? "no data" : pct(hovered.cpu)}
                </div>
                <div className="text-muted-foreground">Thermal {thermalLabel(hovered.thermal)}</div>
                {hoveredEpisode === null ? null : (
                  <div className="mt-1 text-destructive">Hot episode · click for culprits</div>
                )}
              </div>
            )}
          </div>
          <div className="mt-1.5 flex h-2.5 overflow-hidden rounded-sm" aria-label="Thermal pressure over time">
            {points.map((point) => (
              <div key={point.at} className={cn("h-full flex-1", thermalClass(point.thermal))} />
            ))}
          </div>
          <div className="relative mt-1 h-4 text-[10px] text-muted-foreground">
            {ticks.map((tick, index) => (
              <span
                key={tick}
                className={cn(
                  "absolute whitespace-nowrap",
                  index === 0 ? "" : index === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
                )}
                style={{ left: `${(index / tickCount) * 100}%` }}
              >
                {span > 2 * 86_400_000 ? dayClock(tick) : clock(tick)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-10 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 bg-primary" /> CPU (bucket peak)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-destructive/20" /> Hot episode
        </span>
        <span className="inline-flex items-center gap-1.5">Thermal:</span>
        {[0, 1, 2, 3].map((level) => (
          <span key={level} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-sm", thermalClass(level))} />
            {thermalLabel(level)}
          </span>
        ))}
      </div>
    </div>
  );
}

function EpisodeDetail({ episode }: { episode: Episode }) {
  const navigate = useBbNavigate();
  // Idle threads that only made the top five on a quiet sample are noise.
  const culprits = episode.culprits
    .filter((culprit, index) => index < 3 || culprit.cpuSum / Math.max(1, episode.samples) >= 0.5)
    .slice(0, 10);
  const others = episode.others.slice(0, 5);
  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3 text-sm">
      {culprits.length === 0 ? (
        <p className="text-muted-foreground">No BB thread was busy during this episode.</p>
      ) : (
        <ol className="space-y-1.5">
          {culprits.map((culprit, index) => (
            <li key={culprit.threadId} className="flex items-center gap-3">
              <span className="w-4 shrink-0 text-right text-xs text-muted-foreground">{index + 1}</span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-primary underline-offset-4 hover:underline"
                onClick={() => navigate.toThread(culprit.threadId)}
              >
                {threadLabel(culprit)}
              </button>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                avg {pct(culprit.cpuSum / Math.max(1, episode.samples))} · peak {pct(culprit.peakCpu)} ·{" "}
                {culprit.samples}/{episode.samples} samples
              </span>
            </li>
          ))}
        </ol>
      )}
      {others.length === 0 ? null : (
        <p className="mt-3 text-xs text-muted-foreground">
          Outside BB threads:{" "}
          {others
            .map((other) => `${other.name} avg ${pct(other.cpuSum / Math.max(1, episode.samples))}`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

function EpisodeList({
  episodes,
  selectedId,
  onSelect,
}: {
  episodes: Episode[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  if (episodes.length === 0) {
    return <EmptyState>No hot episodes in this range.</EmptyState>;
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {episodes.map((episode) => {
        const open = episode.id === selectedId;
        const top = episode.culprits[0] ?? null;
        const end = episode.endAt ?? episode.lastHotAt;
        return (
          <li key={episode.id}>
            <button
              type="button"
              aria-expanded={open}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-state-hover"
              onClick={() => onSelect(open ? null : episode.id)}
            >
              <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 shrink-0 text-muted-foreground" />
              <span className="w-36 shrink-0 tabular-nums">
                {dayClock(episode.startAt)}
                {episode.endAt === null ? <span className="ml-1.5 text-destructive">now</span> : null}
              </span>
              <span className="hidden w-20 shrink-0 text-muted-foreground sm:inline">
                {duration(end - episode.startAt)}
              </span>
              <span className="hidden w-28 shrink-0 items-center gap-1.5 text-muted-foreground md:inline-flex">
                <span className={cn("size-2 rounded-full", thermalClass(episode.peakThermal))} />
                {thermalLabel(episode.peakThermal)}
              </span>
              <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{pct(episode.peakCpu)} CPU</span>
              <span className="min-w-0 flex-1 truncate">{top === null ? "no thread" : threadLabel(top)}</span>
            </button>
            {open ? <EpisodeDetail episode={episode} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function HotspotPage() {
  const [range, setRange] = useState<Range>("24h");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const status = useStatus();
  const { timeline, error } = useTimeline(range);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <NowStrip status={status} />
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">History</h2>
          <div className="flex gap-1" role="group" aria-label="Range">
            {(["24h", "7d"] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant="ghost"
                aria-pressed={range === option}
                onClick={() => setRange(option)}
              >
                {option === "24h" ? "24 hours" : "7 days"}
              </Button>
            ))}
          </div>
        </div>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {timeline === null ? (
          <EmptyState>Loading history…</EmptyState>
        ) : (
          <>
            <TimelineChart
              timeline={timeline}
              cpuThreshold={status?.cpuThreshold ?? 80}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <h2 className="text-sm font-medium">Hot episodes</h2>
            <EpisodeList episodes={timeline.episodes} selectedId={selectedId} onSelect={setSelectedId} />
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Hot means thermal pressure above nominal or CPU at the threshold for three samples in a row.
          Thread CPU is a share of the whole Mac; it comes from <code>ps</code>, which averages over
          about a minute.
        </p>
      </div>
    </div>
  );
}

/** One word on the sidebar row while the Mac is hot; nothing otherwise. */
function SidebarBadge() {
  const status = useStatus();
  if (status?.open) return <span className="text-xs font-medium text-destructive">Hot</span>;
  const thermal = status?.latest?.thermal ?? null;
  if (thermal !== null && thermal >= 1) {
    return <span className="text-xs text-amber-500">{thermalLabel(thermal)}</span>;
  }
  return null;
}

function isEpisodeOpenedSignal(value: unknown): value is EpisodeOpenedSignal {
  if (typeof value !== "object" || value === null) return false;
  const signal = value as Partial<EpisodeOpenedSignal>;
  return typeof signal.id === "number" && typeof signal.startAt === "number";
}

/** Mounted once per window; turns the server's signal into a host toast. */
function HotspotToaster() {
  const navigate = useBbNavigate();
  useRealtime(EPISODE_OPENED, (payload) => {
    if (!isEpisodeOpenedSignal(payload)) return;
    const top = payload.top;
    toast.warning("Your Mac is running hot", {
      description:
        top === null
          ? `Since ${clock(payload.startAt)}. No BB thread is the main cause.`
          : `Since ${clock(payload.startAt)}. Top thread: ${threadLabel(top)}.`,
      action:
        top === null
          ? { label: "Hotspot", onClick: () => navigate.toPluginPanel("hotspot") }
          : { label: "Open thread", onClick: () => navigate.toThread(top.threadId) },
    });
  });
  return null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "hotspot",
    title: "Hotspot",
    icon: "Flame",
    path: "hotspot",
    component: HotspotPage,
    experimental_sidebarAccessory: SidebarBadge,
  });
  app.slots.experimental_appOverlay({ id: "episode-toasts", component: HotspotToaster });
});
