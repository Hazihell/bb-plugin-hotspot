// The always-visible Hotspot indicator in the app sidebar footer, and the
// popover it opens.
//
// BB's footer slot draws only a fixed icon, so the indicator is mounted the
// way other live footer readouts are (usage-tracker): an app overlay keeps one
// <li> in the footer's menu row, re-attaching it when BB re-renders the
// sidebar, and portals React into it. The <li> carries this plugin's scope
// attributes so its Tailwind classes apply. The server decides every kill;
// this file only shows a plan and returns the plan id it was given.
import { type FocusEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Episode, KillPlanView, Overview, Status, rpcContract } from "../lib/contract";
import {
  type FooterHeat,
  type FooterLine,
  type FooterMetric,
  type MetricAlert,
  STACK_SPACE,
  fitFooter,
  footerView,
} from "../lib/footer";
import { bytesText, thermalLabel } from "../lib/labels";
import { usePortalScopeProps } from "../lib/portal-scope";
import { bbTotalTitle, cpuText, dayClockText, durationText, pct, threadMeta } from "../lib/present";
import { RUNNING_CHANGED, SAMPLED } from "../lib/signals";
import { emptyList, listRows, nextList } from "../lib/thread-list";
import { cn } from "../lib/utils";
import { type StatusState, useStatus } from "../hooks/use-status";
import { ErrorNote, FlameIcon, HEAT_ICON, SkeletonLine, VerdictBlock, thermalSwatch } from "./heat";
import { MetricsRow } from "./metrics";
import { KillConfirm } from "./kill-confirm";
import { MonitorButton, useOpenMonitor } from "./monitor-button";
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

export const ALERT_TEXT: Record<Exclude<MetricAlert, null>, string> = {
  warn: "text-[var(--warning-text)]",
  hot: "text-destructive",
};

/** The flame, its gap and a little slack, in px, beside the measured text. */
const ICON_AND_GAP = 14 + 4 + 1;
/** The stacked metrics' size, whatever size the footer around them uses (the phone drawer's is 14px). */
const STACK_PX = 11;

let measureContext: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (measureContext === null) return text.length * 7;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

interface TextBox {
  /** Pixels left for text beside the flame. */
  width: number;
  /** CSS fonts for the one-line readout and the stacked metrics. */
  line: string;
  stack: string;
}

