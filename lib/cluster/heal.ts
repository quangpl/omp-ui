// Auto-healing on the primary (docs/CLUSTER.md, "Auto-healing"): every round health-checks each
// online replica and asks a node to restart (its bin/supervisor.mjs starts it again) after
// `failures` failed checks in a row, or once it stayed offline `offlineGraceMs`. Restart attempts
// back off (offlineGraceMs * 2^(k-1), at most HEAL_BACKOFF_MAX_MS) and pause after `maxRestarts`
// in a row until the node stayed healthy HEAL_STABLE_MS or the settings change. Pure: the primary
// (lib/cluster/primary.ts) injects the nodes, channels, notices and clock through a HealHost.
import {
  HEAL_BACKOFF_MAX_MS,
  HEAL_STABLE_MS,
  HEAL_STATUS_STALE_MS,
  type BootInfo,
  type HealAckMsg,
  type HealRestartMsg,
  type HealStatusMsg,
} from "@/lib/cluster/types";
import { DEFAULT_SETTINGS, type AppSettings, type ClusterNodeHealth } from "@/lib/types";

/** Auto-healing settings in milliseconds (from AppSettings.clusterAutoHeal / clusterHeal*). */
export interface HealConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
  failures: number;
  offlineGraceMs: number;
  maxRestarts: number;
}

export function healConfigFrom(settings: AppSettings): HealConfig {
  return {
    enabled: settings.clusterAutoHeal,
    intervalMs: settings.clusterHealIntervalSeconds * 1000,
    timeoutMs: settings.clusterHealTimeoutSeconds * 1000,
    failures: settings.clusterHealFailures,
    offlineGraceMs: settings.clusterHealOfflineSeconds * 1000,
    maxRestarts: settings.clusterHealMaxRestarts,
  };
}

/** A replica as the monitor sees it. */
export interface HealNode {
  nodeId: string;
  name: string;
  /** host:port, for messages. */
  address: string;
  online: boolean;
  /** When the node went offline (ms epoch); null while online. */
  offlineSince: number | null;
  /** Last node.status or registration (ms epoch). */
  lastStatusAt: number;
  /** Runs a build with auto-healing (its registration carried `boot`); other nodes are left alone. */
  capable: boolean;
}

export interface HealNotice {
  level: "info" | "warning" | "error";
  message: string;
}

/** What the monitor needs from the primary. */
export interface HealHost {
  nodes(): HealNode[];
  config(): Promise<HealConfig>;
  /** Health check on the member channel; throws when not answered. */
  check(nodeId: string, timeoutMs: number): Promise<HealStatusMsg>;
  /** Restart request: member channel when online, else a probe channel; throws when unreachable. */
  restart(nodeId: string, msg: HealRestartMsg, timeoutMs: number): Promise<HealAckMsg>;
  /** clusterNotice */
  notice(level: HealNotice["level"], message: string): void;
  /** publishClusterStatus */
  changed(): void;
  term(): number;
  now(): number;
}

/** Per-node auto-healing state (ms epoch times). */
interface NodeHeal {
  /** Failed health checks in a row. */
  failures: number;
  problem: string | null;
  /** Restart attempts in a row. */
  restarts: number;
  lastCheckAt: number | null;
  lastRestartAt: number | null;
  /** The latest restart request the node has not registered since, and the boot time it named. */
  pending: { bootedAt: string | null } | null;
  nextAttemptAt: number | null;
  /** Asked to restart; waiting for it to reconnect. */
  restarting: boolean;
  paused: boolean;
  healthySince: number | null;
  bootedAt: string | null;
  /** A check or restart request is in flight. */
  busy: boolean;
  /** The "failed a health check" notice was posted for the current streak. */
  failureNoticed: boolean;
}

/** Until the settings were read once. */
const DEFAULT_INTERVAL_MS = DEFAULT_SETTINGS.clusterHealIntervalSeconds * 1000;

function freshEntry(): NodeHeal {
  return {
    failures: 0,
    problem: null,
    restarts: 0,
    lastCheckAt: null,
    lastRestartAt: null,
    pending: null,
    nextAttemptAt: null,
    restarting: false,
    paused: false,
    healthySince: null,
    bootedAt: null,
    busy: false,
    failureNoticed: false,
  };
}

