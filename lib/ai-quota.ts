// Pure helpers over the quota reports `omp usage` returns, shared by the header metrics and the
// Stats page. The active providers come from Settings → AI Providers → Provider priority: the
// providers agents run on, in order. omp only reports providers it can read limits for, so an
// active provider (e.g. an API-key provider) can be missing from the reports; it still shows.
import type { AiProviderQuota, AiQuotaLimit } from "@/lib/types";

/** Used fraction at which a provider counts as near its limit; the Stats page warns from here. */
export const NEAR_LIMIT = 0.75;

export interface ProviderPeak {
  /** The provider's most-used limit. */
  limit: AiQuotaLimit;
  /** Its used fraction, 0–1. */
  fraction: number;
}

/** The provider's most-used limit; limits without a known fraction are skipped. Null when none reports one. */
export function providerPeak(provider: AiProviderQuota): ProviderPeak | null {
  let peak: ProviderPeak | null = null;
  for (const limit of provider.limits) {
    const fraction = limit.usedFraction;
    if (fraction === null || fraction === undefined) continue;
    if (!peak || fraction > peak.fraction) peak = { limit, fraction };
  }
  return peak;
}

export interface ProviderQuotaView {
  provider: AiProviderQuota;
  /** Its most-used limit; null when it reports none with a fraction. */
  peak: ProviderPeak | null;
}

/**
 * The providers the UI shows, in display order: the active providers in priority order, then any
 * other provider omp reports. An active provider without a report gets an empty one, so its panel
 * says no limits were reported instead of disappearing. With an empty priority list the reports
 * keep omp's order. Duplicate provider ids are dropped.
 */
export function providerQuotaViews(
  activeProviders: readonly string[],
  reported: readonly AiProviderQuota[],
): ProviderQuotaView[] {
  const byId = new Map(reported.map((provider) => [provider.provider, provider]));
  const seen = new Set<string>();
  const views: ProviderQuotaView[] = [];
  const add = (provider: AiProviderQuota) => {
    if (seen.has(provider.provider)) return;
    seen.add(provider.provider);
    views.push({ provider, peak: providerPeak(provider) });
  };
  for (const id of activeProviders) {
    add(byId.get(id) ?? { provider: id, account: null, fetchedAt: null, limits: [] });
  }
  for (const provider of reported) add(provider);
  return views;
}

export interface QuotaAggregate {
  /** Every provider the UI shows, active first. */
  providers: ProviderQuotaView[];
  /** Mean of the reporting providers' peaks, 0–1; null when none reports a fraction. */
  fraction: number | null;
  /** Highest provider peak, 0–1; null when none reports a fraction. */
  worst: number | null;
  /** Providers that report a usable fraction. */
  reporting: number;
  /** Reporting providers at or above `NEAR_LIMIT`. */
  nearLimit: number;
}

/**
 * One summary for the whole provider set: the mean usage across providers that report a fraction
 * (each provider weighs the same, its most-used limit stands for it) and the worst of them, so one
 * provider near its limit still raises the tone while the arc reflects every active provider.
 */
export function quotaAggregate(
  activeProviders: readonly string[],
  reported: readonly AiProviderQuota[],
): QuotaAggregate {
  const providers = providerQuotaViews(activeProviders, reported);
  const fractions = providers.flatMap((view) => (view.peak ? [view.peak.fraction] : []));
  return {
    providers,
    fraction: fractions.length > 0 ? fractions.reduce((sum, fraction) => sum + fraction, 0) / fractions.length : null,
    worst: fractions.length > 0 ? Math.max(...fractions) : null,
    reporting: fractions.length,
    nearLimit: fractions.filter((fraction) => fraction >= NEAR_LIMIT).length,
  };
}
