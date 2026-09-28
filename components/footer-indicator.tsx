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
import type { Episode, KillPlanView, Overview, Status, rpcContract } from "../lib/contract";
import { type FooterTone, footerView } from "../lib/footer";
import { thermalLabel } from "../lib/labels";
import { usePortalScopeProps } from "../lib/portal-scope";
import { SAMPLED } from "../lib/signals";
import { cn } from "../lib/utils";
import { useStatus } from "../hooks/use-status";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const TONE_CLASS: Record<FooterTone, string> = {
  calm: "bg-emerald-500",
  warm: "bg-amber-400",
  hot: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

const pct = (value: number) => `${Math.round(value)}%`;
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
    let frame = 0;
    const ensure = () => {
      frame = 0;
      if (item.isConnected && item.getClientRects().length > 0) return;
      const menu = visibleFooterMenu();
      if (menu !== null && item.parentElement !== menu) menu.appendChild(item);
    };
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(ensure);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    ensure();
    setSlot(item);
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      item.remove();
      setSlot(null);
    };
  }, [pluginId]);
  return slot;
}

/** App overlay: mounts the indicator into the footer. */
export function FooterIndicator() {
  const slot = useFooterSlot();
  const status = useStatus();
  const [open, setOpen] = useState(false);
  if (slot === null) return null;
  const view = footerView({
    latest: status?.latest ?? null,
    hot: status?.open != null,
    cpuThreshold: status?.cpuThreshold ?? 80,
  });
  return createPortal(
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={view.tooltip}
          aria-label={view.tooltip}
          data-testid="hotspot-footer-indicator"
          className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_CLASS[view.tone])} />
          {/* Level and CPU never shrink; only the thread title is cut. */}
          <span className={cn("flex min-w-0 items-baseline gap-1 whitespace-nowrap", view.tone === "hot" && "text-destructive")}>
            {view.level === null ? null : <span className="shrink-0">{view.level} ·</span>}
            <span className="shrink-0">{view.cpu}</span>
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
        {open ? <HotspotPopover status={status} close={() => setOpen(false)} /> : null}
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

