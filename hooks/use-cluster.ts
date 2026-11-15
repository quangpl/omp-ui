"use client";

// Live view of this server's cluster (GET /cluster) shared by every component of the tab: one
// status request, one poll timer and, only while the server is in a cluster, one
// `cluster.updated` / `cluster.notice` subscription (a standalone server, the default, keeps no
// extra event stream open). The feed runs while at least one component uses it.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { api, subscribeEvents } from "@/lib/api-client";
import type { ClusterNotice, ClusterStatus } from "@/lib/types";

/**
 * In a cluster, re-read the status this often (node resources, latency and replication lag
 * change without a membership event).
 */
export const CLUSTER_POLL_MS = 10_000;
/** Standalone: no event stream; this slow poll notices cluster mode turned on in another tab. */
export const STANDALONE_POLL_MS = 60_000;

export interface ClusterState {
  /** Null until the first status arrived. */
  status: ClusterStatus | null;
  /** Why the latest load failed (the last status, if any, is kept); null when it succeeded. */
  error: string | null;
}

const INITIAL: ClusterState = { status: null, error: null };

let state: ClusterState = INITIAL;
const listeners = new Set<() => void>();
const noticeListeners = new Set<(notice: ClusterNotice) => void>();
/** Components using the feed; it starts with the first and stops with the last. */
let consumers = 0;
let feedRunning = false;
/** Closes the event stream; null while none is open. */
let stopStream: (() => void) | null = null;
let pollTimer: number | undefined;
/** Id of the latest status request; answers of older ones are dropped. */
let latestRequest = 0;

function isClustered(): boolean {
  return (state.status?.role ?? "standalone") !== "standalone";
}

function emit(next: ClusterState): void {
  state = next;
  syncStream();
  for (const listener of listeners) listener();
}

/** Replace the shared status, e.g. with the answer of a cluster change (drops older requests in flight). */
export function setClusterStatus(status: ClusterStatus): void {
  latestRequest += 1;
  emit({ status, error: null });
}

/** Re-read GET /cluster now and share the answer. Never throws: a failure lands in `error`. */
export async function refreshClusterStatus(): Promise<void> {
  const request = ++latestRequest;
  try {
    const status = await api.cluster.status();
    if (request === latestRequest) emit({ status, error: null });
  } catch (err) {
    if (request !== latestRequest) return;
    emit({
      status: state.status,
      error: err instanceof Error && err.message ? err.message : "Could not load the cluster status.",
    });
  }
}

/** Open the event stream while the feed runs on a server in a cluster; close it otherwise. */
function syncStream(): void {
  const wanted = feedRunning && isClustered();
  if (wanted && !stopStream) {
    const refresh = () => void refreshClusterStatus();
    stopStream = subscribeEvents(
      (event) => {
        if (event.type === "cluster.updated") setClusterStatus(event.status);
        else if (event.type === "cluster.notice") for (const listener of noticeListeners) listener(event.notice);
      },
      { onFirstOpen: refresh, onReconnect: refresh },
    );
  } else if (!wanted && stopStream) {
    stopStream();
    stopStream = null;
  }
}

/** Next status poll (skipped while the tab is hidden), paced by the current role. */
function schedulePoll(): void {
  pollTimer = window.setTimeout(
    () => {
      if (document.visibilityState === "visible") void refreshClusterStatus();
      schedulePoll();
    },
    isClustered() ? CLUSTER_POLL_MS : STANDALONE_POLL_MS,
  );
}

/** Count one more user of the feed (the first starts the load, poll and stream); the returned function releases it. */
function retainFeed(): () => void {
  consumers += 1;
  if (consumers === 1) {
    feedRunning = true;
    void refreshClusterStatus();
    syncStream();
    schedulePoll();
  }
  return () => {
    consumers -= 1;
    if (consumers > 0) return;
    feedRunning = false;
    window.clearTimeout(pollTimer);
    syncStream();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const release = retainFeed();
  return () => {
    listeners.delete(listener);
    release();
  };
}

/**
 * This server's cluster status, kept live: in a cluster by `cluster.updated` events plus a 10 s
 * poll; standalone by a 60 s poll only. `reload` re-reads it now.
 */
export function useClusterStatus(): ClusterState & { reload: () => Promise<void> } {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  );
  return { ...snapshot, reload: refreshClusterStatus };
}

/** Call `onNotice` for every `cluster.notice` event (sent only in cluster mode) while the calling component is mounted. */
export function useClusterNotices(onNotice: (notice: ClusterNotice) => void): void {
  const handlerRef = useRef(onNotice);
  useEffect(() => {
    handlerRef.current = onNotice;
  });
  useEffect(() => {
    const listener = (notice: ClusterNotice) => handlerRef.current(notice);
    noticeListeners.add(listener);
    const release = retainFeed();
    return () => {
      noticeListeners.delete(listener);
      release();
    };
  }, []);
}
