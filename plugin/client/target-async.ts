import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SetStateAction } from "react";
import type { TargetValue } from "../shared/contracts.ts";
import { errorMessage, targetKey } from "./manager-state.ts";

// Display-only completed reads survive screen remounts. Never retain drafts,
// authority acknowledgments, credentials or in-flight operations here.
const completedReads = new Map<string, unknown>();
export function rememberRead(key: string, value: unknown) {
  completedReads.delete(key); completedReads.set(key, value);
  if (completedReads.size > 32) completedReads.delete(completedReads.keys().next().value!);
}
export function readDisplaySnapshot<T>(key: string): T | null {
  return completedReads.has(key) ? completedReads.get(key) as T : null;
}
export type TargetTicket = { isCurrent: () => boolean };

/** A ticket belongs to one committed target session, including effect replay.
 * String equality alone cannot reject a late A response after A→B→A.
 * Cards own draft/reset policy; this module owns async lifetime only. */
export function useTargetLifetime(key: string | null) {
  const session = useRef<{ key: string | null; active: boolean }>({ key, active: false });
  useLayoutEffect(() => {
    const current = { key, active: true };
    session.current = current;
    return () => { current.active = false; };
  }, [key]);
  return useCallback((): TargetTicket => {
    const issued = session.current;
    return { isCurrent: () => issued.active && issued.key === key && session.current === issued };
  }, [key]);
}

/** The read seam owns snapshot/error state and all completion guards. Adapters
 * project RPC results into the card's snapshot; saves may replace that snapshot
 * after checking their ticket. A fresh target object does not restart a read. */
export function useTargetSnapshot<T>(target: TargetValue | null, key: string | null,
  read: (target: TargetValue) => Promise<T>, namespace?: string) {
  const capture = useTargetLifetime(key);
  const adapter = useRef(read);
  useLayoutEffect(() => { adapter.current = read; });
  const cacheKey = key && namespace ? `${namespace}:${key}` : null;
  const retained = () => cacheKey && completedReads.has(cacheKey) ? completedReads.get(cacheKey) as T : null;
  const [data, setData] = useState<T | null>(retained);
  const [loaded, setLoaded] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replace = (next: SetStateAction<T | null>) => {
    setData(next); setError(null);
    // Replacement may be an optimistic draft projection; only successful
    // read RPCs populate the remount display cache.
  };
  const acceptRead = (next: T) => {
    if (!capture().isCurrent()) return;
    if (cacheKey) rememberRead(cacheKey, next);
    setData(next); setError(null); setLoaded(true); setFresh(true);
  };
  const reload = async (forTarget: TargetValue) => {
    // Old render handlers must not issue a read for the new session.
    if (key !== targetKey(forTarget)) return;
    const ticket = capture();
    if (!ticket.isCurrent()) return;
    setError(null);
    setFresh(false);
    try {
      const next = await adapter.current(forTarget);
      if (ticket.isCurrent()) {
        if (cacheKey) rememberRead(cacheKey, next);
        setData(next); setError(null); setLoaded(true); setFresh(true);
      }
    } catch (cause) {
      if (ticket.isCurrent()) {
        if (!cacheKey) setData(null);
        setError(errorMessage(cause)); setLoaded(true); setFresh(false);
      }
    }
  };
  useEffect(() => {
    setData(retained());
    setLoaded(false); setFresh(false);
    setError(null);
    if (target && key) void reload(target);
    // key is the target identity; neither fresh objects nor adapter identity
    // should cancel a read. Replay runs this effect again with a new ticket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data, error, loaded, available: loaded || (cacheKey !== null && completedReads.has(cacheKey)), fresh, acceptRead, replace, reload, capture };
}
