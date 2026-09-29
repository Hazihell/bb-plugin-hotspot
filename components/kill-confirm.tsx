// Step two of a kill: what gets signalled and what is spared, then confirm.
// The server decides every target; this only shows the plan and returns the
// plan id it was given. A plan for one process (a drill-down row) is worded
// for that process and whatever it started that goes with it. The actions stay pinned below the list so Cancel and
// Kill never scroll out of reach.
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { KillPlanView, KillResultView, rpcContract } from "../lib/contract";
import { processSummary } from "../lib/present";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function KillConfirm({ plan, onDone }: { plan: KillPlanView; onDone: (result: KillResultView | null) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [applying, setApplying] = useState(false);
  const title = plan.title ?? plan.threadId;
  const count = plan.targets.length;
  const one = plan.selected;
  const oneName = one === null ? null : (one.name ?? `pid ${one.pid}`);
  const along = one === null ? [] : plan.targets.filter((target) => target.pid !== one.pid);

  const apply = () => {
    setApplying(true);
    rpc.call("killApply", { planId: plan.planId }).then(
      (result) => {
        const summary = `${result.terminated} exited, ${result.killed} needed SIGKILL, ${result.refused} refused`;
        toast.success(oneName === null ? `Killed processes in ${title}` : `Killed ${oneName} in ${title}`, { description: summary });
        onDone(result);
      },
      (error: unknown) => {
        toast.error("Kill failed", { description: errorText(error) });
        onDone(null);
      },
    );
  };

  const heading =
    count === 0 ? "Nothing to kill" : oneName !== null ? `Kill ${oneName}?` : `Kill ${plural(count, "process", "processes")}?`;
  return (
    <div className="flex max-h-[min(34rem,80dvh)] flex-col text-sm">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive">
            <Icon name="AlertTriangle" className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="break-words text-base font-semibold text-foreground">{heading}</h2>
            <p className="line-clamp-2 break-words text-muted-foreground" title={title}>
              in {title}
            </p>
          </div>
        </div>

        {one !== null && count === 0 ? (
          <p className="text-muted-foreground">
            {oneName} is {one.reason ?? "not a process this thread's kill would stop"}, so nothing will be signalled.
          </p>
        ) : count === 0 ? (
          <p className="text-muted-foreground">
            Everything running in this thread is its agent, BB, an app or a helper, and those are always spared.
          </p>
        ) : one !== null ? (
          <>
            {along.length === 0 ? null : (
              <p className="font-medium text-foreground">
                With it, {plural(along.length, "process", "processes")} it started: {processSummary(along.map((target) => target.name))}
              </p>
            )}
            <p className="text-muted-foreground">
              {along.length === 0 ? "It gets" : "They get"} SIGTERM now and SIGKILL after 5 seconds if still running. The
              rest of the thread keeps running.
            </p>
          </>
        ) : (
          <>
            <p className="font-medium text-foreground">{processSummary(plan.targets.map((target) => target.name))}</p>
            <p className="text-muted-foreground">
              They get SIGTERM now and SIGKILL after 5 seconds if still running. The thread&apos;s agent, BB and your
              apps keep running.
            </p>
          </>
        )}

        {count === 0 ? null : (
          <Details summary={`Show the ${plural(count, "process", "processes")}`} defaultOpen={false}>
            <ProcessList rows={plan.targets.map((target) => ({ ...target, note: target.command }))} />
          </Details>
        )}
        {plan.excluded.length === 0 ? null : (
          <Details summary={`${plan.excluded.length} spared, and why`} defaultOpen={count === 0}>
            <ProcessList rows={plan.excluded.map((entry) => ({ ...entry, note: entry.reason }))} />
          </Details>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-popover px-4 py-3 max-md:bg-background">
        <Button
          variant="outline"
          className="max-md:pointer-coarse:h-11 max-md:pointer-coarse:flex-1"
          onClick={() => onDone(null)}
          disabled={applying}
          autoFocus
        >
          {count === 0 ? "Back" : "Cancel"}
        </Button>
        {count === 0 ? null : (
          <Button
            variant="destructive"
            className="max-md:pointer-coarse:h-11 max-md:pointer-coarse:flex-1"
            onClick={apply}
            disabled={applying}
          >
            {applying ? "Killing…" : one !== null && count === 1 ? "Kill process" : `Kill ${plural(count, "process", "processes")}`}
          </Button>
        )}
      </div>
    </div>
  );
}

function Details({ summary, defaultOpen, children }: { summary: string; defaultOpen: boolean; children: ReactNode }) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <Icon name="ChevronRight" className="size-3.5 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

function ProcessList({ rows }: { rows: Array<{ pid: number; name: string; cpu: number; note: string }> }) {
  return (
    <ul className={cn("divide-y divide-border rounded-md border border-border text-xs")}>
      {rows.map((row) => (
        <li key={row.pid} className="px-2.5 py-1.5">
          <div className="flex gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.name}</span>
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
