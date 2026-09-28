import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
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
    // Pushes arrive in the order they were taken; their wall-clock stamps
    // may not be in order if the clock was set back.
    setStatus((current) => (current === null ? current : { ...current, latest: payload }));
  });
  return { status, error, retry };
}

/** Before the server has said how long its lease is, and after a failed heartbeat. */
const FIRST_BEAT_MS = 5_000;
const RETRY_MS = 1_000;

/**
 * Keeps live readings coming while this window is visible. Renews the
 * server's watch lease four times per lease, derived from the `leaseMs`
 * each reply carries; at once when the window shows, gains focus, is
 * restored from the back/forward cache or the realtime connection comes
 * back; and a second after a heartbeat fails. A hidden window stops
 * renewing and the lease lapses on its own.
 */
export function useWatchLease(): void {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const renewRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let failing = false;
    let stopped = false;
    const visible = () => document.visibilityState === "visible";
    const schedule = (ms: number) => {
      if (timer !== null) clearTimeout(timer);
      timer = stopped || !visible() ? null : setTimeout(renew, ms);
    };
    function renew() {
      if (stopped || inFlight || !visible()) return;
      inFlight = true;
      rpc.call("watch").then(
        ({ leaseMs }) => {
          inFlight = false;
          failing = false;
          schedule(leaseMs / 4);
        },
        (error: unknown) => {
          inFlight = false;
          // Once per run of failures, so a reload or an outage logs one line.
          if (!failing) console.warn("Hotspot: live-readings heartbeat failed; retrying every second", error);
          failing = true;
          schedule(RETRY_MS);
        },
      );
    }
    renewRef.current = renew;
    const onShow = () => (visible() ? renew() : schedule(0));
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    window.addEventListener("pageshow", onShow);
    renew();
    schedule(FIRST_BEAT_MS);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      renewRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
      window.removeEventListener("pageshow", onShow);
    };
  }, [rpc]);

  // Heartbeats sent while the realtime connection was down may never have
  // arrived; renew as soon as it is back.
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") renewRef.current();
    previous.current = connection;
  }, [connection]);
}