/** The text width the button leaves beside the flame, and the fonts it draws in. */
function useTextBox(element: HTMLElement | null): TextBox | null {
  const [box, setBox] = useState<TextBox | null>(null);
  useEffect(() => {
    if (element === null) return;
    const update = () => {
      const style = getComputedStyle(element);
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const width = element.clientWidth - padding - ICON_AND_GAP;
      // Measured at medium weight, the way a flagged number is drawn.
      const line = `500 ${style.fontSize} ${style.fontFamily}`;
      const stack = `500 ${STACK_PX}px ${style.fontFamily}`;
      setBox((previous) =>
        previous?.width === width && previous.line === line && previous.stack === stack ? previous : { width, line, stack },
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [element]);
  return box;
}

function MetricText({ metric, stacked }: { metric: FooterMetric; stacked?: boolean }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground">{metric.label}</span>
      {stacked ? STACK_SPACE : " "}
      <span className={cn("text-sidebar-foreground", metric.alert !== null && cn("font-medium", ALERT_TEXT[metric.alert]))}>
        {metric.value}
      </span>
    </span>
  );
}

/**
 * `CPU 83% · MEM 62% · Home page…` on one line, or CPU over MEM on two short
 * lines. Labels quiet, numbers clear, colour only on a flagged number; the
 * flame beside it says the heat.
 */
function FooterText({ line }: { line: FooterLine }) {
  if (line.layout === "stack") {
    return (
      <span className="flex min-w-0 flex-col leading-3" style={{ fontSize: STACK_PX }}>
        {line.metrics.map((metric) => (
          <MetricText key={metric.label} metric={metric} stacked />
        ))}
      </span>
    );
  }
  const parts: ReactNode[] = [];
  for (const metric of line.metrics) parts.push(<MetricText key={metric.label} metric={metric} />);
  if (line.title !== null) parts.push(<span key="title">{line.title}</span>);
  return (
    <span className="min-w-0 truncate text-muted-foreground">
      {parts.map((part, index) => (
        <span key={index}>
          {index === 0 ? null : " · "}
          {part}
        </span>
      ))}
    </span>
  );
}

/** App overlay: mounts the indicator into the footer. */
export function FooterIndicator() {
  const slot = useFooterSlot();
  const state = useStatus();
  const { status } = state;
  const [open, setOpen] = useState(false);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const box = useTextBox(button);
  if (slot === null) return null;
  const view = footerView({
    latest: status?.latest ?? null,
    hot: status?.open != null,
    cpuThreshold: status?.cpuThreshold ?? 80,
  });
  const line = fitFooter(view, box?.width ?? Number.POSITIVE_INFINITY, (text, size) =>
    box === null ? 0 : textWidth(text, size === "stack" ? box.stack : box.line),
  );
  const tooltip = state.error !== null && status === null ? `Hotspot: can't read the sampler (${state.error})` : view.tooltip;
  return createPortal(
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={setButton}
          type="button"
          title={tooltip}
          aria-label={tooltip}
          data-testid="hotspot-footer-indicator"
          data-hotspot-line={`${line.layout}: ${line.text}`}
          className={cn(
            // On a phone the drawer leaves ~75px beside the other readouts: no padding, so both numbers still fit.
            "flex h-8 w-full min-w-0 items-center gap-1 rounded-md px-1 text-xs tabular-nums outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring max-md:pointer-coarse:px-0",
            TOUCH,
          )}
        >
          <FlameIcon
            className={cn(
              "size-3.5",
              HEAT_ICON[view.heat ?? "calm"],
              view.tone === "idle" && "opacity-50",
            )}
          />
          <FooterText line={line} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        side="top"
        align="start"
        sideOffset={6}
        mobileTitle="Hotspot"
        // Focus the popover itself, not its first button: without a culprit
        // link that is a thread row, and focus there would freeze the list.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus({ preventScroll: true });
        }}
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
  useRealtime(RUNNING_CHANGED, refetch);
  return { overview, refetch };
}

/**
 * The thread list as drawn: the reading's threads held steady by the list
 * rules, advanced once per reading. `frozen` is read when a reading
 * arrives; letting go takes effect at the next one.
 */
function useSteadyThreads(latest: Status["latest"], frozen: boolean) {
  const previous = useRef(emptyList<ThreadEntry>());
  const frozenNow = useRef(frozen);
  frozenNow.current = frozen;
  const list = useMemo(
    () => nextList(previous.current, latest?.threads ?? [], performance.now(), frozenNow.current),
    [latest],
  );
  useEffect(() => {
    previous.current = list;
  }, [list]);
  return listRows(list);
}

/** How long the list stays frozen after the pointer leaves it, so a pointer grazing its edge does not let it jump. */
const LEAVE_GRACE_MS = 800;

/**
 * Whether the pointer, or keyboard focus, is in the list. Mouse clicks focus
 * the popover's first button on open; only focus the user can see (keyboard
 * focus) counts.
 */
function useListHold() {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (leave.current !== null) clearTimeout(leave.current);
  }, []);
  const handlers = {
    onPointerEnter: () => {
      if (leave.current !== null) clearTimeout(leave.current);
      leave.current = null;
      setPointer(true);
    },
    onPointerLeave: () => {
      if (leave.current !== null) clearTimeout(leave.current);
      leave.current = setTimeout(() => {
        leave.current = null;
        setPointer(false);
      }, LEAVE_GRACE_MS);
    },
    onFocus: (event: FocusEvent) => setFocus(event.target instanceof HTMLElement && event.target.matches(":focus-visible")),
    onBlur: (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocus(false);
    },
  };
  /** Lets go at once, for when the list is taken off screen: an unmounted list fires no leave or blur. */
  const release = useCallback(() => {
    if (leave.current !== null) clearTimeout(leave.current);
    leave.current = null;
    setPointer(false);
    setFocus(false);
  }, []);
  return { held: pointer || focus, handlers, release };
}

