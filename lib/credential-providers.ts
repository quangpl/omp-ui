// Provider templates for the /credentials page: which fields each service needs, how to validate
// them, and how its MCP server is launched. Shared by the client and the server: no Node imports.

import {
  CREDENTIAL_PROVIDER_IDS,
  type CredentialField,
  type CredentialProvider,
  type CredentialProviderId,
  type CredentialValidationErrors,
} from "@/lib/credential-types";
import type { McpServerConfig } from "@/lib/mcp-types";

const MAX_NAME_LENGTH = 80;

/** Fields shared by the many providers that need nothing but one API key. */
function apiKeyField(field: Omit<CredentialField, "key" | "kind" | "required" | "label"> & { label?: string }): CredentialField {
  return { key: "apiKey", label: "API key", kind: "secret", required: true, ...field };
}

function tokenField(field: Omit<CredentialField, "key" | "kind" | "required" | "label"> & { label?: string }): CredentialField {
  return { key: "token", label: "Access token", kind: "secret", required: true, ...field };
}

export const CREDENTIAL_PROVIDERS: readonly CredentialProvider[] = [
  // AI model providers
  {
    id: "anthropic",
    name: "Anthropic",
    category: "ai",
    description: "Claude models through the Anthropic API.",
    monogram: "An",
    brandColor: "#D97757",
    docsUrl: "https://docs.claude.com/en/api/overview",
    keyUrl: "https://console.anthropic.com/settings/keys",
    fields: [
      apiKeyField({
        envVar: "ANTHROPIC_API_KEY",
        placeholder: "sk-ant-api03-…",
        pattern: "^sk-ant-",
        patternHint: "Starts with sk-ant-",
      }),
    ],
    healthCheck: "GET https://api.anthropic.com/v1/models (x-api-key header)",
  },
  {
    id: "openai",
    name: "OpenAI",
    category: "ai",
    description: "GPT, embedding and image models through the OpenAI API.",
    monogram: "OA",
    brandColor: "#10A37F",
    docsUrl: "https://platform.openai.com/docs/api-reference/authentication",
    keyUrl: "https://platform.openai.com/api-keys",
    fields: [
      apiKeyField({
        envVar: "OPENAI_API_KEY",
        placeholder: "sk-proj-…",
        pattern: "^sk-",
        patternHint: "Starts with sk-",
      }),
    ],
    healthCheck: "GET https://api.openai.com/v1/models (Bearer API key)",
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    category: "ai",
    description: "Gemini models through the Google AI Studio (Generative Language) API.",
    monogram: "Ge",
    brandColor: "#4285F4",
    docsUrl: "https://ai.google.dev/gemini-api/docs/api-key",
    keyUrl: "https://aistudio.google.com/apikey",
    fields: [
      apiKeyField({
        envVar: "GEMINI_API_KEY",
        placeholder: "AIza…",
        pattern: "^AIza",
        patternHint: "Starts with AIza",
      }),
    ],
    healthCheck: "GET https://generativelanguage.googleapis.com/v1beta/models (x-goog-api-key header)",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    category: "ai",
    description: "Hundreds of models from many vendors behind one OpenAI-compatible API.",
    monogram: "OR",
    brandColor: "#6467F2",
    docsUrl: "https://openrouter.ai/docs/api-reference/authentication",
    keyUrl: "https://openrouter.ai/settings/keys",
    fields: [
      apiKeyField({
        envVar: "OPENROUTER_API_KEY",
        placeholder: "sk-or-v1-…",
        pattern: "^sk-or-",
        patternHint: "Starts with sk-or-",
      }),
    ],
    healthCheck: "GET https://openrouter.ai/api/v1/key (Bearer API key)",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    category: "ai",
    description: "Search models, datasets, papers and Spaces; run Inference Providers.",
    monogram: "HF",
    brandColor: "#FFD21E",
    docsUrl: "https://huggingface.co/docs/hub/security-tokens",
    keyUrl: "https://huggingface.co/settings/tokens",
    fields: [
      tokenField({
        envVar: "HF_TOKEN",
        placeholder: "hf_…",
        pattern: "^hf_",
        patternHint: "Starts with hf_",
      }),
    ],
    mcp: { transport: "http", url: "https://huggingface.co/mcp", source: "https://huggingface.co/settings/mcp" },
    healthCheck: "GET https://huggingface.co/api/whoami-v2 (Bearer token)",
  },

  // Developer tools
  {
    id: "github",
    name: "GitHub",
    category: "dev",
    description: "Repositories, issues, pull requests, Actions and code search.",
    monogram: "GH",
    brandColor: "#24292F",
    docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    keyUrl: "https://github.com/settings/personal-access-tokens",
    fields: [
      tokenField({
        label: "Personal access token",
        envVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
        placeholder: "github_pat_…",
        pattern: "^(ghp_|github_pat_|gho_|ghu_|ghs_)",
        patternHint: "Starts with github_pat_, ghp_, gho_, ghu_ or ghs_",
      }),
      {
        key: "host",
        label: "API URL",
        kind: "url",
        required: false,
        placeholder: "https://api.github.com",
        defaultValue: "https://api.github.com",
        help: "Change only for GitHub Enterprise Server, e.g. https://github.example.com/api/v3.",
      },
    ],
    mcp: {
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      source: "https://github.com/github/github-mcp-server",
    },
    healthCheck: "GET {host}/user (Bearer token)",
  },
  {
    id: "gitlab",
    name: "GitLab",
    category: "dev",
    description: "Projects, merge requests, issues, pipelines and wikis.",
    monogram: "GL",
    brandColor: "#FC6D26",
    docsUrl: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
    keyUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    fields: [
      tokenField({
        label: "Personal access token",
        envVar: "GITLAB_PERSONAL_ACCESS_TOKEN",
        placeholder: "glpat-…",
        pattern: "^gl[a-z]+-",
        patternHint: "Starts with glpat- (or another gl…- token prefix)",
      }),
      {
        key: "host",
        label: "GitLab URL",
        kind: "url",
        required: false,
        placeholder: "https://gitlab.com",
        defaultValue: "https://gitlab.com",
        help: "Change only for a self-managed instance.",
      },
    ],
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@zereight/mcp-gitlab"],
      source: "https://github.com/zereight/gitlab-mcp",
    },
    healthCheck: "GET {host}/api/v4/user (PRIVATE-TOKEN header)",
  },
  {
    id: "sentry",
    name: "Sentry",
    category: "dev",
    description: "Errors, issues, traces and releases from Sentry.",
    monogram: "Se",
    brandColor: "#362D59",
    docsUrl: "https://docs.sentry.io/account/auth-tokens/",
    keyUrl: "https://sentry.io/settings/account/api/auth-tokens/",
    fields: [
      tokenField({
        label: "Auth token",
        envVar: "SENTRY_AUTH_TOKEN",
        placeholder: "sntryu_…",
        pattern: "^(sntry[su]_|[0-9a-f]{64}$)",
        patternHint: "Starts with sntryu_ or sntrys_",
      }),
      {
        key: "host",
        label: "Sentry URL",
        kind: "url",
        required: false,
        envVar: "SENTRY_URL",
        placeholder: "https://sentry.io",
        defaultValue: "https://sentry.io",
        help: "Change only for self-hosted Sentry.",
      },
    ],
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@sentry/mcp-server@latest"],
      source: "https://github.com/getsentry/sentry-mcp",
    },
    healthCheck: "GET {host}/api/0/organizations/ (Bearer token)",
  },
  {
    id: "linear",
    name: "Linear",
    category: "dev",
    description: "Issues, projects, cycles and comments in Linear.",
    monogram: "Li",
    brandColor: "#5E6AD2",
    docsUrl: "https://linear.app/developers/graphql",
    keyUrl: "https://linear.app/settings/account/security",
    fields: [
      apiKeyField({
        label: "Personal API key",
        envVar: "LINEAR_API_KEY",
        placeholder: "lin_api_…",
        pattern: "^lin_(api|oauth)_",
        patternHint: "Starts with lin_api_",
      }),
    ],
    mcp: { transport: "http", url: "https://mcp.linear.app/mcp", source: "https://linear.app/docs/mcp" },
    healthCheck: "POST https://api.linear.app/graphql { viewer { name } } (Authorization: API key)",
  },
  {
    id: "atlassian",
    name: "Atlassian (Jira & Confluence)",
    category: "dev",
    description: "Jira issues and Confluence pages on Atlassian Cloud.",
    monogram: "At",
    brandColor: "#0052CC",
    docsUrl: "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/",
    keyUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      {
        key: "siteUrl",
        label: "Site URL",
        kind: "url",
        required: true,
        envVar: "JIRA_URL",
        placeholder: "https://your-team.atlassian.net",
      },
      {
        key: "email",
        label: "Account email",
        kind: "text",
        required: true,
        envVar: "JIRA_USERNAME",
        placeholder: "you@example.com",
        pattern: "^[^@\\s]+@[^@\\s]+$",
        patternHint: "An email address",
      },
      {
        key: "apiToken",
        label: "API token",
        kind: "secret",
        required: true,
        envVar: "JIRA_API_TOKEN",
        placeholder: "ATATT…",
      },
    ],
    mcp: {
      transport: "stdio",
      command: "uvx",
      args: ["mcp-atlassian"],
      source: "https://github.com/sooperset/mcp-atlassian",
    },
    healthCheck: "GET {siteUrl}/rest/api/3/myself (Basic email:apiToken)",
  },
  {
    id: "figma",
    name: "Figma",
    category: "dev",
    description: "Design files, frames, components and styles for design-to-code work.",
    monogram: "Fi",
    brandColor: "#F24E1E",
    docsUrl: "https://developers.figma.com/docs/rest-api/authentication/",
    keyUrl: "https://www.figma.com/settings",
    fields: [
      tokenField({
        label: "Personal access token",
        envVar: "FIGMA_API_KEY",
        placeholder: "figd_…",
        pattern: "^figd_",
        patternHint: "Starts with figd_",
      }),
    ],
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "figma-developer-mcp", "--stdio"],
      source: "https://github.com/GLips/Figma-Context-MCP",
    },
    healthCheck: "GET https://api.figma.com/v1/me (X-Figma-Token header)",
  },

  // Productivity
  {
    id: "slack",
    name: "Slack",
    category: "productivity",
    description: "Search channels, read threads and post messages in a Slack workspace.",
    monogram: "Sl",
    brandColor: "#4A154B",
    docsUrl: "https://docs.slack.dev/authentication/tokens",
    keyUrl: "https://api.slack.com/apps",
    fields: [
      tokenField({
        label: "Bot or user token",
        envVar: "SLACK_TOKEN",
        placeholder: "xoxb-…",
        pattern: "^xox[bp]-",
        patternHint: "Starts with xoxb- (bot) or xoxp- (user)",
        help: "The Slack MCP server acts as a user, so it needs a user token (xoxp-).",
      }),
    ],
    mcp: { transport: "http", url: "https://mcp.slack.com/mcp", source: "https://docs.slack.dev/ai/slack-mcp-server" },
    healthCheck: "POST https://slack.com/api/auth.test (Bearer token)",
  },
  {
    id: "notion",
    name: "Notion",
    category: "productivity",
    description: "Search, read and edit Notion pages and databases shared with the integration.",
    monogram: "No",
    brandColor: "#000000",
    docsUrl: "https://developers.notion.com/docs/authorization",
    keyUrl: "https://www.notion.so/profile/integrations",
    fields: [
      tokenField({
        label: "Integration secret",
        envVar: "NOTION_TOKEN",
        placeholder: "ntn_…",
        pattern: "^(ntn_|secret_)",
        patternHint: "Starts with ntn_ (or secret_ for older integrations)",
      }),
    ],
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      source: "https://github.com/makenotion/notion-mcp-server",
    },
    healthCheck: "GET https://api.notion.com/v1/users/me (Bearer token, Notion-Version header)",
  },

  // Cloud
  {
    id: "aws",
    name: "AWS",
    category: "cloud",
    description: "Call AWS APIs (S3, EC2, Lambda, CloudWatch, …) with an IAM access key.",
    monogram: "AW",
    brandColor: "#FF9900",
    docsUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
    keyUrl: "https://console.aws.amazon.com/iam/home#/security_credentials",
    fields: [
      {
        key: "accessKeyId",
        label: "Access key ID",
        kind: "text",
        required: true,
        envVar: "AWS_ACCESS_KEY_ID",
        placeholder: "AKIA…",
        pattern: "^(AKIA|ASIA)[A-Z0-9]{16}$",
        patternHint: "20 characters starting with AKIA (or ASIA for temporary keys)",
      },
      {
        key: "secretAccessKey",
        label: "Secret access key",
        kind: "secret",
        required: true,
        envVar: "AWS_SECRET_ACCESS_KEY",
        pattern: "^[A-Za-z0-9/+=]{40}$",
        patternHint: "40 characters",
      },
      {
        key: "sessionToken",
        label: "Session token",
        kind: "secret",
        required: false,
        envVar: "AWS_SESSION_TOKEN",
        help: "Only for temporary (ASIA…) credentials.",
      },
      {
        key: "region",
        label: "Region",
        kind: "text",
        required: true,
        envVar: "AWS_REGION",
        placeholder: "us-east-1",
        defaultValue: "us-east-1",
        pattern: "^[a-z]{2}(-[a-z]+)+-\\d+$",
        patternHint: "An AWS region such as us-east-1",
      },
    ],
    mcp: {
      transport: "stdio",
      command: "uvx",
      args: ["awslabs.aws-api-mcp-server@latest"],
      source: "https://github.com/awslabs/mcp",
    },
    healthCheck: "POST https://sts.{region}.amazonaws.com/ Action=GetCallerIdentity (SigV4-signed)",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    category: "cloud",
    description: "The whole Cloudflare API: Workers, DNS, R2, KV, D1 and more.",
    monogram: "CF",
    brandColor: "#F38020",
    docsUrl: "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    fields: [
      {
        key: "apiToken",
        label: "API token",
        kind: "secret",
        required: true,
        envVar: "CLOUDFLARE_API_TOKEN",
      },
      {
        key: "accountId",
        label: "Account ID",
        kind: "text",
        required: false,
        envVar: "CLOUDFLARE_ACCOUNT_ID",
        pattern: "^[0-9a-f]{32}$",
        patternHint: "32 hexadecimal characters",
        help: "Required for account-owned API tokens.",
      },
    ],
    mcp: { transport: "http", url: "https://mcp.cloudflare.com/mcp", source: "https://github.com/cloudflare/mcp" },
    healthCheck:
      "GET https://api.cloudflare.com/client/v4/user/tokens/verify, or /accounts/{accountId}/tokens/verify when an account ID is set (Bearer token)",
  },
  {
    id: "vercel",
    name: "Vercel",
    category: "cloud",
    description: "Projects, deployments, domains and build logs on Vercel.",
    monogram: "Ve",
    brandColor: "#000000",
    docsUrl: "https://vercel.com/docs/rest-api",
    keyUrl: "https://vercel.com/account/settings/tokens",
    fields: [tokenField({ envVar: "VERCEL_TOKEN" })],
    healthCheck: "GET https://api.vercel.com/v2/user (Bearer token)",
  },
  {
    id: "supabase",
    name: "Supabase",
    category: "cloud",
    description: "Supabase projects: SQL, migrations, edge functions, logs and branches.",
    monogram: "Su",
    brandColor: "#3ECF8E",
    docsUrl: "https://supabase.com/docs/guides/getting-started/mcp",
    keyUrl: "https://supabase.com/dashboard/account/tokens",
    fields: [
      tokenField({
        label: "Personal access token",
        envVar: "SUPABASE_ACCESS_TOKEN",
        placeholder: "sbp_…",
        pattern: "^sbp_",
        patternHint: "Starts with sbp_",
      }),
    ],
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@supabase/mcp-server-supabase@latest"],
      source: "https://github.com/supabase-community/supabase-mcp",
    },
    healthCheck: "GET https://api.supabase.com/v1/projects (Bearer token)",
  },

  // Data & payments
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "data",
    description: "Query a Postgres database, inspect schemas and explain plans.",
    monogram: "PG",
    brandColor: "#336791",
    docsUrl: "https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING",
    fields: [
      {
        key: "connectionString",
        label: "Connection string",
        kind: "secret",
        required: true,
        envVar: "DATABASE_URI",
        placeholder: "postgresql://user:password@host:5432/dbname",
        pattern: "^postgres(ql)?://",
        patternHint: "Starts with postgres:// or postgresql://",
      },
    ],
    mcp: {
      transport: "stdio",
      command: "uvx",
      args: ["postgres-mcp", "--access-mode=restricted"],
      source: "https://github.com/crystaldba/postgres-mcp",
    },
    healthCheck: "Connects to the database and runs SELECT current_user, version()",
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "data",
    description: "Customers, payments, invoices, subscriptions and the Stripe docs.",
    monogram: "St",
    brandColor: "#635BFF",
    docsUrl: "https://docs.stripe.com/keys",
    keyUrl: "https://dashboard.stripe.com/apikeys",
    fields: [
      apiKeyField({
        label: "Secret or restricted key",
        envVar: "STRIPE_SECRET_KEY",
        placeholder: "rk_test_…",
        pattern: "^(sk|rk)_(test|live)_",
        patternHint: "Starts with sk_test_, sk_live_, rk_test_ or rk_live_",
        help: "Prefer a restricted key (rk_…) with only the permissions agents need.",
      }),
    ],
    mcp: { transport: "http", url: "https://mcp.stripe.com", source: "https://docs.stripe.com/mcp" },
    healthCheck: "GET https://api.stripe.com/v1/balance (Bearer API key)",
  },

  // Search & web
  {
    id: "brave-search",
    name: "Brave Search",
    category: "search",
    description: "Web, news, image and video search from Brave's independent index.",
    monogram: "Br",
    brandColor: "#FB542B",
    docsUrl: "https://api-dashboard.search.brave.com/app/documentation",
    keyUrl: "https://api-dashboard.search.brave.com/app/keys",
    fields: [apiKeyField({ envVar: "BRAVE_API_KEY" })],
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      source: "https://github.com/brave/brave-search-mcp-server",
    },
    healthCheck: "GET https://api.search.brave.com/res/v1/web/search?q=agentman&count=1 (X-Subscription-Token header)",
  },
  {
    id: "tavily",
    name: "Tavily",
    category: "search",
    description: "Search, extract, map and crawl the web with results tuned for LLMs.",
    monogram: "Ta",
    brandColor: "#2563EB",
    docsUrl: "https://docs.tavily.com",
    keyUrl: "https://app.tavily.com/home",
    fields: [
      apiKeyField({
        envVar: "TAVILY_API_KEY",
        placeholder: "tvly-…",
        pattern: "^tvly-",
        patternHint: "Starts with tvly-",
      }),
    ],
    mcp: { transport: "http", url: "https://mcp.tavily.com/mcp", source: "https://github.com/tavily-ai/tavily-mcp" },
    healthCheck: "GET https://api.tavily.com/usage (Bearer API key)",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    category: "search",
    description: "Scrape, crawl and extract web pages as clean markdown or JSON.",
    monogram: "Fc",
    brandColor: "#FA5D19",
    docsUrl: "https://docs.firecrawl.dev",
    keyUrl: "https://www.firecrawl.dev/app/api-keys",
    fields: [
      apiKeyField({
        envVar: "FIRECRAWL_API_KEY",
        placeholder: "fc-…",
        pattern: "^fc-",
        patternHint: "Starts with fc-",
      }),
    ],
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "firecrawl-mcp"],
      source: "https://github.com/firecrawl/firecrawl-mcp-server",
    },
    healthCheck: "GET https://api.firecrawl.dev/v1/team/credit-usage (Bearer API key)",
  },

  // Custom
  {
    id: "mcp-http",
    name: "Custom MCP server (HTTP)",
    category: "custom",
    description: "Any remote MCP server that speaks Streamable HTTP.",
    monogram: "MC",
    brandColor: "#6B7280",
    docsUrl: "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http",
    fields: [
      {
        key: "url",
        label: "Server URL",
        kind: "url",
        required: true,
        placeholder: "https://example.com/mcp",
      },
      {
        key: "token",
        label: "Token",
        kind: "secret",
        required: false,
        envVar: "MCP_SERVER_TOKEN",
        help: "Leave empty for servers that need no authentication.",
      },
      {
        key: "headerName",
        label: "Header name",
        kind: "text",
        required: false,
        placeholder: "Authorization",
        defaultValue: "Authorization",
        pattern: "^[A-Za-z0-9-]+$",
        patternHint: "Letters, digits and dashes",
        help: "With Authorization the token is sent as Bearer <token>; any other header gets the raw token.",
      },
    ],
    mcp: {
      transport: "http",
      source: "https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http",
    },
    healthCheck: "POST {url} JSON-RPC initialize (protocol 2025-06-18)",
  },
  {
    id: "custom-api",
    name: "Custom API",
    category: "custom",
    description: "Any HTTP API that takes a token in a request header.",
    monogram: "AP",
    brandColor: "#64748B",
    docsUrl: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization",
    fields: [
      {
        key: "url",
        label: "Health check URL",
        kind: "url",
        required: true,
        placeholder: "https://api.example.com/v1/me",
        help: "Requested with GET to check the credential; any 2xx answer counts as healthy.",
      },
      {
        key: "token",
        label: "Token",
        kind: "secret",
        required: false,
      },
      {
        key: "headerName",
        label: "Header name",
        kind: "text",
        required: false,
        placeholder: "Authorization",
        defaultValue: "Authorization",
        pattern: "^[A-Za-z0-9-]+$",
        patternHint: "Letters, digits and dashes",
        help: "With Authorization the token is sent as Bearer <token>; any other header gets the raw token.",
      },
    ],
    healthCheck: "GET {url} with the token in {headerName}",
  },
];

