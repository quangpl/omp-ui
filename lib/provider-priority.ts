// Provider priority (Settings → AI Providers → Provider priority): the authenticated providers
// agents run on, in order. The first is the Main provider: every run uses it while it has quota.
// A provider counts as out of quota while `omp usage` reports one of its limits exhausted (until
// that limit resets) or after one of our runs on it failed on a quota error (QUOTA_COOLDOWN_MS);
// runs then use the next provider that still has quota, and go back to Main once it has quota
// again. Inside a run, omp's own `retry.fallbackChains` (fallbackOn: any) switches to the next
// providers' models when Main fails on a provider error mid-run — a usage limit or the provider
// being unavailable, so an unavailable Main never fails the run (lib/agent/manager.ts
// runConfigOverlay).
// The list holds providers only: the model a provider runs is role based, taken from the model
// roles of omp's config (resolveProviders).
// Shared by the client and the server: no Node imports.
import type { ModelRoles } from "@/lib/agent/model-select";
import type { AiProviderQuota } from "@/lib/types";

export interface ProviderPriorityEntry {
  /** omp provider id: the first segment of a model selector, e.g. "anthropic" or "openai-codex". */
  provider: string;
}

/** A listed provider with the model it runs: the omp selector of one of its model roles. */
export interface ProviderEntry extends ProviderPriorityEntry {
  /** An omp selector "provider/model-id" (optionally ":thinking"). */
  model: string;
}

export const MAX_PROVIDER_PRIORITY = 8;

/** How long a provider counts as out of quota after a run on it failed on a quota error. */
export const QUOTA_COOLDOWN_MS = 30 * 60_000;

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/i;

/** omp provider id of a model selector ("anthropic/claude-x:high" → "anthropic"); null for roles and bare ids. */
export function selectorProvider(selector: string): string | null {
  const value = selector.trim();
  const slash = value.indexOf("/");
  if (value.startsWith("@") || slash <= 0) return null;
  return value.slice(0, slash);
}

/**
 * The model of an omp role that runs on `provider`: `preferredRole` first, then `default`, then
 * the other roles in their configured order. Null when no role uses the provider.
 */
export function providerRoleModel(roles: ModelRoles | null, provider: string, preferredRole?: string): string | null {
  if (!roles) return null;
  const names = [...new Set([...(preferredRole ? [preferredRole] : []), "default", ...Object.keys(roles)])];
  for (const name of names) {
    const selector = roles[name]?.trim();
    if (selector && selectorProvider(selector) === provider) return selector;
  }
  return null;
}

/**
 * The priority list with each provider's model, from omp's model roles. A provider no role uses
 * has no model to run (an authenticated provider's models are only chosen through roles) and is
 * left out, as is everything while the roles are unknown.
 */
export function resolveProviders(priority: readonly ProviderPriorityEntry[], roles: ModelRoles | null): ProviderEntry[] {
  const entries: ProviderEntry[] = [];
  for (const { provider } of priority) {
    const model = providerRoleModel(roles, provider);
    if (model) entries.push({ provider, model });
  }
  return entries;
}

/** The validated list, or an error message: unique omp provider ids. */
export function parseProviderPriority(value: unknown): { ok: true; entries: ProviderPriorityEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "providerPriority must be an array" };
  if (value.length > MAX_PROVIDER_PRIORITY) {
    return { ok: false, error: `providerPriority holds at most ${MAX_PROVIDER_PRIORITY} providers` };
  }
  const entries: ProviderPriorityEntry[] = [];
  for (const [index, raw] of value.entries()) {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const provider = typeof item.provider === "string" ? item.provider.trim() : "";
    const where = `providerPriority[${index}]`;
    if (!PROVIDER_ID.test(provider)) return { ok: false, error: `${where}.provider must be an omp provider id` };
    if (entries.some((entry) => entry.provider === provider)) {
      return { ok: false, error: `${where}: ${provider} is listed twice` };
    }
    entries.push({ provider });
  }
  return { ok: true, entries };
}

/**
 * Providers out of quota per `omp usage`, each until its latest exhausted limit resets (ms epoch).
 * A limit counts when omp marks it exhausted (or it is fully used) and its reset is still ahead;
 * one without a reset time is skipped: nothing says when to try again, and omp falls back in-run.
 */
