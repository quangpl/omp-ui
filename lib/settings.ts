import type { Repository } from "@/lib/db/types";
import { isPrimaryColorId } from "@/lib/primary-colors";
import { parseProviderPriority } from "@/lib/provider-priority";
import {
  BROWSER_MODES,
  CLEANUP_SCHEDULES,
  CLUSTER_FAILOVER_LIMITS,
  CLUSTER_HEAL_LIMITS,
  CLUSTER_RESTART_LIMITS,
  DASHBOARD_MENU_IDS,
  DEFAULT_SETTINGS,
  ORCHESTRATION_LIMITS,
  SCHEDULED_CLEANUP_IDS,
  type ClusterHealNumberKey,
  type OrchestrationNumberKey,
  type AppSettings,
  type ApprovalMode,
  type DashboardMenuId,
  type ScheduledCleanupId,
} from "@/lib/types";

const KEY = "app_settings";
/**
 * DASHBOARD_MENU_IDS before `knownDashboardMenus` was stored: settings saved then treat these as the
 * menus the user chose from, so every id added since shows until hidden.
 */
const LEGACY_DASHBOARD_MENUS: readonly string[] = [
  "visualize",
  "containers",
  "terminal",
  "memory",
  "credentials",
  "stats",
  "settings",
];

/**
 * The stored record: AppSettings plus `knownDashboardMenus`, the DASHBOARD_MENU_IDS that existed when
 * it was saved (internal, never in the API), so menus added later show by default.
 */
type StoredSettings = AppSettings & { knownDashboardMenus?: unknown };
const APPROVAL_MODES: ApprovalMode[] = ["yolo", "write", "always-ask"];
/** Highest explicit agent limit (the automatic one has its own cap). */
export const MAX_EXPLICIT_AGENTS = 16;

// On globalThis so every module instance (dev hot reloads, separate bundles) shares the resolver.
const g = globalThis as unknown as { __ompUiOmpPathResolver?: ((stored: string) => string) | null };

/**
 * Map the stored ompPath to the omp command this machine runs (cluster nodes share one settings
 * record: lib/cluster/omp-runtime localOmpCommand); null: the stored value as is. Only
 * getAppSettings applies it; the stored value never changes.
 */
export function setOmpPathResolver(fn: ((stored: string) => string) | null): void {
  g.__ompUiOmpPathResolver = fn;
}

/**
 * Stored settings merged over defaults; env vars override the defaults (saved values win):
 * OMP_PATH, MAX_AGENTS, and auto-healing's OMP_UI_CLUSTER_AUTO_HEAL (true/1/yes/on or
 * false/0/no/off), OMP_UI_CLUSTER_HEAL_INTERVAL_SEC, OMP_UI_CLUSTER_HEAL_TIMEOUT_SEC,
 * OMP_UI_CLUSTER_HEAL_FAILURES, OMP_UI_CLUSTER_HEAL_OFFLINE_SEC and OMP_UI_CLUSTER_HEAL_MAX_RESTARTS
 * (clamped into CLUSTER_HEAL_LIMITS; anything unparsable keeps the built-in default), and the
 * replica disconnect watchdog's OMP_UI_CLUSTER_AUTO_RESTART (same switch values) and
 * OMP_UI_CLUSTER_RESTART_AFTER_SEC (clamped into CLUSTER_RESTART_LIMITS, same fallback).
 * MAX_AGENTS: a number is an explicit limit; `auto` or unset derives it from the machine.
 * `ompPath` is the command to run on this machine (see setOmpPathResolver).
 */
export async function getAppSettings(repo: Repository): Promise<AppSettings> {
  return resolveOmpPath(await storedAppSettings(repo));
}

export async function updateAppSettings(
  repo: Repository,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  // Already current (read through storedAppSettings), so every menu is known.
  const next = sanitize({ ...(await storedAppSettings(repo)), ...patch }, DASHBOARD_MENU_IDS);
  const stored: StoredSettings = { ...next, knownDashboardMenus: [...DASHBOARD_MENU_IDS] };
  await repo.setSetting(KEY, JSON.stringify(stored));
  return resolveOmpPath(next);
}

