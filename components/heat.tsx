// The heat vocabulary every Hotspot surface shares: the tone dot, the
// thermal swatch colours, and the verdict block that answers "is it hot,
// and who is to blame" before anything else. Colours come from the host's
// status tokens so custom palettes and both themes follow.
import type { ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Status } from "../lib/contract";
import type { FooterTone } from "../lib/footer";
import { clockText, pct, verdict } from "../lib/present";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export const TONE_DOT: Record<FooterTone, string> = {
  calm: "bg-[var(--success)]",
  warm: "bg-[var(--warning)]",
  hot: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

/** Thermal level as a swatch; always shown beside its name. */
export function thermalSwatch(level: number | null): string {
  if (level === null) return "bg-transparent";
  if (level === 0) return "bg-muted-foreground/25";
  if (level === 1) return "bg-[var(--warning)]";
  if (level === 2) return "bg-[color-mix(in_oklab,var(--warning),var(--destructive))]";
  return "bg-destructive";
}

/** The same colours as SVG fills, for the chart's heat strip. */
export function thermalFill(level: number | null): string {
  if (level === null) return "fill-transparent";
  if (level === 0) return "fill-muted-foreground/25";
  if (level === 1) return "fill-[var(--warning)]";
  if (level === 2) return "fill-[color-mix(in_oklab,var(--warning),var(--destructive))]";
  return "fill-destructive";
}

export function HeatDot({ tone, className }: { tone: FooterTone; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block shrink-0 rounded-full", TONE_DOT[tone], className)} />;
}

/**
 * The first thing on the popover and the page. `size` picks the headline
 * scale; the thread link closes the surrounding overlay through `onNavigate`.
 */
export function VerdictBlock({
  status,
  size,
  onNavigate,
  children,
}: {
  status: Status | null;
  size: "sheet" | "page";
  onNavigate?: () => void;
  children?: ReactNode;
}) {
  const navigate = useBbNavigate();
  const view = verdict({
    latest: status?.latest ?? null,
    hot: status?.open != null,
    cpuThreshold: status?.cpuThreshold ?? 80,
    openSince: status?.open?.startAt ?? null,
  });
  const culprit = view.culprit;
  return (
    <div className="min-w-0" role="status" aria-live="polite">
      <div className="flex items-center gap-2.5">
        <HeatDot tone={view.tone} className={size === "page" ? "size-3" : "size-2.5"} />
        <h2
          className={cn(
            "min-w-0 font-semibold text-foreground",
            size === "page" ? "text-xl md:text-2xl" : "text-base",
          )}
        >
          {view.headline}
        </h2>
        {view.since === null ? null : (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">since {clockText(view.since)}</span>
        )}
      </div>
      <p className={cn("mt-1 text-muted-foreground", size === "page" ? "text-sm" : "text-xs")}>{view.detail}</p>
      {culprit === null ? (
        view.reassurance === null ? null : (
          <p className="mt-2 text-sm text-foreground">{view.reassurance}</p>
        )
      ) : (
        <div className="mt-2 flex min-w-0 items-center gap-2 text-sm">
          <span className="shrink-0 text-muted-foreground">Mostly</span>
          <Button
            variant="link"
            className="h-auto min-w-0 justify-start p-0 text-sm font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground max-md:pointer-coarse:min-h-11"
            onClick={() => {
              onNavigate?.();
              navigate.toThread(culprit.threadId);
            }}
          >
            <span className="truncate">{culprit.title ?? culprit.threadId}</span>
          </Button>
          <span className="shrink-0 tabular-nums text-muted-foreground">{pct(culprit.cpu)}</span>
        </div>
      )}
      {children}
    </div>
  );
}

/** A quiet placeholder bar while something loads; keeps the layout from jumping. */
export function SkeletonLine({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block h-3 animate-pulse rounded bg-muted-foreground/15", className)} />;
}

/** Inline failure with the recovery next to it. */
export function ErrorNote({ title, detail, onRetry }: { title: string; detail: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-destructive">{title}</p>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">{detail}</p>
      </div>
      <Button size="sm" variant="outline" className="shrink-0 max-md:pointer-coarse:h-11" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
