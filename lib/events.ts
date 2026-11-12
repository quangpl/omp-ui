import type { ServerEvent } from "@/lib/types";

type Listener = (event: ServerEvent) => void;

// Survives dev HMR module reloads: one bus per process.
const g = globalThis as unknown as { __ompUiListeners?: Set<Listener> };
const listeners: Set<Listener> = (g.__ompUiListeners ??= new Set());

/** Broadcast a change to every SSE subscriber. Call after the DB write succeeds. */
export function publish(event: ServerEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must never break the publisher.
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
