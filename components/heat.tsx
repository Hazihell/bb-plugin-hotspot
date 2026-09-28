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

/**
 * Hotspot's mark: the flame the sidebar row uses (Lucide's Flame, ISC
 * licence), drawn inline because the shared icon registry has no flame.
 * Tinted with `currentColor`.
 */
export function FlameIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
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
      {/* Once there is a reading, the numbers row below says what the detail would. */}
      {status?.latest == null ? (
        <p className={cn("mt-1 text-muted-foreground", size === "page" ? "text-sm" : "text-xs")}>{view.detail}</p>
      ) : null}
      {culprit === null ? (
        view.reassurance === null ? null : (
          // As tall as the culprit line it trades places with, a finger-sized link on a phone included.
          <p className="mt-2 flex items-center text-sm text-foreground max-md:pointer-coarse:min-h-11">{view.reassurance}</p>
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
          {/* Four digits' room, so the title's cut does not move as the share changes. */}
          <span className="min-w-[4ch] shrink-0 tabular-nums text-muted-foreground">{pct(culprit.cpu)}</span>
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
