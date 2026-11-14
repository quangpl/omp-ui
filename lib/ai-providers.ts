// AI model providers for Settings → AI Providers: which environment variables omp reads for each
// provider, how they combine into auth methods, the OAuth sign-ins omp offers for it
// (`omp login <id>`), and the API shapes of `/api/v1/settings/ai-providers`. Shared by the client
// and the server: no Node imports.
//
// Values saved in Settings are sealed with the credentials key (lib/server/credentials.ts
// `sealSecret`) and applied over the server's own environment for every omp child process
// (lib/child-env.ts), so a saved key works for the next agent without a restart. OAuth sign-ins
// (lib/server/ai-oauth.ts) run `omp login` on the server: omp stores and refreshes those tokens in
// its own credential store, never in Settings.

/** omp provider ids (`omp models --json` / `omp usage --json`), in display order. */
export const AI_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "azure",
  "amazon-bedrock",
  "openrouter",
  "groq",
  "xai",
  "mistral",
  "deepseek",
  "cerebras",
] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** How an auth method signs in: an API key, an OAuth token, or AWS credentials. */
export type AiAuthMethodKind = "api-key" | "oauth" | "aws";

/** One environment variable omp reads; also the key of every value map in this API. */
export interface AiProviderField {
  envVar: string;
  label: string;
  /** Secret values only ever leave the server masked (`maskSecret`); others are returned verbatim. */
  secret: boolean;
  placeholder?: string;
  help?: string;
  /** Format check (JavaScript RegExp source, matched against the trimmed value). */
  pattern?: string;
  /** Shown when `pattern` does not match, e.g. "Starts with sk-ant-". */
  patternHint?: string;
}

/** A way to authenticate: complete when every `required` field has a value. */
export interface AiAuthMethod {
  id: string;
  kind: AiAuthMethodKind;
  label: string;
  description: string;
  /** Env vars that must all be set (at least one of `anyOf`, when present, too). */
  required: string[];
  /** Exactly one group member is enough, e.g. Azure's resource name or base URL. */
  anyOf?: string[];
  optional?: string[];
}

/** An OAuth sign-in omp offers (`omp login <id>`): the browser authorizes, omp keeps the tokens. */
export interface AiOAuthLogin {
  /** `omp login` provider id. */
  id: string;
  label: string;
  description: string;
}

export interface AiProviderDefinition {
  id: AiProviderId;
  name: string;
  description: string;
  /** Two-letter monogram and brand color for the provider tile (lucide has no brand icons). */
  monogram: string;
  brandColor: string;
  docsUrl: string;
  /** Where to create a key. */
  keyUrl?: string;
  /** Every env var of every method, each once. */
  fields: AiProviderField[];
  /** In order of preference: the Test button probes the first complete one. */
  methods: AiAuthMethod[];
  /** OAuth sign-ins through omp that give access to this provider's models. */
  oauthLogins?: AiOAuthLogin[];
  /** omp provider ids whose models belong to this provider (defaults to `[id]`). */
  modelProviders?: string[];
  /** What the Test button calls, e.g. "GET https://api.openai.com/v1/models". */
  healthCheck: string;
}

function apiKeyMethod(envVar: string, description: string): AiAuthMethod {
  return { id: "api-key", kind: "api-key", label: "API key", description, required: [envVar] };
}

function bearerKeyProvider(
  provider: Omit<AiProviderDefinition, "fields" | "methods" | "healthCheck"> & {
    envVar: string;
    placeholder: string;
    pattern?: string;
    patternHint?: string;
    modelsUrl: string;
  },
): AiProviderDefinition {
  const { envVar, placeholder, pattern, patternHint, modelsUrl, ...rest } = provider;
  return {
    ...rest,
    fields: [{ envVar, label: "API key", secret: true, placeholder, pattern, patternHint }],
    methods: [apiKeyMethod(envVar, `omp reads ${envVar}.`)],
    healthCheck: `GET ${modelsUrl} (Bearer API key)`,
  };
}

