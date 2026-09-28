import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Status, rpcContract } from "../lib/contract";
import { SAMPLED } from "../lib/signals";

export interface StatusState {
  /** The last status read; kept while a later read fails. */
  status: Status | null;
  /** Why the last read failed, until one succeeds. */
  error: string | null;
  retry: () => void;
}

/** The latest sample and open episode, refetched after every sample the server publishes. */
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
  return { status, error, retry };
}
