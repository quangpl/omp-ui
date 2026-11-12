import type { Repository } from "@/lib/db/types";
import {
  BROWSER_MODES,
  CLEANUP_SCHEDULES,
  DEFAULT_SETTINGS,
  SCHEDULED_CLEANUP_IDS,
  type AppSettings,
  type ApprovalMode,
  type ScheduledCleanupId,
} from "@/lib/types";

const KEY = "app_settings";
const APPROVAL_MODES: ApprovalMode[] = ["yolo", "write", "always-ask"];
/** Highest explicit agent limit (the automatic one has its own cap). */
export const MAX_EXPLICIT_AGENTS = 16;

/**
 * Stored settings merged over defaults; env vars (OMP_PATH, MAX_AGENTS) override the defaults.
 * MAX_AGENTS: a number is an explicit limit; `auto` or unset derives it from the machine.
 */
export async function getAppSettings(repo: Repository): Promise<AppSettings> {
  const base: AppSettings = {
    ...DEFAULT_SETTINGS,
    ompPath: process.env.OMP_PATH || DEFAULT_SETTINGS.ompPath,
    maxConcurrentAgents: parseAgentLimit(process.env.MAX_AGENTS) ?? DEFAULT_SETTINGS.maxConcurrentAgents,
  };
  const raw = await repo.getSetting(KEY);
  if (!raw) return base;
  try {
    return sanitize({ ...base, ...(JSON.parse(raw) as Partial<AppSettings>) });
  } catch {
    return base;
  }
}

export async function updateAppSettings(
  repo: Repository,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const next = sanitize({ ...(await getAppSettings(repo)), ...patch });
  await repo.setSetting(KEY, JSON.stringify(next));
  return next;
}

/** `"auto"`, or a whole number clamped to 1…MAX_EXPLICIT_AGENTS; null when `value` is neither. */
export function parseAgentLimit(value: unknown): AppSettings["maxConcurrentAgents"] | null {
  if (typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";
  const n = Math.floor(Number(value));
  if (value === null || value === "" || !Number.isFinite(n) || n < 1) return null;
  return Math.min(MAX_EXPLICIT_AGENTS, n);
}

function sanitize(s: AppSettings): AppSettings {
  return {
    // Stored numbers (older versions only had numbers) stay explicit limits.
    maxConcurrentAgents: parseAgentLimit(s.maxConcurrentAgents) ?? DEFAULT_SETTINGS.maxConcurrentAgents,
    ompPath: String(s.ompPath || "omp").trim(),
    approvalMode: APPROVAL_MODES.includes(s.approvalMode) ? s.approvalMode : "yolo",
    defaultModel: String(s.defaultModel ?? "").trim(),
    autoModel: typeof s.autoModel === "boolean" ? s.autoModel : DEFAULT_SETTINGS.autoModel,
    smartQueue: typeof s.smartQueue === "boolean" ? s.smartQueue : DEFAULT_SETTINGS.smartQueue,
    browser: BROWSER_MODES.includes(s.browser) ? s.browser : DEFAULT_SETTINGS.browser,
    autoRetry: typeof s.autoRetry === "boolean" ? s.autoRetry : DEFAULT_SETTINGS.autoRetry,
    maxAutoRetries: Number.isFinite(Number(s.maxAutoRetries))
      ? Math.min(20, Math.max(0, Math.floor(Number(s.maxAutoRetries))))
      : DEFAULT_SETTINGS.maxAutoRetries,
    cleanupSchedule: CLEANUP_SCHEDULES.includes(s.cleanupSchedule) ? s.cleanupSchedule : DEFAULT_SETTINGS.cleanupSchedule,
    // Known ids only, each once, in the canonical order.
    cleanupTargets: Array.isArray(s.cleanupTargets)
      ? SCHEDULED_CLEANUP_IDS.filter((id) => (s.cleanupTargets as unknown[]).includes(id))
      : [...DEFAULT_SETTINGS.cleanupTargets],
  };
}

/** Whether `value` names a cleanup the schedule may run. */
export function isScheduledCleanupId(value: unknown): value is ScheduledCleanupId {
  return (SCHEDULED_CLEANUP_IDS as readonly unknown[]).includes(value);
}