/** getAppSettings before the ompPath resolver: what updateAppSettings merges with and persists. */
async function storedAppSettings(repo: Repository): Promise<AppSettings> {
  const base: AppSettings = {
    ...DEFAULT_SETTINGS,
    ompPath: process.env.OMP_PATH || DEFAULT_SETTINGS.ompPath,
    maxConcurrentAgents: parseAgentLimit(process.env.MAX_AGENTS) ?? DEFAULT_SETTINGS.maxConcurrentAgents,
    clusterAutoHeal: envFlag(process.env.OMP_UI_CLUSTER_AUTO_HEAL) ?? DEFAULT_SETTINGS.clusterAutoHeal,
    clusterHealIntervalSeconds: healNumber(process.env.OMP_UI_CLUSTER_HEAL_INTERVAL_SEC, "clusterHealIntervalSeconds"),
    clusterHealTimeoutSeconds: healNumber(process.env.OMP_UI_CLUSTER_HEAL_TIMEOUT_SEC, "clusterHealTimeoutSeconds"),
    clusterHealFailures: healNumber(process.env.OMP_UI_CLUSTER_HEAL_FAILURES, "clusterHealFailures"),
    clusterHealOfflineSeconds: healNumber(process.env.OMP_UI_CLUSTER_HEAL_OFFLINE_SEC, "clusterHealOfflineSeconds"),
    clusterHealMaxRestarts: healNumber(process.env.OMP_UI_CLUSTER_HEAL_MAX_RESTARTS, "clusterHealMaxRestarts"),
    clusterAutoRestart: envFlag(process.env.OMP_UI_CLUSTER_AUTO_RESTART) ?? DEFAULT_SETTINGS.clusterAutoRestart,
    clusterRestartAfterSeconds: restartAfterSeconds(process.env.OMP_UI_CLUSTER_RESTART_AFTER_SEC),
  };
  const raw = await repo.getSetting(KEY);
  if (!raw) return base;
  try {
    const { knownDashboardMenus, ...settings } = JSON.parse(raw) as Partial<StoredSettings>;
    return sanitize(
      { ...base, ...settings },
      Array.isArray(knownDashboardMenus) ? knownDashboardMenus : LEGACY_DASHBOARD_MENUS,
    );
  } catch {
    return base;
  }
}

function resolveOmpPath(settings: AppSettings): AppSettings {
  const resolve = g.__ompUiOmpPathResolver;
  return resolve ? { ...settings, ompPath: resolve(settings.ompPath) } : settings;
}