export const AI_PROVIDERS: readonly AiProviderDefinition[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models through the Anthropic API or a Claude subscription.",
    monogram: "An",
    brandColor: "#D97757",
    docsUrl: "https://docs.claude.com/en/api/overview",
    keyUrl: "https://console.anthropic.com/settings/keys",
    fields: [
      {
        envVar: "ANTHROPIC_API_KEY",
        label: "API key",
        secret: true,
        placeholder: "sk-ant-api03-…",
        pattern: "^sk-ant-",
        patternHint: "Starts with sk-ant-",
      },
      {
        envVar: "ANTHROPIC_OAUTH_TOKEN",
        label: "OAuth token",
        secret: true,
        placeholder: "sk-ant-oat01-…",
        help: "A long-lived Claude Pro/Max token from `claude setup-token`. Takes precedence over the API key.",
        pattern: "^sk-ant-",
        patternHint: "Starts with sk-ant-",
      },
    ],
    methods: [
      {
        id: "oauth",
        kind: "oauth",
        label: "OAuth token",
        description: "Long-lived Claude Pro/Max token from `claude setup-token`.",
        required: ["ANTHROPIC_OAUTH_TOKEN"],
      },
      apiKeyMethod("ANTHROPIC_API_KEY", "Pay-as-you-go key from the Anthropic Console."),
    ],
    oauthLogins: [
      { id: "anthropic", label: "Claude Pro/Max", description: "Use your Claude subscription instead of an API key." },
    ],
    healthCheck: "GET https://api.anthropic.com/v1/models",
  },
  bearerKeyProvider({
    id: "openai",
    name: "OpenAI",
    description: "GPT and o-series models through the OpenAI API.",
    monogram: "OA",
    brandColor: "#10A37F",
    docsUrl: "https://platform.openai.com/docs/api-reference/authentication",
    keyUrl: "https://platform.openai.com/api-keys",
    envVar: "OPENAI_API_KEY",
    placeholder: "sk-proj-…",
    pattern: "^sk-",
    patternHint: "Starts with sk-",
    modelsUrl: "https://api.openai.com/v1/models",
    oauthLogins: [
      {
        id: "openai-codex",
        label: "ChatGPT Plus/Pro",
        description: "Codex models with your ChatGPT subscription.",
      },
      {
        id: "openai-codex-device",
        label: "ChatGPT Plus/Pro (device code)",
        description: "The same subscription, confirmed with a one-time code on any device.",
      },
    ],
    modelProviders: ["openai", "openai-codex"],
  }),
  {
    id: "google",
    name: "Google Gemini",
    description: "Gemini models through the Gemini API (Google AI Studio).",
    monogram: "Ge",
    brandColor: "#4285F4",
    docsUrl: "https://ai.google.dev/gemini-api/docs/api-key",
    keyUrl: "https://aistudio.google.com/apikey",
    fields: [{ envVar: "GEMINI_API_KEY", label: "API key", secret: true, placeholder: "AIza…", pattern: "^AIza", patternHint: "Starts with AIza" }],
    methods: [apiKeyMethod("GEMINI_API_KEY", "Key from Google AI Studio.")],
    oauthLogins: [
      {
        id: "google-gemini-cli",
        label: "Google account (Gemini CLI)",
        description: "Gemini through Google Cloud Code Assist, like the Gemini CLI.",
      },
      {
        id: "google-antigravity",
        label: "Google Antigravity",
        description:
          "Gemini, Claude and GPT-OSS through Antigravity. At your own risk: Google may suspend accounts that sign in from third-party tools.",
      },
    ],
    modelProviders: ["google", "google-gemini-cli", "google-antigravity"],
    healthCheck: "GET https://generativelanguage.googleapis.com/v1beta/models (x-goog-api-key header)",
  },
  {
    id: "azure",
    name: "Azure OpenAI",
    description: "OpenAI models deployed in your Azure OpenAI resource.",
    monogram: "Az",
    brandColor: "#0078D4",
    docsUrl: "https://learn.microsoft.com/azure/ai-services/openai/reference",
    keyUrl: "https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI",
    fields: [
      { envVar: "AZURE_OPENAI_API_KEY", label: "API key", secret: true, placeholder: "Key 1 or Key 2 of the resource" },
      {
        envVar: "AZURE_OPENAI_RESOURCE_NAME",
        label: "Resource name",
        secret: false,
        placeholder: "my-resource",
        help: "The <name> in https://<name>.openai.azure.com.",
        pattern: "^[A-Za-z0-9][A-Za-z0-9-]*$",
        patternHint: "Letters, digits and dashes",
      },
      {
        envVar: "AZURE_OPENAI_BASE_URL",
        label: "Base URL",
        secret: false,
        placeholder: "https://my-resource.openai.azure.com/openai/v1",
        help: "Instead of the resource name, e.g. for a custom domain.",
        pattern: "^https?://",
        patternHint: "Starts with https://",
      },
      {
        envVar: "AZURE_OPENAI_API_VERSION",
        label: "API version",
        secret: false,
        placeholder: "2024-10-21",
        help: "Optional; omp's default when empty.",
      },
    ],
    methods: [
      {
        id: "api-key",
        kind: "api-key",
        label: "API key",
        description: "Resource key plus the resource name or base URL.",
        required: ["AZURE_OPENAI_API_KEY"],
        anyOf: ["AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_BASE_URL"],
        optional: ["AZURE_OPENAI_API_VERSION"],
      },
    ],
    healthCheck: "GET https://<resource>.openai.azure.com/openai/models (api-key header)",
  },
  {
    id: "amazon-bedrock",
    name: "AWS Bedrock",
    description: "Claude, Llama, Nova and other models through Amazon Bedrock.",
    monogram: "Bd",
    brandColor: "#FF9900",
    docsUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html",
    keyUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
    fields: [
      {
        envVar: "AWS_ACCESS_KEY_ID",
        label: "Access key ID",
        secret: false,
        placeholder: "AKIA…",
        pattern: "^(AKIA|ASIA)[A-Z0-9]{12,}$",
        patternHint: "Starts with AKIA or ASIA",
      },
      { envVar: "AWS_SECRET_ACCESS_KEY", label: "Secret access key", secret: true },
      { envVar: "AWS_SESSION_TOKEN", label: "Session token", secret: true, help: "Only for temporary (ASIA…) credentials." },
      {
        envVar: "AWS_BEARER_TOKEN_BEDROCK",
        label: "Bedrock API key",
        secret: true,
        help: "A Bedrock API key instead of access keys.",
      },
      {
        envVar: "AWS_PROFILE",
        label: "Profile",
        secret: false,
        placeholder: "default",
        help: "A profile from ~/.aws/config on the server instead of keys.",
      },
      {
        envVar: "AWS_REGION",
        label: "Region",
        secret: false,
        placeholder: "us-east-1",
        pattern: "^[a-z]{2}(-[a-z]+)+-\\d+$",
        patternHint: "An AWS region such as us-east-1",
      },
    ],
    methods: [
      {
        id: "access-keys",
        kind: "aws",
        label: "AWS access keys",
        description: "IAM access key pair with Bedrock access.",
        required: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        optional: ["AWS_SESSION_TOKEN", "AWS_REGION"],
      },
      {
        id: "bedrock-api-key",
        kind: "api-key",
        label: "Bedrock API key",
        description: "Long- or short-term Bedrock API key.",
        required: ["AWS_BEARER_TOKEN_BEDROCK"],
        optional: ["AWS_REGION"],
      },
      {
        id: "profile",
        kind: "aws",
        label: "AWS profile",
        description: "Named profile from the server's AWS config (SSO, roles, …).",
        required: ["AWS_PROFILE"],
        optional: ["AWS_REGION"],
      },
    ],
    modelProviders: ["amazon-bedrock", "bedrock-mantle"],
    healthCheck: "GET https://bedrock.<region>.amazonaws.com/foundation-models (SigV4 or Bedrock API key)",
  },
  bearerKeyProvider({
    id: "openrouter",
    name: "OpenRouter",
    description: "Hundreds of models from many labs behind one key.",
    monogram: "OR",
    brandColor: "#6467F2",
    docsUrl: "https://openrouter.ai/docs/api-reference/authentication",
    keyUrl: "https://openrouter.ai/settings/keys",
    envVar: "OPENROUTER_API_KEY",
    placeholder: "sk-or-v1-…",
    pattern: "^sk-or-",
    patternHint: "Starts with sk-or-",
    modelsUrl: "https://openrouter.ai/api/v1/key",
    oauthLogins: [
      { id: "openrouter", label: "OpenRouter account", description: "Sign in instead of pasting a key; omp stores the key it issues." },
    ],
  }),
  bearerKeyProvider({
    id: "groq",
    name: "Groq",
    description: "Fast open-weight models on Groq LPUs.",
    monogram: "Gq",
    brandColor: "#F55036",
    docsUrl: "https://console.groq.com/docs/api-reference",
    keyUrl: "https://console.groq.com/keys",
    envVar: "GROQ_API_KEY",
    placeholder: "gsk_…",
    pattern: "^gsk_",
    patternHint: "Starts with gsk_",
    modelsUrl: "https://api.groq.com/openai/v1/models",
  }),
  bearerKeyProvider({
    id: "xai",
    name: "xAI",
    description: "Grok models through the xAI API.",
    monogram: "xA",
    brandColor: "#111111",
    docsUrl: "https://docs.x.ai/docs/api-reference",
    keyUrl: "https://console.x.ai",
    envVar: "XAI_API_KEY",
    placeholder: "xai-…",
    pattern: "^xai-",
    patternHint: "Starts with xai-",
    modelsUrl: "https://api.x.ai/v1/models",
  }),
  bearerKeyProvider({
    id: "mistral",
    name: "Mistral",
    description: "Mistral and Codestral models through La Plateforme.",
    monogram: "Mi",
    brandColor: "#FA520F",
    docsUrl: "https://docs.mistral.ai/api/",
    keyUrl: "https://console.mistral.ai/api-keys",
    envVar: "MISTRAL_API_KEY",
    placeholder: "API key",
    modelsUrl: "https://api.mistral.ai/v1/models",
  }),
  bearerKeyProvider({
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek chat and reasoning models.",
    monogram: "DS",
    brandColor: "#4D6BFE",
    docsUrl: "https://api-docs.deepseek.com/",
    keyUrl: "https://platform.deepseek.com/api_keys",
    envVar: "DEEPSEEK_API_KEY",
    placeholder: "sk-…",
    pattern: "^sk-",
    patternHint: "Starts with sk-",
    modelsUrl: "https://api.deepseek.com/models",
  }),
  bearerKeyProvider({
    id: "cerebras",
    name: "Cerebras",
    description: "Open-weight models on Cerebras wafer-scale inference.",
    monogram: "Ce",
    brandColor: "#F15A29",
    docsUrl: "https://inference-docs.cerebras.ai/api-reference",
    keyUrl: "https://cloud.cerebras.ai/platform",
    envVar: "CEREBRAS_API_KEY",
    placeholder: "csk-…",
    pattern: "^csk-",
    patternHint: "Starts with csk-",
    modelsUrl: "https://api.cerebras.ai/v1/models",
  }),
];

