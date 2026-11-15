// Disconnect watchdog of a replica (docs/CLUSTER.md, "Auto-restart"): pure decisions. The replica
// (lib/cluster/replica.ts) checks every WATCHDOG_MS; once it has had no session with its primary for
// autoRestartWaitMs it restarts through bin/supervisor.mjs (exit 75), so it boots and joins again.
// The wait is clusterRestartAfterSeconds, never shorter than clusterFailoverSeconds +
// FAILOVER_GRACE_MS (a failover election always runs first), doubled for every restart in a row
// without a session in between (NodeState.autoRestarts), at most BACKOFF_MAX_MS unless the base
// wait is longer. A node without the supervisor would not come back: it only gets a notice.
import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/types";

/** How often the replica's watchdog checks its link to the primary. */
export const WATCHDOG_MS = 5_000;
/** Time a failover election gets after clusterFailoverSeconds before a restart may cut it short. */
export const FAILOVER_GRACE_MS = 60_000;
/** Longest wait the doubling reaches (a longer clusterRestartAfterSeconds is kept as is). */
export const BACKOFF_MAX_MS = 60 * 60_000;

/** Disconnect watchdog settings in milliseconds (from AppSettings.clusterAutoRestart / clusterRestartAfterSeconds). */
export interface AutoRestartConfig {
  enabled: boolean;
  /** clusterRestartAfterSeconds. */
  afterMs: number;
  /** clusterFailoverSeconds. */
  failoverMs: number;
}

export function autoRestartConfigFrom(settings: AppSettings): AutoRestartConfig {
  return {
    enabled: settings.clusterAutoRestart,
    afterMs: settings.clusterRestartAfterSeconds * 1000,
    failoverMs: settings.clusterFailoverSeconds * 1000,
  };
}

/** Until the settings were read once, or when they cannot be read. */
export const DEFAULT_AUTO_RESTART: AutoRestartConfig = autoRestartConfigFrom(DEFAULT_SETTINGS);

/** How long the link may stay down before the next restart, after `restarts` restarts in a row. */
export function autoRestartWaitMs(config: AutoRestartConfig, restarts: number): number {
  const base = Math.max(config.afterMs, config.failoverMs + FAILOVER_GRACE_MS);
  const cap = Math.max(base, BACKOFF_MAX_MS);
  const doublings = Number.isFinite(restarts) ? Math.min(Math.max(0, Math.floor(restarts)), 30) : 0;
  return Math.min(cap, base * 2 ** doublings);
}

export type AutoRestartDecision =
  | { action: "wait" }
  /** Restart now; `reason` goes to the log, the notice and OMP_UI_RESTART_REASON. */
  | { action: "restart"; reason: string }
  /** Due, but bin/supervisor.mjs would not bring the node back: tell the admin, keep reconnecting. */
  | { action: "notice"; reason: string };

export interface AutoRestartInput {
  config: AutoRestartConfig;
  /** A welcomed session with the primary is up. */
  connected: boolean;
  /** When the last session ended (or this process first started its replica runtime), ms epoch. */
  unlinkedSince: number;
  now: number;
  /** NodeState.autoRestarts. */
  restarts: number;
  /** Runs under bin/supervisor.mjs (isSupervised()). */
  supervised: boolean;
  /** Name of the primary this node follows; null when it knows none. */
  primary: string | null;
  /** Why the last connect attempt failed; null when unknown. */
  error: string | null;
}

/** What the watchdog does on one check. */
export function decideAutoRestart(input: AutoRestartInput): AutoRestartDecision {
  const { config, connected, unlinkedSince, now, restarts, supervised, primary, error } = input;
  if (!config.enabled || connected) return { action: "wait" };
  const downMs = now - unlinkedSince;
  if (downMs < autoRestartWaitMs(config, restarts)) return { action: "wait" };
  const target = primary ? `the primary ${primary}` : "a primary";
  const reason = `no connection to ${target} for ${duration(downMs)}${error ? ` (last error: ${error})` : ""}`;
  return supervised ? { action: "restart", reason } : { action: "notice", reason };
}

/** Whole seconds below two minutes, else whole minutes ("90 s", "5 min"). */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}
