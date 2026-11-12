import type { Repository } from "@/lib/db/types";
import { BROWSER_MODES, DEFAULT_SETTINGS, type AppSettings, type ApprovalMode } from "@/lib/types";

const KEY = "app_settings";
const APPROVAL_MODES: ApprovalMode[] = ["yolo", "write", "always-ask"];

/** Stored settings merged over defaults; env vars (OMP_PATH, MAX_AGENTS) override the defaults. */
export async function getAppSettings(repo: Repository): Promise<AppSettings> {
  const base: AppSettings = {
    ...DEFAULT_SETTINGS,
    ompPath: process.env.OMP_PATH || DEFAULT_SETTINGS.ompPath,
    maxConcurrentAgents: Number(process.env.MAX_AGENTS) || DEFAULT_SETTINGS.maxConcurrentAgents,
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

function sanitize(s: AppSettings): AppSettings {
  return {
    maxConcurrentAgents: Math.min(16, Math.max(1, Math.floor(Number(s.maxConcurrentAgents) || 1))),
    ompPath: String(s.ompPath || "omp").trim(),
    approvalMode: APPROVAL_MODES.includes(s.approvalMode) ? s.approvalMode : "yolo",
    defaultModel: String(s.defaultModel ?? "").trim(),
    autoModel: typeof s.autoModel === "boolean" ? s.autoModel : DEFAULT_SETTINGS.autoModel,
    browser: BROWSER_MODES.includes(s.browser) ? s.browser : DEFAULT_SETTINGS.browser,
  };
}
