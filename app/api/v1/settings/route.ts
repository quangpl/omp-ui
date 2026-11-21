import { parseCleanupIds, resetCleanupAnchor } from "@/lib/cleanup";
import { PRIMARY_COLOR_IDS, isPrimaryColorId } from "@/lib/primary-colors";
import { parseProviderPriority } from "@/lib/provider-priority";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { MAX_EXPLICIT_AGENTS, getAppSettings, isDashboardMenuId, updateAppSettings } from "@/lib/settings";
import {
  BROWSER_MODES,
  CLEANUP_SCHEDULES,
  CLUSTER_FAILOVER_LIMITS,
  CLUSTER_HEAL_LIMITS,
  CLUSTER_RESTART_LIMITS,
  DASHBOARD_MENU_IDS,
  ORCHESTRATION_LIMITS,
  REDACTED_SECRET,
  SCHEDULED_CLEANUP_IDS,
  type AppSettings,
  type ApprovalMode,
  type BrowserMode,
  type CleanupSchedule,
  type ClusterHealNumberKey,
  type OrchestrationNumberKey,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const APPROVAL_MODES: readonly ApprovalMode[] = ["yolo", "write", "always-ask"];
const ORCHESTRATION_TOGGLES = [
  "runTimeLimit",
  "stallWatchdog",
  "runBudget",
  "loopDetection",
  "gitCheckpoints",
  "telemetryExport",
  "loadGuard",
  "subagentLimits",
  "contextCompaction",
  "wrapUpNudge",
] as const satisfies readonly (keyof AppSettings)[];

/** Settings → Orchestration fields: switches, bounded numbers, and the OTLP endpoint URL. */
function parseOrchestration(body: Record<string, unknown>, patch: Partial<AppSettings>): void {
  for (const key of ORCHESTRATION_TOGGLES) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") throw new HttpError(400, `${key} must be a boolean`);
    patch[key] = body[key];
  }
  for (const key of Object.keys(ORCHESTRATION_LIMITS) as OrchestrationNumberKey[]) {
    const n = body[key];
    if (n === undefined) continue;
    const { min, max } = ORCHESTRATION_LIMITS[key];
    const whole = key !== "runBudgetUsd";
    if (typeof n !== "number" || !Number.isFinite(n) || (whole && !Number.isInteger(n)) || n < min || n > max) {
      throw new HttpError(400, `${key} must be ${whole ? "an integer" : "a number"} between ${min} and ${max}`);
    }
    patch[key] = n;
  }
  if (body.telemetryEndpoint !== undefined) {
    const url = body.telemetryEndpoint;
    if (typeof url !== "string" || url.trim().length > 2048) {
      throw new HttpError(400, "telemetryEndpoint must be a string of at most 2048 characters");
    }
    const trimmed = url.trim();
    if (trimmed && !/^https?:\/\/\S+$/i.test(trimmed)) {
      throw new HttpError(400, "telemetryEndpoint must be an http(s) URL");
    }
    patch.telemetryEndpoint = trimmed;
  }
}

/**
 * Settings → Cluster fields: run cards on the primary too, the failover delay, auto-healing and the
 * replica disconnect watchdog.
 */
function parseCluster(body: Record<string, unknown>, patch: Partial<AppSettings>): void {
  if (body.clusterRunLocal !== undefined) {
    if (typeof body.clusterRunLocal !== "boolean") throw new HttpError(400, "clusterRunLocal must be a boolean");
    patch.clusterRunLocal = body.clusterRunLocal;
  }
  if (body.clusterFailoverSeconds !== undefined) {
    const n = body.clusterFailoverSeconds;
    const { min, max } = CLUSTER_FAILOVER_LIMITS;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
      throw new HttpError(400, `clusterFailoverSeconds must be an integer between ${min} and ${max}`);
    }
    patch.clusterFailoverSeconds = n;
  }
  if (body.clusterAutoHeal !== undefined) {
    if (typeof body.clusterAutoHeal !== "boolean") throw new HttpError(400, "clusterAutoHeal must be a boolean");
    patch.clusterAutoHeal = body.clusterAutoHeal;
  }
  for (const key of Object.keys(CLUSTER_HEAL_LIMITS) as ClusterHealNumberKey[]) {
    const n = body[key];
    if (n === undefined) continue;
    const { min, max } = CLUSTER_HEAL_LIMITS[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
      throw new HttpError(400, `${key} must be an integer between ${min} and ${max}`);
    }
    patch[key] = n;
  }
  if (body.clusterAutoRestart !== undefined) {
    if (typeof body.clusterAutoRestart !== "boolean") throw new HttpError(400, "clusterAutoRestart must be a boolean");
    patch.clusterAutoRestart = body.clusterAutoRestart;
  }
  if (body.clusterRestartAfterSeconds !== undefined) {
    const n = body.clusterRestartAfterSeconds;
    const { min, max } = CLUSTER_RESTART_LIMITS;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
      throw new HttpError(400, `clusterRestartAfterSeconds must be an integer between ${min} and ${max}`);
    }
    patch.clusterRestartAfterSeconds = n;
  }
}

