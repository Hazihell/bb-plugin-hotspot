import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { Status, rpcContract } from "../lib/contract";
import { LIVE, type LiveSignal, SAMPLED, type WatchReason } from "../lib/signals";

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
 * back; and a second after a heartbeat fails. A heartbeat still unanswered
 * after one beat is given up on and sent again; a late answer only
 * reschedules. Each heartbeat says why it was sent. A hidden window stops
 * renewing and the lease lapses on its own.
 */
export function useWatchLease(): void {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const renewRef = useRef<(reason: WatchReason) => void>(() => undefined);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let beatMs = FIRST_BEAT_MS;
    /** The heartbeat awaiting an answer: its number and when it was sent; null when none is. */
    let pending: { id: number; sentAt: number } | null = null;
    let sent = 0;
    let failing = false;
    let stopped = false;
    const visible = () => document.visibilityState === "visible";
    const schedule = (ms: number, reason: WatchReason) => {
      if (timer !== null) clearTimeout(timer);
      timer = stopped || !visible() ? null : setTimeout(() => renew(reason), ms);
    };
    function renew(reason: WatchReason) {
      if (stopped || !visible()) return;
      const age = pending === null ? Number.POSITIVE_INFINITY : performance.now() - pending.sentAt;
      // One is on its way: come back when it has had a full beat to answer.
      if (age < beatMs) return schedule(beatMs - age + 1, "timer");
      const id = ++sent;
      pending = { id, sentAt: performance.now() };
      // Should this one never settle, the timer sends the next.
      schedule(beatMs, "timer");
      rpc.call("watch", { reason }).then(
        ({ leaseMs }) => {
          beatMs = leaseMs / 4;
          if (id !== sent) return schedule(beatMs, "timer");
          pending = null;
          failing = false;
          schedule(beatMs, "timer");
        },
        (error: unknown) => {
          if (id !== sent) return;
          pending = null;
          // Once per run of failures, so a reload or an outage logs one line.
          if (!failing) console.warn("Hotspot: live-readings heartbeat failed; retrying every second", error);
          failing = true;
          schedule(RETRY_MS, "retry");
        },
      );
    }
    renewRef.current = renew;
    const onVisibility = () => {
      console.debug(`Hotspot: window ${document.visibilityState}`);
      if (visible()) renew("shown");
      else schedule(0, "timer");
    };
    const onFocus = () => renew("focus");
    const onPageShow = () => renew("pageshow");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    renew("mount");
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      renewRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [rpc]);

  // Heartbeats sent while the realtime connection was down may never have
  // arrived; renew as soon as it is back.
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") renewRef.current("reconnect");
    previous.current = connection;
  }, [connection]);
}