/** omp OAuth sign-ins for providers outside the catalog (Settings → "Also available through omp"). */
export const AI_OTHER_OAUTH_LOGINS: readonly AiOAuthLogin[] = [
  { id: "github-copilot", label: "GitHub Copilot", description: "Models from your Copilot plan, on github.com or GitHub Enterprise." },
  { id: "cursor", label: "Cursor", description: "Claude, GPT and other models from your Cursor subscription." },
  { id: "kimi-code", label: "Kimi Code", description: "Kimi models from your Kimi coding plan." },
  { id: "gitlab-duo", label: "GitLab Duo", description: "Models from your GitLab Duo seat." },
  { id: "devin", label: "Devin", description: "Models from your Devin account." },
];

const PROVIDERS_BY_ID = new Map<string, AiProviderDefinition>(AI_PROVIDERS.map((provider) => [provider.id, provider]));

const OAUTH_LOGINS_BY_ID = new Map<string, AiOAuthLogin>(
  [...AI_PROVIDERS.flatMap((provider) => provider.oauthLogins ?? []), ...AI_OTHER_OAUTH_LOGINS].map((login) => [
    login.id,
    login,
  ]),
);

export function getAiProvider(id: string): AiProviderDefinition | undefined {
  return PROVIDERS_BY_ID.get(id);
}

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === "string" && PROVIDERS_BY_ID.has(value);
}

