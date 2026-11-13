"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/components/stats/shared";
import { api } from "@/lib/api-client";
import type { AiStats, SystemStats } from "@/lib/types";

export const SYSTEM_REFRESH_MS = 5000;
/** Samples kept for live charts: 60 × 5 s = the last 5 minutes. */
export const HISTORY_CAPACITY = 60;

/** One successful system poll, reduced to the values the live charts plot. */
export interface SystemSample {
  t: number;
  /** 0–1 */
  cpu: number;
  /** 0–1 */
  memory: number;
  /** 0–1; null when the disk is unavailable. */
  disk: number | null;
  load1: number;
  agentsRunning: number;
  agentsQueued: number;
  rssBytes: number;
}

export interface SystemState {
  stats: SystemStats | null;
  error: string | null;
  /** Oldest first, at most HISTORY_CAPACITY samples. */
  history: SystemSample[];
  /** Date.now() of the last successful poll. */
  lastUpdated: number | null;
}

export interface AiState {
  stats: AiStats | null;
  error: string | null;
  refreshing: boolean;
  reload: () => void;
}

/** Current time, re-read every `intervalMs` so relative labels stay fresh. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Module-level snapshot store shared by every consumer of a hook. While at least one component is subscribed,
 * `poll` runs immediately, every SYSTEM_REFRESH_MS and whenever the tab becomes visible again; ticks are skipped while
 * the tab is hidden or a previous tick is still in flight. The snapshot outlives its subscribers so remounting
 * consumers (e.g. after navigation) render the last values instantly.
 */
interface PolledStore<T> {
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  /** Replaces the snapshot (when changed) and notifies subscribers. */
  update: (next: (prev: T) => T) => void;
  subscribe: (listener: () => void) => () => void;
}

function createPolledStore<T>(initial: T, poll: () => Promise<void>): PolledStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  let intervalId: number | undefined;
  let inFlight = false;

  const tick = async () => {
    if (document.hidden || inFlight) return;
    inFlight = true;
    try {
      await poll();
    } finally {
      inFlight = false;
    }
  };
  const onVisibility = () => {
    if (!document.hidden) void tick();
  };

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    update: (next) => {
      const value = next(snapshot);
      if (value === snapshot) return;
      snapshot = value;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        void tick();
        intervalId = window.setInterval(() => void tick(), SYSTEM_REFRESH_MS);
        document.addEventListener("visibilitychange", onVisibility);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        window.clearInterval(intervalId);
        intervalId = undefined;
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
  };
}

/** Requests that should spin the refresh indicator (manual reloads and the very first load). */
let aiSpinning = 0;
/** Sequence of the latest AI request issued / applied, so a slow older response never overwrites a newer one. */
let aiIssued = 0;
let aiApplied = 0;

async function loadAi(refresh: boolean): Promise<void> {
  const seq = ++aiIssued;
  const prev = aiStore.getSnapshot();
  const spin = refresh || (prev.stats === null && prev.error === null);
  if (spin) {
    aiSpinning++;
    aiStore.update((s) => (s.refreshing ? s : { ...s, refreshing: true }));
  }
  try {
    const stats = await api.stats.ai(refresh);
    if (seq > aiApplied) {
      aiApplied = seq;
      aiStore.update((s) => ({ ...s, stats, error: null }));
    }
  } catch (err) {
    const message = errorMessage(err, "Could not load AI stats.");
    if (seq > aiApplied) {
      aiApplied = seq;
      aiStore.update((s) => (s.error === message ? s : { ...s, error: message }));
    }
    if (refresh) toast.error(message);
  } finally {
    if (spin && --aiSpinning === 0) aiStore.update((s) => (s.refreshing ? { ...s, refreshing: false } : s));
  }
}

/** Stable for the lifetime of the module; forces a fresh (uncached) quota fetch. */
function reloadAi(): void {
  void loadAi(true);
}

const aiStore = createPolledStore<AiState>({ stats: null, error: null, refreshing: false, reload: reloadAi }, () =>
  loadAi(false),
);

/**
 * AI usage and quota, shared by every mounted consumer: one poller (cheap, the server caches for 60 s) runs every
 * SYSTEM_REFRESH_MS while the tab is visible. `refreshing` is true only for the first load and manual `reload()`s;
 * only manual reload errors are toasted.
 */
export function useAiStats(): AiState {
  return useSyncExternalStore(aiStore.subscribe, aiStore.getSnapshot, aiStore.getServerSnapshot);
}

function toSample(stats: SystemStats, t: number): SystemSample {
  const { cpu, memory, disk, app, process } = stats;
  return {
    t,
    cpu: cpu.usagePercent / 100,
    memory: memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : 0,
    disk: disk && disk.totalBytes > 0 ? disk.usedBytes / disk.totalBytes : null,
    load1: cpu.loadAvg[0],
    agentsRunning: app.agentsRunning,
    agentsQueued: app.agentsQueued,
    rssBytes: process.rssBytes,
  };
}

async function loadSystem(): Promise<void> {
  try {
    const stats = await api.stats.system();
    const t = Date.now();
    const sample = toSample(stats, t);
    systemStore.update((prev) => {
      const history =
        prev.history.length >= HISTORY_CAPACITY
          ? prev.history.slice(prev.history.length - HISTORY_CAPACITY + 1)
          : prev.history.slice();
      history.push(sample);
      return { stats, error: null, history, lastUpdated: t };
    });
  } catch (err) {
    const message = errorMessage(err, "Could not load system stats.");
    systemStore.update((prev) => (prev.error === message ? prev : { ...prev, error: message }));
  }
}

const systemStore = createPolledStore<SystemState>(
  { stats: null, error: null, history: [], lastUpdated: null },
  loadSystem,
);

/**
 * Live system stats with a short history, shared by every mounted consumer: one poller runs every SYSTEM_REFRESH_MS
 * while the tab is visible and any consumer is mounted; history keeps accumulating across navigations.
 */
export function useSystemStats(): SystemState {
  return useSyncExternalStore(systemStore.subscribe, systemStore.getSnapshot, systemStore.getServerSnapshot);
}
