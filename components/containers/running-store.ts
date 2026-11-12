"use client";

import { useSyncExternalStore } from "react";
import { api } from "@/lib/api-client";
import type { DockerOverview, RunningSummary } from "@/lib/docker-types";

/** Header badge cadence; slower while Docker is unavailable (nothing changes until it starts). */
const POLL_MS = 10_000;
const UNAVAILABLE_POLL_MS = 60_000;

export interface RunningState {
  summary: RunningSummary | null;
  /** The server could not be reached (Docker being down is `summary.available === false`). */
  error: string | null;
}

const INITIAL: RunningState = { summary: null, error: null };

let state = INITIAL;
let updatedAt = 0;
let timer: number | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: RunningState) {
  state = next;
  updatedAt = Date.now();
  for (const listener of listeners) listener();
  schedule();
}

function schedule() {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  if (listeners.size === 0 || document.hidden) return;
  const delay = state.summary && !state.summary.available ? UNAVAILABLE_POLL_MS : POLL_MS;
  timer = window.setTimeout(() => void refreshRunning(), delay);
}

/** Fetch now (deduplicated); every subscriber updates. */
export function refreshRunning(): Promise<void> {
  inFlight ??= api.docker
    .running()
    .then(
      (summary) => set({ summary, error: null }),
      (err: unknown) =>
        set({ summary: state.summary, error: err instanceof Error ? err.message : "Could not reach the server" }),
    )
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** The Containers page loads the full overview anyway: share it instead of polling twice. */
export function publishOverview(overview: DockerOverview) {
  set({
    summary: {
      available: overview.available,
      error: overview.error,
      containers: overview.containers.filter((c) => c.state === "running"),
      composeProjects: overview.composeProjects.filter((p) => p.running > 0),
    },
    error: null,
  });
}

function onVisibility() {
  if (document.hidden) schedule();
  else void refreshRunning();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisibility);
    // Navigating between pages remounts the header: reuse a fresh enough answer.
    if (Date.now() - updatedAt < POLL_MS) schedule();
    else if (!document.hidden) void refreshRunning();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener("visibilitychange", onVisibility);
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
}

/** Running containers + compose projects, polled every 10 s while the tab is visible. */
export function useRunningContainers(): RunningState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  );
}

/** Running container count, or null when unknown / Docker is unavailable (the badge hides). */
export function runningCount(state: RunningState): number | null {
  return state.summary?.available ? state.summary.containers.length : null;
}