/**
 * Keeps an element from shrinking while it is mounted: its min-height
 * follows the tallest it has been. A new `reset` lets it shrink once, for a
 * change the user asked for.
 */
function useNoShrink(reset: unknown) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (element === null) return;
    element.style.minHeight = "";
    let tallest = 0;
    const observer = new ResizeObserver(() => {
      const height = element.offsetHeight;
      if (height <= tallest) return;
      tallest = height;
      element.style.minHeight = `${height}px`;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, reset]);
  return setElement;
}

function HotspotPopover({ state, close }: { state: StatusState; close: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { overview, refetch } = useOverview();
  const [plan, setPlan] = useState<KillPlanView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showIdle, setShowIdle] = useState(false);
  const { status } = state;
  const latest = status?.latest ?? null;
  // An unfolded row, or the pointer or keyboard focus in the list, freezes
  // it: numbers update in place and no row moves, joins or leaves, so the
  // row under the pointer and its Stop turn and Kill stay that thread's.
  const hold = useListHold();
  const { shown: busyThreads, folded: idleThreads } = useSteadyThreads(latest, hold.held || expanded !== null);
  // Hiding the idle threads may shrink the list; folding a row's actions
  // away leaves its room, so the rows above do not move after the click.
  const [idleHidden, setIdleHidden] = useState(0);
  const listRef = useNoShrink(idleHidden);
  const { open: openMonitor, busy: monitorBusy, error: monitorError } = useOpenMonitor();

  const planKill = (threadId: string) => {
    setBusy(`kill:${threadId}`);
    rpc
      .call("killPlan", { threadId })
      .then(
        (next) => {
          // The confirmation replaces the list: let it go, and fold the row
          // away so it does not hold the list frozen on return.
          hold.release();
          setExpanded(null);
          setPlan(next);
        },
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

  // A thread already mid-turn can climb into the list between stored
  // samples: ask again which shown threads run a turn when the set changes.
  const shownIds = (latest?.threads ?? []).map((thread) => thread.threadId).sort().join(" ");
  const fetchedFor = useRef(shownIds);
  useEffect(() => {
    if (shownIds === fetchedFor.current) return;
    fetchedFor.current = shownIds;
    refetch();
  }, [shownIds, refetch]);

  if (plan !== null) {
    return (
      <KillConfirm
        plan={plan}
        onDone={() => {
          hold.release();
          setPlan(null);
        }}
      />
    );
  }

  const threads = showIdle ? [...busyThreads, ...idleThreads] : busyThreads;
  const cpuThreshold = status?.cpuThreshold ?? 80;
  const others = latest?.procs.filter((proc) => proc.cpu >= 1).slice(0, 3) ?? [];
  const threadCount = busyThreads.length + idleThreads.length;

  // Only the thread list scrolls: the verdict and numbers above it and the
  // hot spells below stay in view however many threads there are. The
  // phone drawer allows 92dvh, less its handle.
  return (
    <div className="flex max-h-[min(40rem,80dvh)] flex-col text-sm max-md:max-h-[calc(92dvh-3rem)]">
      <div className="shrink-0 space-y-3 p-4 pb-3">
        {state.error !== null && status === null ? (
          <ErrorNote title="Can't read Hotspot right now" detail={state.error} onRetry={state.retry} />
        ) : (
          <>
            <VerdictBlock status={status} size="sheet" onNavigate={close} />
            <MetricsRow status={status} size="sheet" />
          </>
        )}
      </div>

      {latest === null ? null : (
        <section {...hold.handlers} className="flex min-h-0 flex-1 flex-col border-t border-border pt-3 pb-1.5">
          {/*
            The header row carries BB's total in the rows' own CPU and
            memory columns, so the total costs no height; the rows below
            read as parts of it.
          */}
          <div className="flex shrink-0 items-baseline gap-3 px-4 text-xs font-medium text-muted-foreground">
            <h3 className="min-w-0 flex-1 truncate">Busiest threads</h3>
            {latest.bb == null ? (
              threads.length === 0 ? null : (
                <>
                  <span className={CPU_COLUMN}>CPU</span>
                  <span className={MEM_COLUMN}>Memory</span>
                  <span aria-hidden="true" className={ACTIONS_COLUMN} />
                </>
              )
            ) : (
              <BbTotal bb={latest.bb} />
            )}
          </div>
          <div className="min-h-0 overflow-y-auto px-4 pt-1">
            {/*
              The popover hangs from the footer, so any change in its height
              moves everything above the change. The list keeps room for
              three lines and the outside-BB line, and never shrinks while
              open, except when the user hides the idle threads.
            */}
            <div ref={listRef} className={LIST_FLOOR}>
              {threadCount === 0 ? (
                <Empty>No BB thread is using the CPU.</Empty>
              ) : (
                <ul>
                  {threads.map(({ thread, present }) => (
                    <ThreadRow
                      key={thread.threadId}
                      thread={thread}
                      present={present}
                      running={overview === null ? null : overview.running[thread.threadId] === true}
                      hot={present && thread.cpu >= cpuThreshold}
                      expanded={expanded === thread.threadId}
                      onToggle={() => setExpanded((current) => (current === thread.threadId ? null : thread.threadId))}
                      onOpen={() => {
                        close();
                        navigate.toThread(thread.threadId);
                      }}
                      busy={busy}
                      allowKill={overview?.allowKill === true}
                      onStop={stopTurn}
                      onKill={planKill}
                    />
                  ))}
                </ul>
              )}
              {idleThreads.length === 0 ? null : (
                <button
                  type="button"
                  aria-expanded={showIdle}
                  onClick={() => {
                    // An unfolded idle row folds away with the others.
                    if (showIdle && idleThreads.some((row) => row.thread.threadId === expanded)) setExpanded(null);
                    if (showIdle) setIdleHidden((count) => count + 1);
                    setShowIdle(!showIdle);
                  }}
                  className={cn(
                    "-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                    TOUCH,
                  )}
                >
                  <Icon name="ChevronRight" className={cn("size-3.5 transition-transform", showIdle && "rotate-90")} />
                  {showIdle
                    ? `Hide ${idleThreads.length === 1 ? "the idle thread" : "idle threads"}`
                    : `${idleThreads.length} idle thread${idleThreads.length === 1 ? "" : "s"}`}
                </button>
              )}
              {/*
                Its line is kept when nothing outside BB is busy, so the list
                does not grow when something is. The monitor button and its
                failure share the line, so neither adds height.
              */}
              <div className="flex items-center gap-2 py-1 text-xs">
                {monitorError !== null ? (
                  <p role="alert" title={monitorError} className="min-w-0 flex-1 truncate text-destructive">
                    {monitorError}
                  </p>
                ) : others.length === 0 ? (
                  <p aria-hidden="true" className="min-w-0 flex-1">
                    &nbsp;
                  </p>
                ) : (
                  <p className="min-w-0 flex-1 truncate tabular-nums text-muted-foreground">
                    Also busy outside BB: {others.map((proc) => `${proc.name} ${pct(proc.cpu)}`).join(" · ")}
                  </p>
                )}
                {status?.monitor == null ? null : (
                  <MonitorButton monitor={status.monitor} onOpen={openMonitor} busy={monitorBusy} className="-my-1 -mr-1 px-1 py-1" />
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      <Section
        title="Recent hot spells"
        columns={
          <button
            type="button"
            onClick={() => {
              close();
              navigate.toPluginPanel("hotspot");
            }}
            className="-my-1 -mr-1 flex shrink-0 items-center gap-0.5 rounded-md px-1 py-1 font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:min-h-11"
          >
            Full history
            <Icon name="ChevronRight" className="size-3.5" />
          </button>
        }
      >
        {overview === null ? (
          <div className={cn("space-y-2 py-2", EPISODES_FLOOR)}>
            <SkeletonLine className="w-3/4" />
            <SkeletonLine className="w-2/3" />
          </div>
        ) : overview.episodes.length === 0 ? (
          <Empty>None recorded. Hotspot will tell you when your Mac starts running hot.</Empty>
        ) : (
          // Room for three spells, so a new one does not grow the popover.
          <ul className={cn("-mx-2 pt-1", EPISODES_FLOOR)}>
            {overview.episodes.slice(0, 3).map((episode) => (
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
    </div>
  );
}

type ThreadEntry = NonNullable<Status["latest"]>["threads"][number];

/** `BB total  23%  3.1 GB`, the figures in the CPU and memory columns; the split is in the tooltip. */
function BbTotal({ bb }: { bb: NonNullable<NonNullable<Status["latest"]>["bb"]> }) {
  const title = bbTotalTitle(bb);
  return (
    <>
      <span title={title} className="shrink-0 font-normal">
        BB total
      </span>
      <span title={title} className={cn(CPU_COLUMN, "tabular-nums text-foreground")}>
        {cpuText(bb.cpu)}
      </span>
      <span title={title} className={cn(MEM_COLUMN, "tabular-nums text-foreground")}>
        {bytesText(bb.memBytes)}
      </span>
      <span aria-hidden="true" className={ACTIONS_COLUMN} />
    </>
  );
}

/**
 * One line per thread: the title opens it, then CPU, memory and a "…"
 * toggle. The toggle unfolds the rest in place (processes, whether a turn
 * runs, Stop turn and Kill processes…), so the rare actions cost no space
 * until asked for and Kill stays one step further away than Open.
 */
function ThreadRow({
  thread,
  present,
  running,
  hot,
  expanded,
  onToggle,
  onOpen,
  busy,
  allowKill,
  onStop,
  onKill,
}: {
  thread: ThreadEntry;
  /** False when the latest reading left this thread out: CPU is unknown, memory is the last seen. */
  present: boolean;
  /** Null while the overview loads. */
  running: boolean | null;
  hot: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  busy: string | null;
  allowKill: boolean;
  onStop: (threadId: string, title: string) => void;
  onKill: (threadId: string) => void;
}) {
  const title = thread.title ?? thread.threadId;
  const meta = threadMeta(thread.processes, running);
  const panelId = `hotspot-actions-${thread.threadId}`;
  // The meta line in the panel says why Stop turn is off ("no turn running").
  const metaId = `hotspot-meta-${thread.threadId}`;
  return (
    <li className={cn("-mx-2 rounded-md", expanded && "bg-muted/60")}>
      <div className="flex items-center gap-3 pr-0 pl-2">
        <button
          type="button"
          onClick={onOpen}
          title={`${title}\n${meta}`}
          className={cn(
            "group flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring",
            TOUCH,
          )}
        >
          <span className="truncate decoration-muted-foreground/60 underline-offset-4 group-hover:underline">{title}</span>
          {/* A phone's row has no room for the tag; the unfolded panel says it there. */}
          {running === true ? (
            <span className="shrink-0 text-xs font-normal text-muted-foreground max-sm:sr-only">· running</span>
          ) : null}
        </button>
        <span
          title={present ? undefined : "Not in the latest reading"}
          className={cn(CPU_COLUMN, "font-medium tabular-nums", present ? "text-foreground" : "text-muted-foreground", hot && ALERT_TEXT.hot)}
        >
          {present ? cpuText(thread.cpu) : "—"}
        </span>
        <span className={cn(MEM_COLUMN, "tabular-nums", present ? "text-foreground" : "text-muted-foreground")}>
          {thread.memBytes === null ? "—" : bytesText(thread.memBytes)}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={`Actions for ${title}`}
          title="Stop turn or kill processes"
          className={cn(
            ACTIONS_COLUMN,
            "grid h-8 place-items-center rounded-md text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-expanded:text-foreground",
            TOUCH,
          )}
        >
          <Icon name="MoreHorizontal" className="size-4" />
        </button>
      </div>
      {expanded ? <ProcessList thread={thread} present={present} /> : null}
      {expanded ? (
        <div id={panelId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2 pb-2">
          <p id={metaId} className="min-w-0 basis-full truncate text-xs text-muted-foreground sm:basis-0 sm:flex-1">
            {meta}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className={cn("h-7 px-2.5", TOUCH)}
              disabled={running !== true || busy !== null}
              aria-describedby={metaId}
              onClick={() => onStop(thread.threadId, title)}
            >
              {busy === `stop:${thread.threadId}` ? "Stopping…" : "Stop turn"}
            </Button>
            {allowKill ? (
              <Button
                size="sm"
                variant="ghost"
                className={cn("h-7 px-2 text-muted-foreground hover:text-destructive", TOUCH)}
                disabled={busy !== null}
                onClick={() => onKill(thread.threadId)}
              >
                {busy === `kill:${thread.threadId}` ? "Checking…" : "Kill processes…"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

type ThreadProcess = NonNullable<ThreadEntry["top"]>[number];

/**
 * An unfolded row's busiest processes, in the list's CPU and memory
 * columns. Display only: kill still plans from the whole thread. Like the
 * list around it, it holds still while unfolded: the processes and their
 * order are the ones shown at unfold, and only the numbers change. One that
 * leaves the reading keeps its row with CPU "—" and its last memory.
 */
function ProcessList({ thread, present }: { thread: ThreadEntry; present: boolean }) {
  const top = thread.top ?? [];
  const [pids] = useState(() => top.map((proc) => proc.pid));
  const lastSeen = useRef(new Map<number, ThreadProcess>());
  for (const proc of top) lastSeen.current.set(proc.pid, proc);
  const inReading = new Set(present ? top.map((proc) => proc.pid) : []);
  if (pids.length === 0) return null;
  return (
    <ul aria-label={`Busiest processes in ${thread.title ?? thread.threadId}`} className="pb-1">
      {pids.map((pid) => {
        const proc = lastSeen.current.get(pid);
        if (proc === undefined) return null;
        const live = inReading.has(pid);
        return (
          <li
            key={pid}
            title={`${proc.name} (pid ${pid})${live ? "" : "\nNot in the latest reading"}`}
            className="flex h-6 items-center gap-3 pl-2 text-xs tabular-nums"
          >
            <span className="min-w-0 flex-1 truncate pl-3 text-muted-foreground">{proc.name}</span>
            <span className={cn(CPU_COLUMN, live ? "text-foreground" : "text-muted-foreground")}>
              {live ? cpuText(proc.cpu) : "—"}
            </span>
            <span className={cn(MEM_COLUMN, "text-muted-foreground")}>{bytesText(proc.memBytes)}</span>
            <span aria-hidden="true" className={ACTIONS_COLUMN} />
          </li>
        );
      })}
    </ul>
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
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:h-11"
      >
        <span className="shrink-0 tabular-nums text-foreground">
          {dayClockText(episode.startAt, now)} ·{" "}
          {episode.endAt === null ? <span className="text-destructive">still hot</span> : durationText(end - episode.startAt)}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {top === null ? "No BB thread to blame" : (top.title ?? top.threadId)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <span aria-hidden="true" className={cn("size-2 rounded-sm", thermalSwatch(episode.peakThermal))} />
          {thermalLabel(episode.peakThermal)}
        </span>
        <Icon name="ChevronRight" className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

/** Right-aligned number columns in the threads list, headed in the section title row. */
const CPU_COLUMN = "w-10 shrink-0 text-right";
const MEM_COLUMN = "w-16 shrink-0 text-right";
/** The "…" toggle; 44px wide under a finger. */
const ACTIONS_COLUMN = "w-8 shrink-0 max-md:pointer-coarse:w-11";
/** Room for three lines (rows or the idle fold), 32px each or 44px under a finger, and the outside-BB line. */
const LIST_FLOOR = "min-h-30 max-md:pointer-coarse:min-h-39";
/** Room for three hot spells and the list's top padding. */
const EPISODES_FLOOR = "min-h-25 max-md:pointer-coarse:min-h-34";

function Section({ title, columns, children }: { title: string; columns?: ReactNode; children: ReactNode }) {
  return (
    <section className="shrink-0 border-t border-border px-4 pt-3 pb-2">
      <div className="flex items-baseline gap-3 text-xs font-medium text-muted-foreground">
        <h3 className="min-w-0 flex-1">{title}</h3>
        {columns}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-xs text-muted-foreground">{children}</p>;
}