/** Known fields only: chat bot tokens are never patched here (set via /chat/<platform>/connect). */
function parsePatch(body: Record<string, unknown>): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {};
  if (body.maxConcurrentAgents !== undefined) {
    const n = body.maxConcurrentAgents;
    if (n !== "auto" && (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_EXPLICIT_AGENTS)) {
      throw new HttpError(400, `maxConcurrentAgents must be "auto" or an integer between 1 and ${MAX_EXPLICIT_AGENTS}`);
    }
    patch.maxConcurrentAgents = n === "auto" ? "auto" : Number(n);
  }
  if (body.ompPath !== undefined) {
    const p = body.ompPath;
    if (typeof p !== "string" || !p.trim() || p.trim().length > 1024) {
      throw new HttpError(400, "ompPath must be a non-empty string");
    }
    patch.ompPath = p.trim();
  }
  if (body.approvalMode !== undefined) {
    const mode = body.approvalMode;
    if (typeof mode !== "string" || !(APPROVAL_MODES as readonly string[]).includes(mode)) {
      throw new HttpError(400, `approvalMode must be one of: ${APPROVAL_MODES.join(", ")}`);
    }
    patch.approvalMode = mode as ApprovalMode;
  }
  if (body.defaultModel !== undefined) {
    const model = body.defaultModel;
    if (typeof model !== "string" || model.trim().length > 200) {
      throw new HttpError(400, "defaultModel must be a string of at most 200 characters");
    }
    patch.defaultModel = model.trim();
  }
  if (body.providerPriority !== undefined) {
    const parsed = parseProviderPriority(body.providerPriority);
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    patch.providerPriority = parsed.entries;
  }
  if (body.smartQueue !== undefined) {
    if (typeof body.smartQueue !== "boolean") throw new HttpError(400, "smartQueue must be a boolean");
    patch.smartQueue = body.smartQueue;
  }
  if (body.autoRetry !== undefined) {
    if (typeof body.autoRetry !== "boolean") throw new HttpError(400, "autoRetry must be a boolean");
    patch.autoRetry = body.autoRetry;
  }
  if (body.persistentRetry !== undefined) {
    if (typeof body.persistentRetry !== "boolean") throw new HttpError(400, "persistentRetry must be a boolean");
    patch.persistentRetry = body.persistentRetry;
  }
  if (body.maxAutoRetries !== undefined) {
    const n = body.maxAutoRetries;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 20) {
      throw new HttpError(400, "maxAutoRetries must be an integer between 0 and 20");
    }
    patch.maxAutoRetries = n;
  }
  if (body.browser !== undefined) {
    const mode = body.browser;
    if (typeof mode !== "string" || !(BROWSER_MODES as readonly string[]).includes(mode)) {
      throw new HttpError(400, `browser must be one of: ${BROWSER_MODES.join(", ")}`);
    }
    patch.browser = mode as BrowserMode;
  }
  if (body.cleanupSchedule !== undefined) {
    const schedule = body.cleanupSchedule;
    if (typeof schedule !== "string" || !(CLEANUP_SCHEDULES as readonly string[]).includes(schedule)) {
      throw new HttpError(400, `cleanupSchedule must be one of: ${CLEANUP_SCHEDULES.join(", ")}`);
    }
    patch.cleanupSchedule = schedule as CleanupSchedule;
  }
  if (body.cleanupTargets !== undefined) {
    const ids = parseCleanupIds(body.cleanupTargets, { allowEmpty: true });
    if (!ids) {
      throw new HttpError(400, `cleanupTargets must be an array of: ${SCHEDULED_CLEANUP_IDS.join(", ")}`);
    }
    patch.cleanupTargets = ids;
  }
  if (body.taskCompletionNotifications !== undefined) {
    if (typeof body.taskCompletionNotifications !== "boolean") {
      throw new HttpError(400, "taskCompletionNotifications must be a boolean");
    }
    patch.taskCompletionNotifications = body.taskCompletionNotifications;
  }
  if (body.visibleDashboardMenus !== undefined) {
    const ids = body.visibleDashboardMenus;
    if (!Array.isArray(ids) || !ids.every(isDashboardMenuId)) {
      throw new HttpError(400, `visibleDashboardMenus must be an array of: ${DASHBOARD_MENU_IDS.join(", ")}`);
    }
    patch.visibleDashboardMenus = ids;
  }
  if (body.primaryColor !== undefined) {
    if (!isPrimaryColorId(body.primaryColor)) {
      throw new HttpError(400, `primaryColor must be one of: ${PRIMARY_COLOR_IDS.join(", ")}`);
    }
    patch.primaryColor = body.primaryColor;
  }
  parseOrchestration(body, patch);
  parseCluster(body, patch);
  return patch;
}

/** Stored secrets (sealed chat bot tokens) never leave the server. */
function redact(settings: AppSettings): AppSettings {
  return {
    ...settings,
    telegramBotToken: settings.telegramBotToken ? REDACTED_SECRET : "",
    discordBotToken: settings.discordBotToken ? REDACTED_SECRET : "",
  };
}

export const GET = withApi(async ({ repo }) => json(redact(await getAppSettings(repo))));

export const PATCH = withApi(async ({ req, repo }) => {
  const patch = parsePatch(await readJson(req));
  const before = await getAppSettings(repo);
  const next = await updateAppSettings(repo, patch);
  // A new schedule counts from now, so enabling it never runs a cleanup right away.
  if (next.cleanupSchedule !== before.cleanupSchedule) await resetCleanupAnchor(repo);
  return json(redact(next));
}, { admin: true });