/** The auto-healing loop of one active primary. */
export class HealMonitor {
  private readonly entries = new Map<string, NodeHeal>();
  /** Settings of the latest round; null before the first one. */
  private config: HealConfig | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly host: HealHost) {}

  /** Run a round now and then every `intervalMs` (re-read each round; rounds never overlap). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.arm(0);
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick()
        .catch((err: unknown) =>
          console.error("[cluster] auto-healing round failed:", err instanceof Error ? err.message : err),
        )
        .finally(() => {
          if (this.running) this.arm(this.config?.intervalMs ?? DEFAULT_INTERVAL_MS);
        });
    }, delayMs);
    this.timer.unref();
  }

  /** One round: re-read the settings, check every online node, restart the ones that need it. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    let config: HealConfig;
    try {
      config = await this.host.config();
    } catch (err) {
      console.warn("[cluster] auto-healing: reading the settings failed:", err instanceof Error ? err.message : err);
      return;
    }
    if (this.stopped) return;
    // Nodes without auto-healing never answer heal.check/heal.restart: no checks, no restarts, no state.
    const nodes = this.host.nodes().filter((node) => node.capable);
    const known = new Set(nodes.map((node) => node.nodeId));
    for (const nodeId of this.entries.keys()) if (!known.has(nodeId)) this.entries.delete(nodeId);
    const before = this.snapshot(nodes);
    const previous = this.config;
    this.config = config;

    const changed = previous && (Object.keys(config) as Array<keyof HealConfig>).some((k) => previous[k] !== config[k]);
    if (changed) {
      for (const entry of this.entries.values()) {
        entry.paused = false;
        entry.restarts = 0;
      }
      console.log("[cluster] Auto-healing settings changed: restart counts reset and paused nodes resumed");
    }
    if (!config.enabled) {
      for (const node of nodes) {
        const entry = this.entry(node.nodeId);
        entry.failures = 0;
        entry.problem = null;
        entry.failureNoticed = false;
        entry.healthySince = null;
      }
    } else {
      await Promise.all(nodes.map((node) => this.visit(node, config)));
    }
    if (!this.stopped && this.snapshot(this.host.nodes().filter((node) => node.capable)) !== before) this.host.changed();
  }

  /**
   * A node registered (primary.ts register()). Resets its failures and returns the notice that
   * replaces the usual "reconnected"/"joined" one, or null to keep that one.
   */
  onRegister(nodeId: string, boot: BootInfo | undefined): HealNotice | null {
    const entry = this.entry(nodeId);
    const name = this.host.nodes().find((node) => node.nodeId === nodeId)?.name ?? nodeId;
    const now = this.host.now();
    const requested = boot?.reason?.startsWith("restart requested") ?? false;
    // A node may act on a request whose ack never arrived: its supervisor then reports "restart requested".
    const actedOnRequest = entry.pending !== null && requested && boot !== undefined && boot.at !== entry.pending.bootedAt;
    let notice: HealNotice | null = null;
    if (entry.restarting || actedOnRequest) {
      notice = { level: "info", message: `Node ${name} is back online after an automatic restart` };
      entry.healthySince = now;
    } else if (boot && entry.bootedAt !== null && boot.at !== entry.bootedAt && boot.reason && !requested) {
      notice = { level: "warning", message: `Node ${name} was restarted on its machine (${boot.reason}) and is back online` };
    }
    entry.restarting = false;
    entry.nextAttemptAt = null;
    entry.pending = null;
    entry.bootedAt = boot?.at ?? null;
    entry.failures = 0;
    entry.failureNoticed = false;
    if (!entry.paused) entry.problem = null;
    return notice;
  }

  /** The node was removed from the cluster. */
  forget(nodeId: string): void {
    this.entries.delete(nodeId);
  }

  health(nodeId: string): ClusterNodeHealth {
    return this.healthOf(nodeId, this.host.nodes().find((node) => node.nodeId === nodeId) ?? null);
  }

  private healthOf(nodeId: string, node: HealNode | null): ClusterNodeHealth {
    const entry = this.entries.get(nodeId) ?? freshEntry();
    const config = this.config;
    const online = node?.online ?? false;
    const enabled = config?.enabled ?? true;
    const state = !enabled
      ? "off"
      : entry.paused
        ? "paused"
        : entry.restarting
          ? "restarting"
          : !online
            ? "offline"
            : entry.failures > 0
              ? "failing"
              : "ok";
    let next: number | null = null;
    if (enabled && !entry.paused) {
      if (!online) {
        const graceEnds = node?.offlineSince != null && config ? node.offlineSince + config.offlineGraceMs : null;
        next = graceEnds === null ? entry.nextAttemptAt : Math.max(graceEnds, entry.nextAttemptAt ?? 0);
      } else if (entry.restarting || entry.failures > 0) {
        next = entry.nextAttemptAt;
      }
    }
    return {
      state,
      failures: entry.failures,
      problem: entry.problem,
      restarts: entry.restarts,
      lastCheckAt: iso(entry.lastCheckAt),
      lastRestartAt: iso(entry.lastRestartAt),
      nextAttemptAt: iso(next),
    };
  }

  private snapshot(nodes: HealNode[]): string {
    return JSON.stringify(nodes.map((node) => this.healthOf(node.nodeId, node)));
  }

  private entry(nodeId: string): NodeHeal {
    let entry = this.entries.get(nodeId);
    if (!entry) {
      entry = freshEntry();
      this.entries.set(nodeId, entry);
    }
    return entry;
  }

  private async visit(node: HealNode, config: HealConfig): Promise<void> {
    const entry = this.entry(node.nodeId);
    if (entry.busy) return;
    entry.busy = true;
    try {
      if (node.online) await this.checkOnline(node, entry, config);
      else await this.checkOffline(node, entry, config);
    } finally {
      entry.busy = false;
    }
  }

  private async checkOffline(node: HealNode, entry: NodeHeal, config: HealConfig): Promise<void> {
    entry.healthySince = null;
    const now = this.host.now();
    if (node.offlineSince === null || now - node.offlineSince < config.offlineGraceMs) return;
    if (entry.nextAttemptAt !== null && now < entry.nextAttemptAt) return;
    await this.attemptRestart(node, entry, config, `offline for ${duration(now - node.offlineSince)}`);
  }

  private async checkOnline(node: HealNode, entry: NodeHeal, config: HealConfig): Promise<void> {
    const started = this.host.now();
    // Asked to restart: it goes down and reconnects shortly; checks resume if it did not by the next attempt.
    if (entry.restarting && entry.nextAttemptAt !== null && started < entry.nextAttemptAt) return;
    entry.lastCheckAt = started;
    let problem: string | null = null;
    try {
      const reply = await this.host.check(node.nodeId, config.timeoutMs);
      entry.bootedAt = reply.bootedAt;
      if (!reply.ok) problem = reply.problem ?? "the node reported a problem";
    } catch (err) {
      problem = errorText(err, config.timeoutMs);
    }
    if (this.stopped) return;
    const now = this.host.now();
    const silent = now - node.lastStatusAt;
    if (problem === null && silent > Math.max(HEAL_STATUS_STALE_MS, config.timeoutMs)) {
      problem = `no status report for ${duration(silent)}`;
    }
    if (problem === null) this.passed(node, entry, now);
    else await this.failed(node, entry, config, problem, now);
  }

  private passed(node: HealNode, entry: NodeHeal, now: number): void {
    if (entry.failures > 0) console.log(`[cluster] Node ${node.name} passed its health check again`);
    if (entry.failureNoticed) this.host.notice("info", `Node ${node.name} is healthy again`);
    entry.failures = 0;
    entry.failureNoticed = false;
    entry.problem = null;
    entry.restarting = false;
    entry.healthySince ??= now;
    if ((entry.restarts > 0 || entry.paused) && now - entry.healthySince >= HEAL_STABLE_MS) {
      console.log(
        `[cluster] Node ${node.name} stayed healthy for ${duration(HEAL_STABLE_MS)}: ` +
          (entry.paused ? "auto-healing resumed" : "restart count reset"),
      );
      entry.restarts = 0;
      entry.paused = false;
      entry.nextAttemptAt = null;
    }
  }

  private async failed(node: HealNode, entry: NodeHeal, config: HealConfig, problem: string, now: number) {
    entry.failures++;
    entry.problem = problem;
    entry.healthySince = null;
    console.warn(`[cluster] Node ${node.name} failed a health check (${entry.failures}/${config.failures}): ${problem}`);
    if (entry.failures === 1) {
      this.host.notice("warning", `Node ${node.name} failed a health check: ${problem}`);
      entry.failureNoticed = true;
    }
    if (entry.failures < config.failures) return;
    if (entry.nextAttemptAt !== null && now < entry.nextAttemptAt) return;
    await this.attemptRestart(node, entry, config, `${config.failures} failed health checks in a row (${problem})`);
  }

  private async attemptRestart(node: HealNode, entry: NodeHeal, config: HealConfig, reason: string): Promise<void> {
    if (entry.paused) return;
    const max = config.maxRestarts;
    if (entry.restarts >= max) {
      entry.paused = true;
      this.host.notice(
        "error",
        `Auto-healing paused for node ${node.name} after ${max} restart attempts in a row (${entry.problem ?? reason}): ` +
          `it resumes once the node has been healthy for ${duration(HEAL_STABLE_MS)} or the auto-healing settings change; ` +
          "restart the node by hand meanwhile",
      );
      return;
    }
    const now = this.host.now();
    const bootedAt = entry.bootedAt;
    entry.restarts++;
    const attempt = entry.restarts;
    const delayMs = Math.min(HEAL_BACKOFF_MAX_MS, config.offlineGraceMs * 2 ** (attempt - 1));
    entry.lastRestartAt = now;
    entry.pending = { bootedAt };
    entry.nextAttemptAt = now + delayMs;
    console.warn(`[cluster] Node ${node.name}: ${reason}; restarting it (attempt ${attempt} of ${max})`);
    const msg: HealRestartMsg = {
      t: "heal.restart",
      reason,
      term: this.host.term(),
      bootedAt,
    };
    let ack: HealAckMsg;
    try {
      ack = await this.host.restart(node.nodeId, msg, config.timeoutMs);
    } catch (err) {
      if (this.stopped) return;
      const text = errorText(err, config.timeoutMs);
      const counts = `attempt ${attempt} of ${max}; next try in ${duration(delayMs)}`;
      console.warn(`[cluster] Node ${node.name}: the restart request failed (${counts}): ${text}`);
      if (node.online) {
        entry.problem = `no answer to the restart request: ${text}`;
        if (attempt === 1) {
          this.host.notice("warning", `Node ${node.name} did not answer the restart request (${counts}): ${text}`);
        }
      } else {
        entry.problem = `unreachable: ${text}`;
        if (attempt === 1) {
          this.host.notice(
            "warning",
            `Node ${node.name} has been offline for ${duration(now - (node.offlineSince ?? now))} and does not answer at ` +
              `${node.address}: it cannot be restarted from here (${counts})`,
          );
        }
      }
      return;
    }
    if (this.stopped) return;
    if (ack.outcome === "restarting") {
      entry.restarting = true;
      this.host.notice("warning", `Node ${node.name} is unhealthy (${reason}): restarting it (attempt ${attempt} of ${max})`);
    } else if (ack.outcome === "already") {
      // Another process than the one we named runs there: it restarted already and should reconnect.
      entry.restarting = true;
      entry.bootedAt = ack.bootedAt;
      console.log(`[cluster] Node ${node.name} already restarted (booted ${ack.bootedAt}); waiting for it to reconnect`);
    } else {
      entry.paused = true;
      entry.problem = ack.error ?? "the node refused to restart";
      this.host.notice("warning", `Could not restart node ${node.name}: ${entry.problem}`);
    }
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Whole seconds below two minutes, else whole minutes ("30 s", "2 min"). */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** A channel request timeout reads "no answer within N s"; anything else is its message. */
function errorText(err: unknown, timeoutMs: number): string {
  const message = err instanceof Error ? err.message : String(err);
  return /^No reply to /.test(message) ? `no answer within ${duration(timeoutMs)}` : message;
}