/** A sign-in the UI offers; the only ids the server passes to `omp login`. */
export function getAiOAuthLogin(id: string): AiOAuthLogin | undefined {
  return OAUTH_LOGINS_BY_ID.get(id);
}

/** omp provider ids whose models count for `provider`. */
export function aiModelProviders(provider: AiProviderDefinition): string[] {
  return provider.modelProviders ?? [provider.id];
}

/** Every env var any provider uses: the only keys Settings may store or inject. */
export const AI_PROVIDER_ENV_VARS: readonly string[] = AI_PROVIDERS.flatMap((p) => p.fields.map((f) => f.envVar));

/** Whether `values` (env var → non-empty value) complete `method`. */
export function isMethodComplete(method: AiAuthMethod, values: Record<string, string | undefined>): boolean {
  const has = (envVar: string) => !!values[envVar]?.trim();
  return method.required.every(has) && (!method.anyOf || method.anyOf.some(has));
}

/** The first complete method (catalog order = preference), or undefined. */
export function completeMethod(
  provider: AiProviderDefinition,
  values: Record<string, string | undefined>,
): AiAuthMethod | undefined {
  return provider.methods.find((method) => isMethodComplete(method, values));
}

/** Format error for a non-empty value, or null when it is fine (or the env var is unknown). */
export function aiFieldError(provider: AiProviderDefinition, envVar: string, value: string): string | null {
  const field = provider.fields.find((f) => f.envVar === envVar);
  if (!field) return `${provider.name} has no ${envVar} setting`;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) return `${field.label} must not contain spaces`;
  if (field.pattern && !new RegExp(field.pattern).test(trimmed)) return field.patternHint ?? `${field.label} looks invalid`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// API shapes (`/api/v1/settings/ai-providers`)

