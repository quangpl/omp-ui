/**
 * Quota / usage-limit failures: the provider refused the request because the account ran out of
 * quota, hit a usage or rate limit, or has no credit left. Such runs are retried with a long
 * backoff (QUOTA_RETRY_STEPS_MS) and the UI shows them as "Waiting for quota".
 */
const QUOTA_PATTERN =
  /\bquota\b|usage[ _-]?limit|rate[ _-]?limit|\b429\b|too many requests|resource[ _-]?exhausted|insufficient[ _-]?quota|credit balance|out of credits/i;

/** Whether an agent error message (Task.agentError) reports a quota, usage or rate limit. */
export function isQuotaError(message: string | null | undefined): boolean {
  return !!message && QUOTA_PATTERN.test(message);
}

/** Backoff of quota retries: 5, 10, 15, 30 min, then hourly (the last step repeats). */
export const QUOTA_RETRY_STEPS_MS: readonly number[] = [5, 10, 15, 30, 60].map((m) => m * 60_000);
