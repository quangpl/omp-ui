// The provider priority (lib/provider-priority.ts) on the server: which providers are out of quota
// right now (limits `omp usage` reports exhausted, via the shared 60 s cache of lib/stats.ts
// getAiStats, plus the cooldowns runs that failed on a quota error started, markOutOfQuota), the
// pick every run and helper agent uses (chooseProvider), and helper agents' model and config.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readModelRoles, type ModelRoles } from "@/lib/agent/model-select";
import { childEnv } from "@/lib/child-env";
import { dataDir } from "@/lib/files";
import {
  QUOTA_COOLDOWN_MS,
  fallbackRetryConfig,
  helperModel,
  pickProvider,
  quotaBlocks,
  resolveProviders,
  type ProviderPick,
} from "@/lib/provider-priority";
import { getAiStats } from "@/lib/stats";
import type { AppSettings } from "@/lib/types";

/** A launch waits at most this long for `omp usage`; a slower read leaves every provider available. */
const USAGE_WAIT_MS = 5_000;

// On globalThis so dev hot reloads share the cooldowns.
const g = globalThis as unknown as { __ompUiQuotaCooldowns?: Map<string, number> };

function cooldowns(): Map<string, number> {
  g.__ompUiQuotaCooldowns ??= new Map();
  return g.__ompUiQuotaCooldowns;
}

/** A run on `provider` failed on a quota error: it counts as out of quota for QUOTA_COOLDOWN_MS. */
export function markOutOfQuota(provider: string, now = Date.now()): void {
  const until = now + QUOTA_COOLDOWN_MS;
  const map = cooldowns();
  map.set(provider, Math.max(map.get(provider) ?? 0, until));
}

/**
 * Provider → until when (ms epoch) it is out of quota: `omp usage` exhausted limits and run
 * cooldowns, whichever lasts longer. Never rejects; an unavailable or slow `omp usage` counts
 * only the cooldowns.
 */
export async function outOfQuotaProviders(ompPath: string): Promise<Map<string, number>> {
  const { promise: timeout, resolve } = Promise.withResolvers<null>();
  const timer = setTimeout(() => resolve(null), USAGE_WAIT_MS);
  const stats = await Promise.race([getAiStats(ompPath).catch(() => null), timeout]);
  clearTimeout(timer);
  const now = Date.now();
  const blocks = quotaBlocks(stats?.quota.providers ?? [], now);
  for (const [provider, until] of cooldowns()) {
    if (until <= now) cooldowns().delete(provider);
    else blocks.set(provider, Math.max(blocks.get(provider) ?? 0, until));
  }
  return blocks;
}

/**
 * The provider priority's pick for a run or helper agent: the first provider with quota, running
 * the model of one of omp's model `roles` on it (providers no role uses are skipped). Null when
 * the list is empty, no listed provider has a role or `pinned` (the board's model) is set: a
 * pinned model is an explicit choice, so it skips the quota check. Never rejects.
 */
export async function chooseProvider(
  settings: Pick<AppSettings, "ompPath" | "providerPriority">,
  pinned: string | null | undefined,
  roles: ModelRoles | null,
): Promise<ProviderPick | null> {
  if (settings.providerPriority.length === 0 || pinned?.trim()) return null;
  const entries = resolveProviders(settings.providerPriority, roles);
  if (entries.length === 0) return null;
  return pickProvider(entries, await outOfQuotaProviders(settings.ompPath), Date.now());
}

/**
 * Model and `--config` overlay of a helper agent (lib/provider-priority.ts helperModel), from the
 * provider priority's pick: the overlay holds the pick's mid-run fallback to the backup providers
 * (fallbackRetryConfig). It is written once per distinct content, so pooled helper workers with
 * the same pick are reused. `config` is null without fallbacks. `modelRoles`: the roles omp
 * resolves for the helper; read here (global config) when not given.
 */
export async function chooseHelperModel(input: {
  settings: Pick<AppSettings, "ompPath" | "providerPriority" | "defaultModel">;
  pinned: string | null | undefined;
  roles: readonly (readonly [name: string, selector: string | undefined])[];
  modelRoles?: ModelRoles | null;
}): Promise<{ model: string | null; role: string | null; config: string | null }> {
  const modelRoles =
    input.modelRoles !== undefined || input.settings.providerPriority.length === 0
      ? (input.modelRoles ?? null)
      : await readModelRoles(input.settings.ompPath, dataDir(), childEnv());
  const pick = await chooseProvider(input.settings, input.pinned, modelRoles);
  const choice = helperModel({ ...input, pick });
  // The chain's key is "<provider>/*": a role model on the picked provider falls back too.
  const retry = fallbackRetryConfig(pick);
  if (!retry) return { ...choice, config: null };
  const text = `${JSON.stringify({ retry }, null, 2)}\n`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const dir = path.join(dataDir(), "runtime");
  const file = path.join(dir, `omp-helper-config-${hash}.yml`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, text);
  return { ...choice, config: file };
}
