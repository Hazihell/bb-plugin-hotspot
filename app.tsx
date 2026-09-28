// bb-plugin-hotspot — frontend entry.
//
// Four surfaces, all reading the server over RPC and refreshing on its
// realtime signals: the Hotspot page (verdict, timeline, hot spells and their
// culprits), a short badge on its sidebar row while the Mac is hot, the
// always-visible indicator and popover in the sidebar footer
// (components/footer-indicator), and an app-wide overlay that turns the
// server's "episode opened" signal into a toast. One more overlay holds the
// watch lease while the window is visible, which is what keeps live
// readings coming; the timeline and hot spells still change only when a
// sample is stored.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Episode, Range, Timeline, rpcContract } from "./lib/contract";
import { FooterIndicator } from "@/components/footer-indicator";
import { ErrorNote, SkeletonLine, VerdictBlock, thermalSwatch } from "@/components/heat";
import { MetricsRow } from "@/components/metrics";
import { MonitorButton, useOpenMonitor } from "@/components/monitor-button";
import { TimelineChart } from "@/components/timeline-chart";
import { useStatus, useWatchLease } from "@/hooks/use-status";
import { bytesText, thermalLabel } from "./lib/labels";
import { bbTotalTitle, clockText, cpuText, dayClockText, durationText, pct } from "./lib/present";
import { EPISODE_OPENED, type EpisodeOpenedSignal, SAMPLED } from "./lib/signals";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

function threadLabel(culprit: { threadId: string; title: string | null }): string {
  return culprit.title ?? culprit.threadId;
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

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
  return { timeline, error, refetch };
}