/**
 * authenticated: omp lists models for it (and the last test of the current values did not fail).
 * unverified: credentials are set but omp could not list models and they were never tested.
 * error: credentials are set but omp lists no models for them, the last test failed, or a saved
 *   value cannot be decrypted.
 * not-configured: no credentials from any source.
 */
export type AiProviderStatus = "authenticated" | "unverified" | "error" | "not-configured";

/** Where a value comes from: saved in Settings, or the server process's own environment. */
export type AiValueSource = "settings" | "environment";

export interface AiProviderFieldState {
  envVar: string;
  /** Source of the value omp uses; null when unset. */
  source: AiValueSource | null;
  /** Secret fields masked (`maskSecret`), others verbatim; null when unset. */
  value: string | null;
  /** Saved in Settings and also set in the server environment (the saved value wins). */
  overridesEnvironment: boolean;
  /** Saved in Settings but cannot be decrypted (the encryption key changed): re-enter it. */
  broken: boolean;
}

export interface AiProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  checkedAt: string;
}

/** A model omp can use, as listed by `omp models --json`. */
export interface AiProviderModel {
  selector: string;
  name: string;
}

export interface AiProviderState {
  id: AiProviderId;
  status: AiProviderStatus;
  /** One line explaining the status, e.g. "omp lists 61 models" or "Last test failed: 401 …". */
  statusMessage: string;
  /** Ids of the complete auth methods (any source). */
  activeMethods: string[];
  /** One entry per catalog field, keyed by env var. */
  fields: Record<string, AiProviderFieldState>;
  /** omp's own sign-in for this provider (`omp usage --json` reports it, e.g. after `omp login`). */
  ompSignIn: { account: string | null } | null;
  /** Models omp lists for this provider's `modelProviders`. */
  models: AiProviderModel[];
  /** Last test of the current saved values; cleared when they change. */
  lastTest: AiProviderTestResult | null;
}

/** A provider outside the catalog that omp is signed in to or lists models for (e.g. github-copilot). */
export interface AiOtherProvider {
  id: string;
  models: AiProviderModel[];
  ompSignIn: { account: string | null } | null;
}

export interface AiProvidersResponse {
  providers: AiProviderState[];
  other: AiOtherProvider[];
  /** Why the model list is unavailable (omp missing, `omp models` failed), or null. */
  modelsError: string | null;
  /** Where the encryption key comes from: CREDENTIALS_KEY env var, or DATA_DIR/credentials.key. */
  keySource: "env" | "file";
  generatedAt: string;
}

/** PATCH body. Values that are omitted or "" keep the saved value; `clear` removes saved ones. */
export interface AiProviderUpdate {
  providerId: AiProviderId;
  values?: Record<string, string>;
  /** Env vars whose saved value to remove (a server environment value, if any, applies again). */
  clear?: string[];
  /** Test the new effective values right after saving (stored as `lastTest`). */
  test?: boolean;
}

/** POST /test body. Without `values` (or for env vars left empty) the effective values are tested. */
export interface AiProviderTestInput {
  providerId: AiProviderId;
  values?: Record<string, string>;
}

export interface AiProviderTestResponse {
  result: AiProviderTestResult;
  /** The provider after the test (its `lastTest` updates when the effective values were tested). */
  provider: AiProviderState;
}

// ---------------------------------------------------------------------------------------------
// OAuth sign-in (`/api/v1/settings/ai-providers/oauth`)

/** running: `omp login` waits for the browser or for `prompt`; the rest are final. */
export type AiOAuthStatus = "running" | "succeeded" | "failed" | "cancelled";

/** One `omp login <loginId>` run on the server, as the UI polls it. */
export interface AiOAuthSession {
  id: string;
  loginId: string;
  label: string;
  status: AiOAuthStatus;
  /** The https page to authorize at (or to enter `userCode` on); null until omp prints it. */
  url: string | null;
  /** Device-code flows: the code to enter at `url`. */
  userCode: string | null;
  /** The question omp waits on (a pasted redirect URL or code, a domain, a confirmation), or null. */
  prompt: string | null;
  /** omp's other messages (instructions, progress), in order; URLs and answers are not repeated. */
  output: string[];
  /** The account omp signed in as, once succeeded (when omp reports one). */
  account: string | null;
  /** Why it failed. */
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** POST /oauth body. */
export interface AiOAuthStartInput {
  loginId: string;
}

/** POST /oauth/{id} body: one answer to `prompt`. */
export interface AiOAuthInput {
  input: string;
}
