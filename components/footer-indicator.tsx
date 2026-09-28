// The always-visible Hotspot indicator in the app sidebar footer, and the
// popover it opens.
//
// BB's footer slot draws only a fixed icon, so the indicator is mounted the
// way other live footer readouts are (usage-tracker): an app overlay keeps one
// <li> in the footer's menu row, re-attaching it when BB re-renders the
// sidebar, and portals React into it. The <li> carries this plugin's scope
// attributes so its Tailwind classes apply. The server decides every kill;
// this file only shows a plan and returns the plan id it was given.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Episode, KillPlanView, Overview, rpcContract } from "../lib/contract";
import { footerView } from "../lib/footer";
import { thermalLabel } from "../lib/labels";
import { usePortalScopeProps } from "../lib/portal-scope";
import { cpuText, dayClockText, durationText, pct, threadMeta } from "../lib/present";
import { SAMPLED } from "../lib/signals";
import { cn } from "../lib/utils";
import { type StatusState, useStatus } from "../hooks/use-status";
import { ErrorNote, HeatDot, SkeletonLine, VerdictBlock, thermalSwatch } from "./heat";
import { KillConfirm } from "./kill-confirm";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Touch targets grow to 44px on a phone. */
const TOUCH = "max-md:pointer-coarse:h-11";

/** The first sidebar footer menu that is laid out (the desktop sidebar or the open drawer). */
function visibleFooterMenu(): HTMLElement | null {
  const footers = Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar="footer"]'));
  const footer = footers.find((element) => element.getClientRects().length > 0) ?? footers[0] ?? null;
  return footer?.querySelector<HTMLElement>(':scope > [data-sidebar="menu"]') ?? null;
}

/**
 * One <li> kept in the footer's menu row for as long as the overlay is
 * mounted. Removed, and its observer and frame cancelled, on unmount.
 */
function useFooterSlot(): HTMLLIElement | null {
  const scope = usePortalScopeProps();
  const [slot, setSlot] = useState<HTMLLIElement | null>(null);
  const pluginId = scope["data-bb-plugin"];
  useEffect(() => {
    const item = document.createElement("li");
    item.setAttribute("data-sidebar", "menu-item");
    item.setAttribute("data-hotspot-footer", "");
    item.setAttribute("data-bb-plugin-root", "");
    if (pluginId !== undefined) item.setAttribute("data-bb-plugin", pluginId);
    // Basis 0: the readout takes the row's spare width and truncates, and
    // never makes BB's wrapping footer row spill onto a second line.
    item.style.flex = "1 1 0%";
    item.style.minWidth = "0";
    // Watch only the footer's parent once the item is placed, so streamed
    // chat output never reaches this observer; watch the whole body only
    // while the footer is missing. A slow check covers what neither sees:
    // the sidebar itself replaced, or a drawer footer becoming the visible one.
    let frame = 0;
    let watched: Node | null = null;
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(ensure);
    });
    function ensure() {
      frame = 0;
      if (!item.isConnected || item.getClientRects().length === 0) {
        const menu = visibleFooterMenu();
        if (menu !== null && item.parentElement !== menu) menu.appendChild(item);
      }
      const parent = item.isConnected ? (item.closest('[data-sidebar="footer"]')?.parentElement ?? null) : null;
      const target = parent ?? document.body;
      if (target !== watched) {
        observer.disconnect();
        observer.observe(target, { childList: true, subtree: true });
        watched = target;
      }
    }
    ensure();
    const check = window.setInterval(() => {
      if (!item.isConnected || item.getClientRects().length === 0 || watched?.isConnected === false) ensure();
    }, 2_000);
    setSlot(item);
    return () => {
      observer.disconnect();
      window.clearInterval(check);
      if (frame !== 0) cancelAnimationFrame(frame);
      item.remove();
      setSlot(null);
    };
  }, [pluginId]);
  return slot;
}


/**
 * On a phone the footer lives in BB's sidebar drawer, which stays open when a
 * plugin navigates. Close it with BB's own sidebar toggle, and only when the
 * indicator really sits in an open drawer.
 */