/** `"auto"`, or a whole number clamped to 1…MAX_EXPLICIT_AGENTS; null when `value` is neither. */
export function parseAgentLimit(value: unknown): AppSettings["maxConcurrentAgents"] | null {
  if (typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";
  const n = Math.floor(Number(value));
  if (value === null || value === "" || !Number.isFinite(n) || n < 1) return null;
  return Math.min(MAX_EXPLICIT_AGENTS, n);
}

/** `knownMenus`: the menu ids the stored `visibleDashboardMenus` was chosen from; any other id shows. */
function sanitize(s: AppSettings, knownMenus: readonly unknown[]): AppSettings {
  return {
    // Stored numbers (older versions only had numbers) stay explicit limits.
    maxConcurrentAgents: parseAgentLimit(s.maxConcurrentAgents) ?? DEFAULT_SETTINGS.maxConcurrentAgents,
    ompPath: String(s.ompPath || "omp").trim(),
    approvalMode: APPROVAL_MODES.includes(s.approvalMode) ? s.approvalMode : "yolo",
    defaultModel: String(s.defaultModel ?? "").trim(),
    providerPriority: storedPriority(s.providerPriority),
    smartQueue: typeof s.smartQueue === "boolean" ? s.smartQueue : DEFAULT_SETTINGS.smartQueue,
    browser: BROWSER_MODES.includes(s.browser) ? s.browser : DEFAULT_SETTINGS.browser,
    autoRetry: typeof s.autoRetry === "boolean" ? s.autoRetry : DEFAULT_SETTINGS.autoRetry,
    maxAutoRetries: Number.isFinite(Number(s.maxAutoRetries))
      ? Math.min(20, Math.max(0, Math.floor(Number(s.maxAutoRetries))))
      : DEFAULT_SETTINGS.maxAutoRetries,
    persistentRetry: typeof s.persistentRetry === "boolean" ? s.persistentRetry : DEFAULT_SETTINGS.persistentRetry,
    cleanupSchedule: CLEANUP_SCHEDULES.includes(s.cleanupSchedule) ? s.cleanupSchedule : DEFAULT_SETTINGS.cleanupSchedule,
    // Known ids only, each once, in the canonical order.
    cleanupTargets: Array.isArray(s.cleanupTargets)
      ? SCHEDULED_CLEANUP_IDS.filter((id) => (s.cleanupTargets as unknown[]).includes(id))
      : [...DEFAULT_SETTINGS.cleanupTargets],
    taskCompletionNotifications:
      typeof s.taskCompletionNotifications === "boolean"
        ? s.taskCompletionNotifications
        : DEFAULT_SETTINGS.taskCompletionNotifications,
    // Known ids only, each once, in the canonical order; ids added after the list was saved show,
    // and missing (older settings) shows every menu.
    visibleDashboardMenus: Array.isArray(s.visibleDashboardMenus)
      ? DASHBOARD_MENU_IDS.filter(
          (id) => (s.visibleDashboardMenus as unknown[]).includes(id) || !knownMenus.includes(id),
        )
      : [...DEFAULT_SETTINGS.visibleDashboardMenus],
    primaryColor: isPrimaryColorId(s.primaryColor) ? s.primaryColor : DEFAULT_SETTINGS.primaryColor,
    // Sealed chat bot tokens (lib/server/chat/store.ts); "" when none.
    telegramBotToken: typeof s.telegramBotToken === "string" ? s.telegramBotToken : "",
    discordBotToken: typeof s.discordBotToken === "string" ? s.discordBotToken : "",
    runTimeLimit: bool(s, "runTimeLimit"),
    runTimeLimitMinutes: orchestrationNumber(s.runTimeLimitMinutes, "runTimeLimitMinutes"),
    stallWatchdog: bool(s, "stallWatchdog"),
    stallTimeoutMinutes: orchestrationNumber(s.stallTimeoutMinutes, "stallTimeoutMinutes"),
    runBudget: bool(s, "runBudget"),
    runBudgetUsd: orchestrationNumber(s.runBudgetUsd, "runBudgetUsd"),
    runBudgetTokens: orchestrationNumber(s.runBudgetTokens, "runBudgetTokens"),
    loopDetection: bool(s, "loopDetection"),
    gitCheckpoints: bool(s, "gitCheckpoints"),
    telemetryExport: bool(s, "telemetryExport"),
    telemetryEndpoint: typeof s.telemetryEndpoint === "string" ? s.telemetryEndpoint.trim() : "",
    loadGuard: bool(s, "loadGuard"),
    loadGuardPercent: orchestrationNumber(s.loadGuardPercent, "loadGuardPercent"),
    subagentLimits: bool(s, "subagentLimits"),
    subagentMaxConcurrency: orchestrationNumber(s.subagentMaxConcurrency, "subagentMaxConcurrency"),
    subagentMaxDepth: orchestrationNumber(s.subagentMaxDepth, "subagentMaxDepth"),
    subagentTimeoutMinutes: orchestrationNumber(s.subagentTimeoutMinutes, "subagentTimeoutMinutes"),
    contextCompaction: bool(s, "contextCompaction"),
    contextCompactPercent: orchestrationNumber(s.contextCompactPercent, "contextCompactPercent"),
    wrapUpNudge: bool(s, "wrapUpNudge"),
    wrapUpPercent: orchestrationNumber(s.wrapUpPercent, "wrapUpPercent"),
    clusterRunLocal: bool(s, "clusterRunLocal"),
    clusterFailoverSeconds: failoverSeconds(s.clusterFailoverSeconds),
    clusterAutoHeal: bool(s, "clusterAutoHeal"),
    clusterHealIntervalSeconds: healNumber(s.clusterHealIntervalSeconds, "clusterHealIntervalSeconds"),
    clusterHealTimeoutSeconds: healNumber(s.clusterHealTimeoutSeconds, "clusterHealTimeoutSeconds"),
    clusterHealFailures: healNumber(s.clusterHealFailures, "clusterHealFailures"),
    clusterHealOfflineSeconds: healNumber(s.clusterHealOfflineSeconds, "clusterHealOfflineSeconds"),
    clusterHealMaxRestarts: healNumber(s.clusterHealMaxRestarts, "clusterHealMaxRestarts"),
    clusterAutoRestart: bool(s, "clusterAutoRestart"),
    clusterRestartAfterSeconds: restartAfterSeconds(s.clusterRestartAfterSeconds),
  };
}

/** The stored provider priority; one that no longer validates (older or hand-edited data) is off. */
function storedPriority(value: unknown): AppSettings["providerPriority"] {
  const parsed = parseProviderPriority(value ?? []);
  return parsed.ok ? parsed.entries : [];
}

type BooleanSettingKey = { [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never }[keyof AppSettings];

/** A stored boolean setting, or its default when missing or not a boolean (older settings). */
function bool(s: AppSettings, key: BooleanSettingKey): boolean {
  return typeof s[key] === "boolean" ? s[key] : DEFAULT_SETTINGS[key];
}

/**
 * `value` clamped into the setting's ORCHESTRATION_LIMITS; the default when not a finite number.
 * Dollar amounts keep cents, everything else is a whole number.
 */
export function orchestrationNumber(value: unknown, key: OrchestrationNumberKey): number {
  const n = Number(value);
  if (value === null || value === "" || typeof value === "boolean" || !Number.isFinite(n)) return DEFAULT_SETTINGS[key];
  const { min, max } = ORCHESTRATION_LIMITS[key];
  const rounded = key === "runBudgetUsd" ? Math.round(n * 100) / 100 : Math.floor(n);
  return Math.min(max, Math.max(min, rounded));
}

/** Whole seconds clamped into CLUSTER_FAILOVER_LIMITS; the default when not a finite number. */
function failoverSeconds(value: unknown): number {
  const n = Number(value);
  if (value === null || value === "" || typeof value === "boolean" || !Number.isFinite(n)) {
    return DEFAULT_SETTINGS.clusterFailoverSeconds;
  }
  return Math.min(CLUSTER_FAILOVER_LIMITS.max, Math.max(CLUSTER_FAILOVER_LIMITS.min, Math.floor(n)));
}

/** A whole number clamped into the setting's CLUSTER_HEAL_LIMITS; the default when not a finite number. */
function healNumber(value: unknown, key: ClusterHealNumberKey): number {
  const n = Number(value);
  if (value === undefined || value === null || value === "" || typeof value === "boolean" || !Number.isFinite(n)) {
    return DEFAULT_SETTINGS[key];
  }
  const { min, max } = CLUSTER_HEAL_LIMITS[key];
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Whole seconds clamped into CLUSTER_RESTART_LIMITS; the default when not a finite number. The
 * failover floor (clusterFailoverSeconds + 60 s) is applied at runtime, not here, so a later shorter
 * failover delay does not leave a raised value behind.
 */
function restartAfterSeconds(value: unknown): number {
  const n = Number(value);
  if (value === undefined || value === null || value === "" || typeof value === "boolean" || !Number.isFinite(n)) {
    return DEFAULT_SETTINGS.clusterRestartAfterSeconds;
  }
  return Math.min(CLUSTER_RESTART_LIMITS.max, Math.max(CLUSTER_RESTART_LIMITS.min, Math.floor(n)));
}

/** An env var switch: true/1/yes/on or false/0/no/off (any case); null when unset or anything else. */
function envFlag(value: string | undefined): boolean | null {
  const v = value?.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return null;
}

/** Whether `value` names a navigation menu section the user may hide. */
export function isDashboardMenuId(value: unknown): value is DashboardMenuId {
  return (DASHBOARD_MENU_IDS as readonly unknown[]).includes(value);
}

/** Whether `value` names a cleanup the schedule may run. */
export function isScheduledCleanupId(value: unknown): value is ScheduledCleanupId {
  return (SCHEDULED_CLEANUP_IDS as readonly unknown[]).includes(value);
}
