import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { getAppSettings, updateAppSettings } from "@/lib/settings";
import { BROWSER_MODES, type AppSettings, type ApprovalMode, type BrowserMode } from "@/lib/types";

export const dynamic = "force-dynamic";

const APPROVAL_MODES: readonly ApprovalMode[] = ["yolo", "write", "always-ask"];

function parsePatch(body: Record<string, unknown>): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {};
  if (body.maxConcurrentAgents !== undefined) {
    const n = body.maxConcurrentAgents;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 16) {
      throw new HttpError(400, "maxConcurrentAgents must be an integer between 1 and 16");
    }
    patch.maxConcurrentAgents = n;
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
  if (body.browser !== undefined) {
    const mode = body.browser;
    if (typeof mode !== "string" || !(BROWSER_MODES as readonly string[]).includes(mode)) {
      throw new HttpError(400, `browser must be one of: ${BROWSER_MODES.join(", ")}`);
    }
    patch.browser = mode as BrowserMode;
  }
  return patch;
}

export const GET = withApi(async ({ repo }) => json(await getAppSettings(repo)));

export const PATCH = withApi(async ({ req, repo }) => {
  const patch = parsePatch(await readJson(req));
  return json(await updateAppSettings(repo, patch));
});