/** `episode/<id>` from the popover's recent list. */
function episodeFromSubPath(subPath: string): number | null {
  const match = /^episode\/(\d+)$/.exec(subPath);
  return match === null ? null : Number(match[1]);
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function EpisodeDetail({ episode, intervalMs }: { episode: Episode; intervalMs: number }) {
  const navigate = useBbNavigate();
  // Idle threads that only made the top five on a quiet sample are noise.
  const culprits = episode.culprits
    .filter((culprit, index) => index < 3 || culprit.cpuSum / Math.max(1, episode.samples) >= 0.5)
    .slice(0, 10);
  const others = episode.others.filter((other) => other.cpuSum / Math.max(1, episode.samples) >= 1).slice(0, 5);
  const minutes = (samples: number) => durationText(samples * intervalMs);
  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2 text-sm sm:px-4">
      {culprits.length === 0 ? (
        <p className="py-1.5 text-muted-foreground">No BB thread was busy during this hot spell.</p>
      ) : (
        <ol>
          {culprits.map((culprit, index) => (
            <li key={culprit.threadId}>
              <button
                type="button"
                className="group flex min-h-10 w-full items-center gap-3 rounded-md px-1 py-1.5 text-left outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:min-h-12"
                onClick={() => navigate.toThread(culprit.threadId)}
              >
                <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground group-hover:underline group-hover:underline-offset-4">
                    {threadLabel(culprit)}
                  </span>
                  <span className="block text-xs tabular-nums text-muted-foreground">
                    avg {pct(culprit.cpuSum / Math.max(1, episode.samples))} · peak {pct(culprit.peakCpu)}
                    {culprit.samples < episode.samples
                      ? ` · busy for ${minutes(culprit.samples)} of ${minutes(episode.samples)}`
                      : null}
                  </span>
                </span>
                <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ol>
      )}
      {others.length === 0 ? null : (
        <p className="px-1 pt-1 pb-1.5 text-xs text-muted-foreground">
          Also busy outside BB:{" "}
          {others.map((other) => `${other.name} avg ${pct(other.cpuSum / Math.max(1, episode.samples))}`).join(" · ")}
        </p>
      )}
    </div>
  );
}

function EpisodeList({
  episodes,
  selectedId,
  onSelect,
  intervalMs,
  range,
}: {
  episodes: Episode[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  intervalMs: number;
  range: Range;
}) {
  if (episodes.length === 0) {
    return (
      <EmptyState>
        No hot spells in the last {range === "24h" ? "24 hours" : "7 days"}. Your Mac stayed cool.
      </EmptyState>
    );
  }
  const now = Date.now();
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {episodes.map((episode) => {
        const open = episode.id === selectedId;
        const top = episode.culprits[0] ?? null;
        const end = episode.endAt ?? episode.lastHotAt;
        return (
          <li key={episode.id} id={`hotspot-episode-${episode.id}`} className="scroll-mt-4">
            <button
              type="button"
              aria-expanded={open}
              className={cn(
                "flex min-h-12 w-full items-center gap-3 px-3 py-2.5 text-left text-sm outline-none hover:bg-state-hover focus-visible:bg-state-hover sm:px-4",
                open && "bg-state-hover",
              )}
              onClick={() => onSelect(open ? null : episode.id)}
            >
              <Icon
                name="ChevronRight"
                className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
              />
              <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-4">
                <span className="flex shrink-0 items-baseline gap-2 sm:w-52">
                  <span className="font-medium text-foreground">{dayClockText(episode.startAt, now)}</span>
                  <span className="text-xs text-muted-foreground">
                    {episode.endAt === null ? (
                      <span className="font-medium text-destructive">still hot</span>
                    ) : (
                      durationText(end - episode.startAt)
                    )}
                  </span>
                </span>
                <span className="block min-w-0 truncate text-xs text-muted-foreground sm:flex-1 sm:text-sm sm:text-foreground">
                  {top === null ? "No BB thread to blame" : threadLabel(top)}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground sm:w-36 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className={cn("size-2 rounded-sm", thermalSwatch(episode.peakThermal))} />
                  {thermalLabel(episode.peakThermal)}
                </span>
                <span className="tabular-nums">peak {pct(episode.peakCpu)}</span>
              </span>
            </button>
            {open ? <EpisodeDetail episode={episode} intervalMs={intervalMs} /> : null}
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

function RangeToggle({ range, onChange }: { range: Range; onChange: (range: Range) => void }) {
  return (
    <div className="inline-flex rounded-md bg-muted p-0.5" role="group" aria-label="Range">
      {(["24h", "7d"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={range === option}
          onClick={() => onChange(option)}
          className="h-7 rounded-[5px] px-3 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-4 max-md:pointer-coarse:text-sm"
        >
          {option === "24h" ? "24 hours" : "7 days"}
        </button>
      ))}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Loading history">
      <SkeletonLine className="h-32 w-full rounded-md" />
      <SkeletonLine className="w-1/2" />
    </div>
  );
}

function HotspotPage({ subPath }: { subPath: string }) {
  const [range, setRange] = useState<Range>("24h");
  const [selectedId, setSelectedId] = useState<number | null>(() => episodeFromSubPath(subPath));
  const state = useStatus();
  const { status } = state;
  const { timeline, error, refetch } = useTimeline(range);
  const intervalMs = (status?.sampleIntervalSeconds ?? 60) * 1000;
  const monitor = useOpenMonitor();

  // A link from the popover selects an episode; widen to a week if it is older than a day.
  const linked = episodeFromSubPath(subPath);
  useEffect(() => {
    if (linked !== null) setSelectedId(linked);
  }, [linked]);
  useEffect(() => {
    if (selectedId === null || timeline === null) return;
    const found = timeline.episodes.some((episode) => episode.id === selectedId);
    if (!found && range === "24h" && selectedId === linked) setRange("7d");
    if (found) {
      document
        .getElementById(`hotspot-episode-${selectedId}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedId, timeline, range, linked]);

  const latest = status?.latest ?? null;
  const count = timeline?.episodes.length ?? 0;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl space-y-6 px-4 pb-8 pt-4 md:px-5 md:pt-6">
        {state.error !== null && status === null ? (
          <ErrorNote title="Can't read Hotspot right now" detail={state.error} onRetry={state.retry} />
        ) : (
          <div className="space-y-4">
            <VerdictBlock status={status} size="page" />
            <MetricsRow status={status} size="page" />
            {latest === null ? null : (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                <p className="min-w-0 flex-1 text-muted-foreground">
                  Checked {clockText(latest.at)}
                  {latest.bb == null ? null : (
                    <>
                      {" · "}
                      <span title={bbTotalTitle(latest.bb)} className="tabular-nums">
                        BB total {cpuText(latest.bb.cpu)} CPU, {bytesText(latest.bb.memBytes)}
                      </span>
                    </>
                  )}{" "}
                  · hot at {pct(status?.cpuThreshold ?? 80)} CPU · lines show the last hour
                </p>
                {monitor.error === null ? null : (
                  <p role="alert" className="text-destructive">
                    {monitor.error}
                  </p>
                )}
                {status?.monitor == null ? null : (
                  <MonitorButton monitor={status.monitor} onOpen={monitor.open} busy={monitor.busy} className="-my-1 -mr-1 px-1 py-1" />
                )}
              </div>
            )}
          </div>
        )}

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">CPU, memory and heat</h2>
            <RangeToggle range={range} onChange={setRange} />
          </div>
          {error === null ? null : <ErrorNote title="Couldn't load the history" detail={error} onRetry={refetch} />}
          {timeline === null ? (
            error === null ? <ChartSkeleton /> : null
          ) : (
            <TimelineChart
              timeline={timeline}
              cpuThreshold={status?.cpuThreshold ?? 80}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </section>

        {timeline === null ? null : (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">
              Hot spells
              {count === 0 ? null : <span className="ml-2 font-normal text-muted-foreground">{count}</span>}
            </h2>
            <EpisodeList
              episodes={timeline.episodes}
              selectedId={selectedId}
              onSelect={setSelectedId}
              intervalMs={intervalMs}
              range={range}
            />
          </section>
        )}

        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          A hot spell starts after three readings in a row with thermal pressure above nominal or CPU at the hot line,
          and ends after three normal ones. Thread CPU is a share of the whole Mac: the CPU time its processes used
          since the previous reading, every few seconds while BB is on screen. The chart and hot spells use one
          sample a minute. Memory is what Activity Monitor calls Memory Used (app, wired and compressed);
          it turns amber or red only when macOS reports memory pressure.
        </p>
      </div>
    </div>
  );
}

/** A short word on the sidebar row while the Mac is hot or warm; nothing otherwise. */
function SidebarBadge() {
  const { status } = useStatus();
  const latest = status?.latest ?? null;
  if (status?.open) {
    return (
      <span className="text-xs font-medium tabular-nums text-destructive">
        Hot{latest === null ? "" : ` ${pct(latest.cpu)}`}
      </span>
    );
  }
  const thermal = latest?.thermal ?? null;
  if (thermal !== null && thermal >= 1) {
    return <span className="text-xs font-medium text-[var(--warning-text)]">Warm</span>;
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
          ? `Since ${clockText(payload.startAt)}. No BB thread is the main cause.`
          : `Since ${clockText(payload.startAt)}, mostly from ${threadLabel(top)}.`,
      action:
        top === null
          ? { label: "See why", onClick: () => navigate.toPluginPanel("hotspot") }
          : { label: "Open thread", onClick: () => navigate.toThread(top.threadId) },
    });
  });
  return null;
}

/** Mounted once per window; asks for live readings while the window is visible. */
function WatchLease() {
  useWatchLease();
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
  app.slots.experimental_appOverlay({ id: "footer-indicator", component: FooterIndicator });
  app.slots.experimental_appOverlay({ id: "watch-lease", component: WatchLease });
});