function closeSidebarDrawer(from: Element) {
  if (from.closest('[data-sidebar="panel"][role="dialog"][data-state="open"]') === null) return;
  const toggle = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Toggle sidebar"]')).find(
    (button) => button.getClientRects().length > 0,
  );
  toggle?.click();
}

/** App overlay: mounts the indicator into the footer. */
export function FooterIndicator() {
  const slot = useFooterSlot();
  const state = useStatus();
  const { status } = state;
  const [open, setOpen] = useState(false);
  if (slot === null) return null;
  const view = footerView({
    latest: status?.latest ?? null,
    hot: status?.open != null,
    cpuThreshold: status?.cpuThreshold ?? 80,
  });
  const tooltip = state.error !== null && status === null ? `Hotspot: can't read the sampler (${state.error})` : view.tooltip;
  // A bare percentage next to other footer readouts is ambiguous; say what it is while calm and there is room.
  const calmCpu = view.level === null && view.title === null && view.cpu !== "—";
  return createPortal(
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={tooltip}
          aria-label={tooltip}
          data-testid="hotspot-footer-indicator"
          className={cn(
            "@container/hotspot flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring max-md:pointer-coarse:text-sm",
            TOUCH,
          )}
        >
          <HeatDot tone={view.tone} className="size-2 max-md:pointer-coarse:size-2.5" />
          {/* Level and CPU never shrink; only the thread title is cut. */}
          <span
            className={cn(
              "flex min-w-0 items-baseline gap-1 whitespace-nowrap",
              view.tone === "hot" && "font-medium text-destructive",
            )}
          >
            {view.level === null ? null : <span className="shrink-0">{view.level} ·</span>}
            <span className="shrink-0">
              {view.cpu}
              {calmCpu ? <span className="ml-1 hidden text-muted-foreground/80 @[5.5rem]/hotspot:inline">CPU</span> : null}
            </span>
            {view.title === null ? null : <span className="min-w-0 truncate">· {view.title}</span>}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        mobileTitle="Hotspot"
        className="w-[26rem] max-w-[calc(100vw-1rem)] p-0"
      >
        {open ? (
          <HotspotPopover
            state={state}
            close={() => {
              setOpen(false);
              closeSidebarDrawer(slot);
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>,
    slot,
  );
}

function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const refetch = useCallback(() => {
    rpc.call("overview").then(setOverview, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(SAMPLED, refetch);
  return { overview, refetch };
}

function HotspotPopover({ state, close }: { state: StatusState; close: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { overview, refetch } = useOverview();
  const [plan, setPlan] = useState<KillPlanView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { status } = state;
  const latest = status?.latest ?? null;

  const planKill = (threadId: string) => {
    setBusy(`kill:${threadId}`);
    rpc
      .call("killPlan", { threadId })
      .then(
        (next) => setPlan(next),
        (error: unknown) => toast.error("Could not plan the kill", { description: errorText(error) }),
      )
      .finally(() => setBusy(null));
  };

  const stopTurn = (threadId: string, title: string) => {
    setBusy(`stop:${threadId}`);
    rpc
      .call("stopTurn", { threadId })
      .then(
        () => {
          toast.success(`Stopped the turn in ${title}`);
          refetch();
        },
        (error: unknown) => toast.error("Could not stop the turn", { description: errorText(error) }),
      )
      .finally(() => setBusy(null));
  };

  if (plan !== null) {
    return <KillConfirm plan={plan} onDone={() => setPlan(null)} />;
  }

  const threads = latest?.threads.slice(0, 5) ?? [];
  const others = latest?.procs.filter((proc) => proc.cpu >= 1).slice(0, 3) ?? [];

  return (
    <div className="max-h-[min(38rem,80dvh)] overflow-y-auto text-sm">
      <div className="space-y-3 p-4 pb-3">
        {state.error !== null && status === null ? (
          <ErrorNote title="Can't read Hotspot right now" detail={state.error} onRetry={state.retry} />
        ) : (
          <VerdictBlock status={status} size="sheet" onNavigate={close} />
        )}
      </div>

      {latest === null ? null : (
        <Section title="Busiest threads">
          {threads.length === 0 ? (
            <Empty>No BB thread is using the CPU.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {threads.map((thread) => {
                const title = thread.title ?? thread.threadId;
                const running = overview === null ? null : overview.running[thread.threadId] === true;
                // The meta line under the title says why Stop turn is off ("no turn running").
                const metaId = `hotspot-meta-${thread.threadId}`;
                return (
                  <li key={thread.threadId} className="py-2.5">
                    <div className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={title}>
                        {title}
                      </span>
                      <span className="shrink-0 font-medium tabular-nums text-foreground">{cpuText(thread.cpu)}</span>
                    </div>
                    <p id={metaId} className="text-xs text-muted-foreground">
                      {threadMeta(thread.processes, running)}
                    </p>
                    <div className="mt-2 flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className={cn("h-7 px-2.5", TOUCH)}
                        onClick={() => {
                          close();
                          navigate.toThread(thread.threadId);
                        }}
                      >
                        Open
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className={cn("h-7 px-2.5", TOUCH)}
                        disabled={running !== true || busy !== null}
                        aria-describedby={metaId}
                        onClick={() => stopTurn(thread.threadId, title)}
                      >
                        {busy === `stop:${thread.threadId}` ? "Stopping…" : "Stop turn"}
                      </Button>
                      {overview?.allowKill === true ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className={cn("ml-auto h-7 px-2 text-muted-foreground hover:text-destructive", TOUCH)}
                          disabled={busy !== null}
                          onClick={() => planKill(thread.threadId)}
                        >
                          {busy === `kill:${thread.threadId}` ? "Checking…" : "Kill processes…"}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {others.length === 0 ? null : (
            <p className="truncate pb-1 text-xs text-muted-foreground">
              Also busy outside BB: {others.map((proc) => `${proc.name} ${pct(proc.cpu)}`).join(" · ")}
            </p>
          )}
        </Section>
      )}

      <Section title="Recent hot spells">
        {overview === null ? (
          <div className="space-y-2 py-2">
            <SkeletonLine className="w-3/4" />
            <SkeletonLine className="w-2/3" />
          </div>
        ) : overview.episodes.length === 0 ? (
          <Empty>None recorded. Hotspot will tell you when your Mac starts running hot.</Empty>
        ) : (
          <ul className="-mx-2">
            {overview.episodes.map((episode) => (
              <EpisodeRow
                key={episode.id}
                episode={episode}
                onOpen={() => {
                  close();
                  navigate.toPluginPanel("hotspot", { subPath: `episode/${episode.id}` });
                }}
              />
            ))}
          </ul>
        )}
      </Section>

      <div className="border-t border-border p-2">
        <Button
          variant="ghost"
          className={cn("h-9 w-full justify-between px-2 text-sm font-normal text-muted-foreground hover:text-foreground", TOUCH)}
          onClick={() => {
            close();
            navigate.toPluginPanel("hotspot");
          }}
        >
          See the full history
          <Icon name="ChevronRight" className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function EpisodeRow({ episode, onOpen }: { episode: Episode; onOpen: () => void }) {
  const top = episode.culprits[0] ?? null;
  const now = Date.now();
  const end = episode.endAt ?? episode.lastHotAt;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-10 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:min-h-12"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-foreground">
            {dayClockText(episode.startAt, now)} ·{" "}
            {episode.endAt === null ? <span className="text-destructive">still hot</span> : durationText(end - episode.startAt)}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {top === null ? "No BB thread to blame" : (top.title ?? top.threadId)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden="true" className={cn("size-2 rounded-sm", thermalSwatch(episode.peakThermal))} />
          {thermalLabel(episode.peakThermal)}
        </span>
        <Icon name="ChevronRight" className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border px-4 pt-3 pb-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-xs text-muted-foreground">{children}</p>;
}