export function quotaBlocks(quota: readonly AiProviderQuota[], now: number): Map<string, number> {
  const blocks = new Map<string, number>();
  for (const report of quota) {
    for (const limit of report.limits) {
      const exhausted = limit.status === "exhausted" || (limit.usedFraction ?? 0) >= 1;
      const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
      if (!exhausted || !(resetsAt > now)) continue;
      blocks.set(report.provider, Math.max(blocks.get(report.provider) ?? 0, resetsAt));
    }
  }
  return blocks;
}

export interface ProviderPick {
  /** The entry this run uses. */
  entry: ProviderEntry;
  /** Its position: 0 = Main. */
  index: number;
  /** Earlier entries passed over, with when their quota resets (ms epoch). */
  skipped: { provider: string; until: number }[];
  /** Every provider is out of quota: the run uses Main anyway (the quota retry backs off). */
  allOut: boolean;
  /** Models of the later entries that still have quota: the run's in-session fallback chain. */
  fallbacks: string[];
}

/**
 * The first entry whose provider is not out of quota at `now` (`outOfQuota`: provider → until, ms
 * epoch; entries whose time passed have quota again). Null for an empty list.
 */
export function pickProvider(
  priority: readonly ProviderEntry[],
  outOfQuota: ReadonlyMap<string, number>,
  now: number,
): ProviderPick | null {
  if (priority.length === 0) return null;
  const blockedUntil = (entry: ProviderEntry) => {
    const until = outOfQuota.get(entry.provider) ?? 0;
    return until > now ? until : null;
  };
  const index = priority.findIndex((entry) => blockedUntil(entry) === null);
  const active = index === -1 ? 0 : index;
  const skipped = index === -1 ? [] : priority.slice(0, index).map((entry) => ({ provider: entry.provider, until: blockedUntil(entry)! }));
  const fallbacks = index === -1 ? [] : priority.slice(index + 1).filter((entry) => blockedUntil(entry) === null).map((entry) => entry.model);
  return { entry: priority[active]!, index: active, skipped, allOut: index === -1, fallbacks };
}

/**
 * omp `retry` config (a `--config` overlay section) of a pick: when the active provider's model
 * fails on a provider error mid-run — a usage limit or the provider being unavailable — omp
 * switches to the later providers' models, in order, and back once the failed provider's
 * suppression window ends. `fallbackOn: any` is omp's own default: it covers usage limits and
 * every other provider error, so a backup also takes over when Main is not available at all.
 * Agent-caused failures (a bad request, a tool error) are not provider errors and keep retrying
 * the same model. Null without a pick or fallbacks.
 */
export function fallbackRetryConfig(pick: ProviderPick | null): Record<string, unknown> | null {
  if (!pick || pick.fallbacks.length === 0) return null;
  return {
    modelFallback: true,
    fallbackOn: "any",
    fallbackRevertPolicy: "cooldown-expiry",
    fallbackChains: { [`${pick.entry.provider}/*`]: pick.fallbacks },
  };
}

/**
 * Model of a helper agent (advisor, summary, chat and scheduler assistants).
 * `roles`: [omp role, its selector] in preference order; `pinned`: the board's model; `pick`: the
 * provider priority's pick (null when the list is empty or `pinned` is set). With an empty
 * provider priority the order stays: the first configured role, the pin, the default model. With
 * one, the pin wins, then the first role whose model runs on the picked provider, then the picked
 * entry's model. `role` names the role used.
 */
export function helperModel(input: {
  pinned: string | null | undefined;
  roles: readonly (readonly [name: string, selector: string | undefined])[];
  pick: ProviderPick | null;
  settings: { defaultModel: string; providerPriority: readonly ProviderPriorityEntry[] };
}): { model: string | null; role: string | null } {
  const pinned = input.pinned?.trim() || null;
  const { pick, settings } = input;
  if (settings.providerPriority.length === 0) {
    const [role] = input.roles.find(([, selector]) => selector?.trim()) ?? [];
    if (role) return { model: `@${role}`, role };
    return { model: pinned ?? (settings.defaultModel.trim() || null), role: null };
  }
  if (pinned || !pick) return { model: pinned, role: null };
  const [role] = input.roles.find(([, selector]) => selector && selectorProvider(selector) === pick.entry.provider) ?? [];
  return role ? { model: `@${role}`, role } : { model: pick.entry.model, role: null };
}