function HotspotPopover({ status, close }: { status: Status | null; close: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { overview, refetch } = useOverview();
  const [plan, setPlan] = useState<KillPlanView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const latest = status?.latest ?? null;

  const planKill = (threadId: string) => {
    setBusy(`kill:${threadId}`);
    rpc.call("killPlan", { threadId }).then(
      (next) => setPlan(next),
      (error: unknown) => toast.error("Could not plan the kill", { description: errorText(error) }),
    ).finally(() => setBusy(null));
  };

  const stopTurn = (threadId: string, title: string) => {
    setBusy(`stop:${threadId}`);
    rpc.call("stopTurn", { threadId }).then(
      () => {
        toast.success(`Stopped the turn in ${title}`);
        refetch();
      },
      (error: unknown) => toast.error("Could not stop the turn", { description: errorText(error) }),
    ).finally(() => setBusy(null));
  };

  if (plan !== null) {
    return <KillConfirm plan={plan} onDone={() => setPlan(null)} />;
  }

  return (
    <div className="max-h-[70vh] space-y-3 overflow-y-auto p-3 text-sm">
      {latest === null ? (
        <p className="text-muted-foreground">Waiting for the first sample…</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <Figure label="Heat" value={thermalLabel(latest.thermal)} detail={status?.open ? `hot since ${clock(status.open.startAt)}` : `at ${clock(latest.at)}`} />
          <Figure label="CPU" value={pct(latest.cpu)} detail={`threshold ${pct(status?.cpuThreshold ?? 80)}`} />
          <Figure label="Load" value={latest.load.toFixed(2)} detail="per core" />
        </div>
      )}

      <Section title="Busiest threads">
        {latest === null || latest.threads.length === 0 ? (
          <Empty>No BB thread is using CPU.</Empty>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {latest.threads.slice(0, 5).map((thread) => {
              const title = thread.title ?? thread.threadId;
              const running = overview?.running[thread.threadId] === true;
              return (
                <li key={thread.threadId} className="space-y-1.5 px-2.5 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium" title={title}>
                      {title}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {pct(thread.cpu)} · {thread.processes} proc
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
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
                      className="h-7 px-2"
                      disabled={!running || busy !== null}
                      onClick={() => stopTurn(thread.threadId, title)}
                    >
                      Stop turn
                    </Button>
                    {overview?.allowKill === true ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-destructive"
                        disabled={busy !== null}
                        onClick={() => planKill(thread.threadId)}
                      >
                        {busy === `kill:${thread.threadId}` ? "Planning…" : "Kill processes…"}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {latest !== null && latest.procs.length > 0 ? (
        <Section title="Outside BB threads">
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {latest.procs.slice(0, 3).map((proc) => (
              <li key={proc.pid} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate">{proc.name}</span>
                <span className="tabular-nums">{pct(proc.cpu)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Recent hot episodes">
        {overview === null ? (
          <Empty>Loading…</Empty>
        ) : overview.episodes.length === 0 ? (
          <Empty>No hot episodes recorded.</Empty>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {overview.episodes.map((episode) => (
              <EpisodeRow key={episode.id} episode={episode} />
            ))}
          </ul>
        )}
      </Section>

      <button
        type="button"
        className="text-xs text-primary underline-offset-4 hover:underline"
        onClick={() => {
          close();
          navigate.toPluginPanel("hotspot");
        }}
      >
        Open the Hotspot page
      </button>
    </div>
  );
}

function EpisodeRow({ episode }: { episode: Episode }) {
  const top = episode.culprits[0] ?? null;
  return (
    <li className="flex gap-2">
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {clock(episode.startAt)}–{episode.endAt === null ? "now" : clock(episode.endAt)}
      </span>
      <span className="shrink-0">{thermalLabel(episode.peakThermal)}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {top === null ? "no thread" : (top.title ?? top.threadId)}
      </span>
    </li>
  );
}

/** Step two of a kill: exactly what gets SIGTERM, what is spared and why, then confirm. */
function KillConfirm({ plan, onDone }: { plan: KillPlanView; onDone: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [applying, setApplying] = useState(false);
  const title = plan.title ?? plan.threadId;

  const apply = () => {
    setApplying(true);
    rpc.call("killApply", { planId: plan.planId }).then(
      (result) => {
        const summary = `${result.terminated} exited, ${result.killed} needed SIGKILL, ${result.refused} refused`;
        toast.success(`Killed processes in ${title}`, { description: summary });
        onDone();
      },
      (error: unknown) => {
        toast.error("Kill failed", { description: errorText(error) });
        onDone();
      },
    );
  };

  return (
    <div className="max-h-[70vh] space-y-3 overflow-y-auto p-3 text-sm">
      <div className="flex items-start gap-2">
        <Icon name="TriangleAlert" className="mt-0.5 size-4 shrink-0 text-destructive" />
        <p className="min-w-0">
          {plan.targets.length === 0 ? (
            <>Nothing in <strong>{title}</strong> can be killed.</>
          ) : (
            <>
              Send SIGTERM to {plan.targets.length} process{plan.targets.length === 1 ? "" : "es"} in{" "}
              <strong>{title}</strong>. Any still running after 5 seconds get SIGKILL.
            </>
          )}
        </p>
      </div>
      {plan.targets.length === 0 ? null : (
        <ProcessList
          rows={plan.targets.map((target) => ({ ...target, note: target.command }))}
          className="border-destructive/40"
        />
      )}
      {plan.excluded.length === 0 ? null : (
        <Section title="Spared">
          <ProcessList rows={plan.excluded.map((entry) => ({ ...entry, note: entry.reason }))} />
        </Section>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone} disabled={applying}>
          {plan.targets.length === 0 ? "Back" : "Cancel"}
        </Button>
        {plan.targets.length === 0 ? null : (
          <Button size="sm" variant="destructive" onClick={apply} disabled={applying}>
            {applying ? "Killing…" : `Kill ${plan.targets.length}`}
          </Button>
        )}
      </div>
    </div>
  );
}

function ProcessList({
  rows,
  className,
}: {
  rows: Array<{ pid: number; name: string; cpu: number; note: string }>;
  className?: string;
}) {
  return (
    <ul className={cn("divide-y divide-border rounded-md border border-border text-xs", className)}>
      {rows.map((row) => (
        <li key={row.pid} className="px-2.5 py-1.5">
          <div className="flex gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              pid {row.pid} · {row.cpu.toFixed(1)}%
            </span>
          </div>
          <div className="truncate text-muted-foreground" title={row.note}>
            {row.note}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Figure({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border px-2 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate font-medium capitalize tabular-nums">{value}</div>
      <div className="truncate text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