const PROVIDERS_BY_ID = new Map<string, CredentialProvider>(CREDENTIAL_PROVIDERS.map((provider) => [provider.id, provider]));

export function getCredentialProvider(id: string): CredentialProvider | undefined {
  return PROVIDERS_BY_ID.get(id);
}

export function isCredentialProviderId(value: unknown): value is CredentialProviderId {
  return typeof value === "string" && (CREDENTIAL_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Format error for a non-empty, trimmed value, or null when it is fine. */
function fieldValueError(field: CredentialField, value: string): string | null {
  if (field.kind === "url") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return "Enter a valid URL";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Enter an http:// or https:// URL";
  }
  if (field.kind === "select" && !field.options?.some((option) => option.value === value)) {
    return "Choose one of the options";
  }
  if (field.pattern && !new RegExp(field.pattern).test(value)) {
    return field.patternHint ?? "Invalid format";
  }
  return null;
}

/**
 * Field errors keyed by field key. A required secret may be left empty when it is in
 * `existingSecrets`: editing a credential keeps the stored value.
 */
export function validateCredentialFields(
  provider: CredentialProvider,
  fields: Record<string, string>,
  options: { existingSecrets?: Iterable<string> } = {},
): CredentialValidationErrors {
  const errors: CredentialValidationErrors = {};
  const existingSecrets = new Set(options.existingSecrets ?? []);
  const known = new Set(provider.fields.map((field) => field.key));
  for (const key of Object.keys(fields)) {
    if (!known.has(key)) errors[key] = "Unknown field";
  }
  for (const field of provider.fields) {
    const raw = fields[field.key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      const kept = field.kind === "secret" && existingSecrets.has(field.key);
      if (field.required && !kept) errors[field.key] = `${field.label} is required`;
      continue;
    }
    const error = fieldValueError(field, value);
    if (error) errors[field.key] = error;
  }
  return errors;
}

/** Field errors plus "name" and "expiresAt". */
export function validateCredentialInput(
  input: { name?: string; fields?: Record<string, string>; expiresAt?: string | null },
  provider: CredentialProvider,
  options: { existingSecrets?: Iterable<string> } = {},
): CredentialValidationErrors {
  const errors = validateCredentialFields(provider, input.fields ?? {}, options);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.name = "Name is required";
  else if (name.length > MAX_NAME_LENGTH) errors.name = `Name must be ${MAX_NAME_LENGTH} characters or fewer`;
  const { expiresAt } = input;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== "" && Number.isNaN(Date.parse(expiresAt))) {
    errors.expiresAt = "Enter a valid date";
  }
  return errors;
}

