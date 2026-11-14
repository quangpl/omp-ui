// The curated MCP catalog on the /mcp page: one entry per credential provider whose template has an
// `mcp` launch spec (Anthropic, OpenAI and the other model APIs have no MCP server, so they are not
// here). Each entry adds what the server's tools do, what the host needs to launch it, and a setup
// hint for the connect dialog. Shared by the client and the server: no Node imports here.

import { getCredentialProvider } from "@/lib/credential-providers";
import type { McpCatalogEntry } from "@/lib/mcp-types";

/** Host runtime each stdio launcher needs; hosted (HTTP) servers need nothing. */
const LAUNCHER_REQUIREMENTS: Record<string, string> = {
  npx: "Node.js (npx)",
  uvx: "Python uv (uvx)",
};

/** Popular first (in the order shown under "Popular"), then the rest. */
const ENTRIES: Omit<McpCatalogEntry, "requires">[] = [
  {
    providerId: "github",
    popular: true,
    capabilities: ["Repositories & files", "Issues", "Pull requests", "Actions", "Code search"],
    setupHint:
      "Fine-grained token with Contents, Issues and Pull requests read & write on the repositories agents work on (add Actions read for CI runs).",
  },
  {
    providerId: "slack",
    popular: true,
    capabilities: ["Search messages", "Channels & threads", "Post messages", "Users"],
    setupHint: "The Slack MCP server acts as you: use a user token (xoxp-) from a Slack app installed in the workspace.",
  },
  {
    providerId: "notion",
    popular: true,
    capabilities: ["Search", "Read pages", "Edit pages", "Databases", "Comments"],
    setupHint: "Internal integration secret (ntn_…); share each page or database agents may use with the integration.",
  },
  {
    providerId: "linear",
    popular: true,
    capabilities: ["Issues", "Projects", "Cycles", "Comments"],
    setupHint: "Personal API key (lin_api_…) from Settings → Security & access.",
  },
  {
    providerId: "gitlab",
    popular: true,
    capabilities: ["Projects & files", "Merge requests", "Issues", "Pipelines", "Wikis"],
    setupHint: "Personal access token with the api scope (read_api is enough for read-only use).",
  },
  {
    providerId: "aws",
    popular: true,
    capabilities: ["Any AWS API call", "S3", "EC2 & Lambda", "CloudWatch"],
    setupHint: "IAM access key for a user or role limited to the services agents should touch; set the default region.",
  },
  {
    providerId: "cloudflare",
    popular: true,
    capabilities: ["Workers", "DNS", "R2 & KV", "D1", "Whole Cloudflare API"],
    setupHint: "API token scoped to the accounts and zones agents manage; add the account ID for account-owned tokens.",
  },
  {
    providerId: "stripe",
    popular: true,
    capabilities: ["Customers", "Payments & refunds", "Invoices", "Subscriptions", "Stripe docs"],
    setupHint: "Restricted key (rk_…) with only the resources agents need; use a test-mode key to try it out.",
  },
  {
    providerId: "postgres",
    popular: true,
    capabilities: ["SQL queries", "Schema inspection", "Explain plans", "Index tuning"],
    setupHint: "Connection string for a read-only role; the server runs in restricted (read-only) mode.",
  },
  {
    providerId: "brave-search",
    popular: true,
    capabilities: ["Web search", "News", "Images", "Videos"],
    setupHint: "Search API key from the Brave Search API dashboard (the free plan works).",
  },
  {
    providerId: "mcp-http",
    popular: true,
    capabilities: ["Any Streamable HTTP server", "Bearer or custom header auth"],
    setupHint: "The server's MCP endpoint URL, plus a token when it requires one.",
  },
  {
    providerId: "huggingface",
    popular: false,
    capabilities: ["Model search", "Dataset search", "Papers", "Spaces", "Inference"],
    setupHint: "Read token (hf_…); a fine-grained token with Inference Providers access also lets agents run models.",
  },
  {
    providerId: "sentry",
    popular: false,
    capabilities: ["Errors & issues", "Traces", "Releases", "Projects"],
    setupHint: "User auth token (sntryu_…) with org, project and event read access; change the URL for self-hosted Sentry.",
  },
  {
    providerId: "atlassian",
    popular: false,
    capabilities: ["Jira issues", "JQL search", "Confluence pages", "Comments"],
    setupHint: "Atlassian Cloud site URL, your account email and an API token from id.atlassian.com.",
  },
  {
    providerId: "figma",
    popular: false,
    capabilities: ["Design files", "Frames & layers", "Components", "Styles", "Image export"],
    setupHint: "Personal access token (figd_…) with file content read access.",
  },
  {
    providerId: "supabase",
    popular: false,
    capabilities: ["SQL", "Migrations", "Edge functions", "Logs", "Branches"],
    setupHint: "Personal access token (sbp_…) from your Supabase account settings.",
  },
  {
    providerId: "tavily",
    popular: false,
    capabilities: ["Web search", "Extract", "Map", "Crawl"],
    setupHint: "API key (tvly-…) from the Tavily dashboard.",
  },
  {
    providerId: "firecrawl",
    popular: false,
    capabilities: ["Scrape pages", "Crawl sites", "Structured extract", "Web search"],
    setupHint: "API key (fc-…) from the Firecrawl dashboard.",
  },
];

/** Every MCP server the /mcp page offers, popular first; `requires` comes from the provider's launcher. */
export const MCP_CATALOG: readonly McpCatalogEntry[] = ENTRIES.map((entry) => {
  const mcp = getCredentialProvider(entry.providerId)?.mcp;
  const requires = mcp?.transport === "stdio" && mcp.command ? LAUNCHER_REQUIREMENTS[mcp.command] : undefined;
  return requires ? { ...entry, requires } : entry;
});

/** The catalog entry for a provider, or undefined when it has no MCP server. */
export function getMcpCatalogEntry(providerId: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.providerId === providerId);
}
