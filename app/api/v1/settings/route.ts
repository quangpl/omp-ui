import { parseCleanupIds, resetCleanupAnchor } from "@/lib/cleanup";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { MAX_EXPLICIT_AGENTS, getAppSettings, updateAppSettings } from "@/lib/settings";
import {
  BROWSER_MODES,
  CLEANUP_SCHEDULES,
  SCHEDULED_CLEANUP_IDS,
  type AppSettings,
  type ApprovalMode,
  type BrowserMode,
  type CleanupSchedule,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const APPROVAL_MODES: readonly ApprovalMode[] = ["yolo", "write", "always-ask"];

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
  if (body.autoModel !== undefined) {
    if (typeof body.autoModel !== "boolean") throw new HttpError(400, "autoModel must be a boolean");
    patch.autoModel = body.autoModel;
  }
  if (body.smartQueue !== undefined) {
    if (typeof body.smartQueue !== "boolean") throw new HttpError(400, "smartQueue must be a boolean");
    patch.smartQueue = body.smartQueue;
  }
  if (body.autoRetry !== undefined) {
    if (typeof body.autoRetry !== "boolean") throw new HttpError(400, "autoRetry must be a boolean");
    patch.autoRetry = body.autoRetry;
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
  return patch;
}

export const GET = withApi(async ({ repo }) => json(await getAppSettings(repo)));

export const PATCH = withApi(async ({ req, repo }) => {
  const patch = parsePatch(await readJson(req));
  const before = await getAppSettings(repo);
  const next = await updateAppSettings(repo, patch);
  // A new schedule counts from now, so enabling it never runs a cleanup right away.
  if (next.cleanupSchedule !== before.cleanupSchedule) await resetCleanupAnchor(repo);
  return json(next);
});