/** Short values are fully hidden; longer ones keep 4 characters at each end to tell keys apart. */
export function maskSecret(value: string): string {
  if (value.length < 12) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/**
 * The provider's `mcpServers` entry. Non-secret values from `fields` (or their defaults) are
 * inlined; a required one left empty becomes a `${ENV_VAR}` placeholder. Each secret field gets
 * `secretValue(field)` (a placeholder, or the real value for a live probe); null leaves it out.
 * Null when the provider has no MCP server.
 */
export function mcpServerConfig(
  provider: CredentialProvider,
  fields: Record<string, string>,
  secretValue: (field: CredentialField) => string | null,
): McpServerConfig | null {
  const { mcp } = provider;
  if (!mcp) return null;
  const valueOf = (field: CredentialField) => fields[field.key]?.trim() || field.defaultValue || "";

  if (mcp.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const field of provider.fields) {
      if (!field.envVar) continue;
      if (field.kind === "secret") {
        const secret = secretValue(field);
        if (secret !== null) env[field.envVar] = secret;
        continue;
      }
      const value = valueOf(field);
      if (value) env[field.envVar] = value;
      else if (field.required) env[field.envVar] = `\${${field.envVar}}`;
    }
    const server: McpServerConfig = { type: "stdio", command: mcp.command ?? "", args: [...(mcp.args ?? [])] };
    if (Object.keys(env).length > 0) server.env = env;
    return server;
  }
  const urlField = provider.fields.find((field) => field.key === "url" && field.kind === "url");
  const url = mcp.url ?? (urlField ? valueOf(urlField) || urlField.placeholder || "" : "");
  const server: McpServerConfig = { type: "http", url };
  const secretField = provider.fields.find((field) => field.kind === "secret" && field.envVar);
  const token = secretField ? secretValue(secretField) : null;
  if (token !== null) {
    const headerField = provider.fields.find((field) => field.key === "headerName");
    const headerName = (headerField && valueOf(headerField)) || "Authorization";
    server.headers = { [headerName]: headerName.toLowerCase() === "authorization" ? `Bearer ${token}` : token };
  }
  return server;
}

/**
 * `mcpServers` JSON for the provider's MCP server. Secrets are never inlined: they appear as
 * `${ENV_VAR}` placeholders, which MCP clients such as Claude Code expand from the environment.
 * Non-secret values from `fields` (or their defaults) are inlined.
 */
export function mcpConfigSnippet(provider: CredentialProvider, fields: Record<string, string> = {}): string | null {
  const config = mcpServerConfig(provider, fields, (field) =>
    field.envVar && (field.required || fields[field.key]?.trim() || field.defaultValue) ? `\${${field.envVar}}` : null,
  );
  if (!config) return null;
  // Other MCP clients default to stdio: the snippet names only the http transport.
  const server = config.type === "stdio" ? { command: config.command, args: config.args, env: config.env } : config;
  return JSON.stringify({ mcpServers: { [provider.id]: server } }, null, 2);
}
