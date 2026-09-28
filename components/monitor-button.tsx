// "Activity Monitor ↗": opens the OS's own process monitor on the machine
// running BB's server. The server says whether there is one (status.monitor)
// and does the opening; this only asks and shows a failure beside itself.
//
// The app opens on the server's machine, not the device in hand, so the
// button is hidden under a coarse pointer (a phone or tablet), and its
// tooltip names the machine.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Status, rpcContract } from "../lib/contract";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";

/** How long a failure stays on screen. */
const ERROR_MS = 8_000;

export type MonitorInfo = NonNullable<Status["monitor"]>;

/** Opening the monitor, and the last failure until it fades or the next try. */
export function useOpenMonitor() {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const open = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    setBusy(true);
    setError(null);
    rpc
      .call("openMonitor")
      .then(
        (result) => (result.ok ? null : result.error),
        (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
      )
      .then((failure) => {
        setError(failure);
        if (failure !== null) timer.current = setTimeout(() => setError(null), ERROR_MS);
      })
      .finally(() => setBusy(false));
  }, [rpc]);
  return { open, busy, error };
}

/** A quiet text button; the caller places it and its error. */
export function MonitorButton({
  monitor,
  onOpen,
  busy,
  className,
}: {
  monitor: MonitorInfo;
  onOpen: () => void;
  busy: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy}
      title={`Open ${monitor.app} on ${monitor.host}`}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60 pointer-coarse:hidden",
        className,
      )}
    >
      {monitor.app}
      <Icon name="ExternalLink" className="size-3" />
    </button>
  );
}
