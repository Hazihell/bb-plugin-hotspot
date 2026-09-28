import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Status, rpcContract } from "../lib/contract";
import { LIVE, type LiveSignal, SAMPLED } from "../lib/signals";

export interface StatusState {
  /** The last status read; kept while a later read fails. */
  status: Status | null;
  /** Why the last read failed, until one succeeds. */
  error: string | null;
  retry: () => void;
}

function isLiveSignal(value: unknown): value is LiveSignal {
  if (typeof value !== "object" || value === null) return false;
  const reading = value as Partial<LiveSignal>;
  return typeof reading.at === "number" && typeof reading.cpu === "number" && Array.isArray(reading.threads);
}

/**
 * The latest reading and open episode. Refetched after every stored sample
 * the server publishes; between those, each live reading replaces `latest`
 * in place, with no request.
 */
export function useStatus(): StatusState {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retry = useCallback(() => {
    rpc.call("status").then(
      (next) => {
        setStatus(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);
  useEffect(retry, [retry]);
  useRealtime(SAMPLED, retry);
  useRealtime(LIVE, (payload) => {
    if (!isLiveSignal(payload)) return;
    // An older reading never replaces a newer one, whichever arrived last.
    setStatus((current) =>
      current === null || (current.latest !== null && current.latest.at > payload.at)
        ? current
        : { ...current, latest: payload },
    );
  });
  return { status, error, retry };
}

/** How often a visible window renews the server's watch lease. */
const HEARTBEAT_MS = 4_000;

/**
 * Keeps live readings coming while this window is visible: renews the
 * server's watch lease on a timer, and at once when the window shows again.
 * A hidden window stops renewing and the lease lapses on its own.
 */
export function useWatchLease(): void {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const renew = () => void rpc.call("watch").catch(() => undefined);
    const sync = () => {
      const visible = document.visibilityState === "visible";
      if (visible && timer === null) {
        renew();
        timer = setInterval(renew, HEARTBEAT_MS);
      } else if (!visible && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      if (timer !== null) clearInterval(timer);
    };
  }, [rpc]);
}
