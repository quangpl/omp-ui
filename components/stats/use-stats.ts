"use client";

import { useCallback, useEffect, useState } from "react";
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

export function useAiStats(): AiState {
  const [stats, setStats] = useState<AiStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setRefreshing(true);
    try {
      setStats(await api.stats.ai(refresh));
      setError(null);
    } catch (err) {
      const message = errorMessage(err, "Could not load AI stats.");
      setError(message);
      if (refresh) toast.error(message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return { stats, error, refreshing, reload: () => void load(true) };
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

/** Live system stats, polled every few seconds while the tab is visible, with a short history. */
export function useSystemStats(): SystemState {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SystemSample[]>([]);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const next = await api.stats.system();
        if (!cancelled) {
          const t = Date.now();
          const sample = toSample(next, t);
          setStats(next);
          setError(null);
          setLastUpdated(t);
          setHistory((prev) => {
            const kept = prev.length >= HISTORY_CAPACITY ? prev.slice(prev.length - HISTORY_CAPACITY + 1) : prev.slice();
            kept.push(sample);
            return kept;
          });
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, "Could not load system stats."));
      } finally {
        inFlight = false;
      }
    };
    void load();
    const id = window.setInterval(() => void load(), SYSTEM_REFRESH_MS);
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { stats, error, history, lastUpdated };
}
