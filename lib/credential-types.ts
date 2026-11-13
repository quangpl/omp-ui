// Credentials for MCP servers and connector services (the /credentials page). Shared by the
// client and the server: no Node imports here.

/** Every provider template, in catalog order. `lib/credential-providers.ts` defines each one. */
export const CREDENTIAL_PROVIDER_IDS = [
  // AI model providers
  "anthropic",
  "openai",
  "google-gemini",
  "openrouter",
  "huggingface",
  // Developer tools
  "github",
  "gitlab",
  "sentry",
  "linear",
  "atlassian",
  "figma",
  // Productivity
  "slack",
  "notion",
  // Cloud
  "aws",
  "cloudflare",
  "vercel",
  "supabase",
  // Data & payments
  "postgres",
  "stripe",
  // Search & web
  "brave-search",
  "tavily",
  "firecrawl",
  // Custom
  "mcp-http",
  "custom-api",
] as const;

export type CredentialProviderId = (typeof CREDENTIAL_PROVIDER_IDS)[number];

export type CredentialCategory = "ai" | "dev" | "productivity" | "cloud" | "data" | "search" | "custom";

export const CREDENTIAL_CATEGORY_LABELS: Record<CredentialCategory, string> = {
  ai: "AI models",
  dev: "Developer tools",
  productivity: "Productivity",
  cloud: "Cloud",
  data: "Data & payments",
  search: "Search & web",
  custom: "Custom",
};

/** `secret` values are encrypted at rest and only ever leave the server masked. */
export type CredentialFieldKind = "text" | "secret" | "url" | "select";

export interface CredentialField {
  /** Key in `CredentialInput.fields`. */
  key: string;
  label: string;
  kind: CredentialFieldKind;
  required: boolean;
  placeholder?: string;
  help?: string;
  /** Environment variable the provider's MCP server reads this value from. */
  envVar?: string;
  /** Format check (JavaScript RegExp source, matched against the trimmed value). */
  pattern?: string;
  /** Shown when `pattern` does not match, e.g. "Starts with sk-ant-". */
  patternHint?: string;
  /** `select` fields only. */
  options?: { value: string; label: string }[];
  /** Prefilled value for new credentials. */
  defaultValue?: string;
}

/** How the provider's MCP server is launched (for the copyable config snippet). */
export interface CredentialMcpServer {
  transport: "stdio" | "http";
  /** stdio: executable and arguments, e.g. `npx` + `["-y", "@modelcontextprotocol/server-github"]`. */
  command?: string;
  args?: string[];
  /** http: the remote MCP endpoint. */
  url?: string;
  /** Where the server comes from (repo or docs URL). */
  source: string;
}

export interface CredentialProvider {
  id: CredentialProviderId;
  name: string;
  category: CredentialCategory;
  /** One line: what agents get from it. */
  description: string;
  /** Two-letter monogram and brand color for the provider tile (lucide has no brand icons). */
  monogram: string;
  brandColor: string;
  docsUrl: string;
  /** Where to create a key/token. */
  keyUrl?: string;
  fields: CredentialField[];
  mcp?: CredentialMcpServer;
  /** What the health check calls, e.g. "GET https://api.github.com/user". */
  healthCheck: string;
}

/** Last health-check outcome. "untested": never checked since it was created or its secrets changed. */
export type CredentialHealth = "healthy" | "failing" | "untested";

/** A credential as the API returns it: secret values masked, everything else plain. */
export interface CredentialSummary {
  id: string;
  providerId: CredentialProviderId;
  name: string;
  /** Non-secret fields verbatim; secret fields masked (`maskSecret`). Missing optional fields are absent. */
  fields: Record<string, string>;
  /** Keys of the secret fields that hold a value. */
  secretsSet: string[];
  /** ISO date the key expires (user-entered), or null. */
  expiresAt: string | null;
  /** Include in the periodic background health check. */
  autoCheck: boolean;
  health: CredentialHealth;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  lastLatencyMs: number | null;
  /** Message of the last check (error text when failing, e.g. account name when healthy). */
  lastMessage: string | null;
  /** When the current failure streak began (ISO), null when not failing. */
  failingSince: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create body, and (partial) update body. On update, a secret field that is omitted or "" keeps
 * its stored value; send `clear: ["fieldKey"]` to remove an optional secret.
 */
export interface CredentialInput {
  providerId: CredentialProviderId;
  name: string;
  fields: Record<string, string>;
  expiresAt?: string | null;
  autoCheck?: boolean;
}

export interface CredentialUpdate {
  name?: string;
  fields?: Record<string, string>;
  clear?: string[];
  expiresAt?: string | null;
  autoCheck?: boolean;
}

/** Field errors keyed by field key, plus "name" and "expiresAt". Empty object = valid. */
export type CredentialValidationErrors = Record<string, string>;

export interface CredentialTestResult {
  ok: boolean;
  /** Human-readable outcome, e.g. "Authenticated as octocat" or "401 Bad credentials". */
  message: string;
  latencyMs: number;
  checkedAt: string;
}

export interface CredentialsResponse {
  credentials: CredentialSummary[];
  /** Background health-check period. */
  checkIntervalMs: number;
  /** Where the encryption key comes from: CREDENTIALS_KEY env var, or DATA_DIR/credentials.key. */
  keySource: "env" | "file";
}

export type CredentialNotificationKind = "failing" | "expired" | "expiring" | "untested";

export interface CredentialNotification {
  /**
   * Stable for one occurrence of a condition: `${credentialId}:${kind}:${since}` where `since` is
   * failingSince / expiresAt / createdAt. A new occurrence (fails again after recovering) gets a
   * new id, so dismissing an old one never hides a new problem.
   */
  id: string;
  credentialId: string;
  credentialName: string;
  providerId: CredentialProviderId;
  kind: CredentialNotificationKind;
  severity: "error" | "warning" | "info";
  title: string;
  message: string;
  /** When the condition began (ISO). */
  createdAt: string;
  read: boolean;
}

export interface CredentialNotificationsResponse {
  /** Not dismissed, newest first. */
  notifications: CredentialNotification[];
  /** Unread among `notifications` (the bell's badge). */
  unread: number;
}

export type CredentialNotificationAction = "read" | "dismiss" | "read-all" | "dismiss-all";

/** Credentials are checked in the background this often (autoCheck ones only). */
export const CREDENTIAL_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** An expiry within this window raises an "expiring" notification. */
export const CREDENTIAL_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
