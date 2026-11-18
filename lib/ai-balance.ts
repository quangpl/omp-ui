// Server-only: DeepSeek's prepaid balance via `GET /user/balance`. `omp usage` cannot read
// API-key provider balances (it lists them under `accountsWithoutUsage`), so the server reads
// DeepSeek's directly and lib/stats.ts merges the result into `AiStats.balances`.
import type { AiProviderBalance } from "@/lib/types";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEEPSEEK_BALANCE_TIMEOUT_MS = 10_000;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** A decimal amount from a JSON number or string (DeepSeek reports balances as strings). */
function decimal(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** DeepSeek's `GET /user/balance` body → a balance entry; null when the balance cannot be read. */
export function mapDeepSeekBalance(data: unknown): AiProviderBalance | null {
  const root = obj(data);
  const info = obj(arr(root.balance_infos)[0]);
  const total = decimal(info.total_balance);
  if (total === null) return null;
  return {
    provider: "deepseek",
    currency: str(info.currency),
    total,
    granted: decimal(info.granted_balance),
    toppedUp: decimal(info.topped_up_balance),
    available: typeof root.is_available === "boolean" ? root.is_available : null,
  };
}

/** DeepSeek's current balance via its API key; null when the key is missing or the request fails. Never rejects. */
export async function fetchDeepSeekBalance(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<AiProviderBalance | null> {
  const key = env.DEEPSEEK_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      headers: { authorization: `Bearer ${key}`, "user-agent": "agentman-stats" },
      signal: AbortSignal.timeout(DEEPSEEK_BALANCE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return mapDeepSeekBalance(await res.json());
  } catch {
    return null;
  }
}
