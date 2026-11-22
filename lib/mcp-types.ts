// MCP servers OMP-UI connects to every agent (the /mcp page). Each connected server is one entry
// in omp's user MCP config (`<omp agent dir>/mcp.json`) backed by a saved credential (the
// /credentials store). Shared by the client and the server: no Node imports here.

import type { CredentialProviderId, CredentialSummary } from "@/lib/credential-types";

/**
 * Secrets never reach mcp.json: an entry references them as `${OMPUI_MCP_<SERVER>_<FIELD>}`
 * placeholders (omp expands `${VAR}` when it loads the file), and OMP-UI puts the decrypted
 * values into the environment of every omp process it starts. Not `OMP_UI_`: `childEnv` strips that.
 */
export const MCP_ENV_PREFIX = "OMPUI_MCP_";

/** Server names: lowercase letters, digits, `-` and `_`, starting with a letter or digit. */
export const MCP_SERVER_NAME_PATTERN = "^[a-z0-9][a-z0-9_-]{0,47}$";

/** One curated catalog entry: a credential provider template whose `mcp` launch spec it uses. */
export interface McpCatalogEntry {
  providerId: CredentialProviderId;
  /** Listed under "Popular" first. */
  popular: boolean;
  /** Short capability tags, e.g. ["Issues", "Pull requests", "Code search"]. */
  capabilities: string[];
  /** What the OMP-UI host must have installed, e.g. "Node.js (npx)" or "Python (uvx)"; absent for hosted servers. */
  requires?: string;
  /** One line shown in the connect dialog, e.g. which scopes the token needs. */
  setupHint?: string;
}

/** One `mcpServers` entry exactly as OMP-UI writes it to omp's mcp.json. */
export type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      /** Secrets as `${OMPUI_MCP_…}` placeholders, other values inlined. */
      env?: Record<string, string>;
      /** Written only as `false` (disabled servers stay in the file, switched off). */
      enabled?: false;
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      enabled?: false;
    };

export interface McpTool {
  name: string;
  description?: string;
}

/** The name agents call a server's tool by: omp turns every character of the server name outside `[A-Za-z0-9_]` into `_`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}_${tool}`;
}

/** Outcome of an MCP-level check: `initialize` + `tools/list` against the running server. */
export interface McpProbeResult {
  ok: boolean;
  /** e.g. "Connected to github-mcp-server 0.9.1 · 51 tools", or the error. Never contains a secret. */
  message: string;
  serverName: string | null;
  serverVersion: string | null;
  /** Tools the server offers; agents call them by `mcpToolName(server, tool)`. Empty when it failed. */
  tools: McpTool[];
  latencyMs: number;
  checkedAt: string;
}

/**
 * connected: the latest check (credential health check or MCP probe, whichever ran last) passed;
 * failing: it failed; untested: never checked; disabled: switched off (kept in mcp.json with
 * `enabled: false`); error: cannot run because its credential was deleted or cannot be decrypted.
 */
export type McpServerStatus = "connected" | "failing" | "untested" | "disabled" | "error";

export interface McpServerSummary {
  /** Key under `mcpServers` in mcp.json. */
  name: string;
  providerId: CredentialProviderId;
  credentialId: string;
  /** The backing credential (secrets masked); null when it was deleted. */
  credential: CredentialSummary | null;
  enabled: boolean;
  status: McpServerStatus;
  /** Why it is failing / in error, else null. */
  statusMessage: string | null;
  transport: "stdio" | "http";
  /** The entry OMP-UI writes for it (secrets as placeholders, safe to show and copy). */
  config: McpServerConfig;
  /** mcp.json currently holds exactly `config` under `name`. */
  synced: boolean;
  /** Last MCP probe, null before the first one. */
  probe: McpProbeResult | null;
  createdAt: string;
  updatedAt: string;
}

/** An mcp.json entry OMP-UI does not manage (added by hand, `/mcp add`, …). Read-only. */
export interface McpExternalServer {
  name: string;
  /** "stdio" | "http" | "sse", or "unknown". */
  transport: string;
  enabled: boolean;
}

export interface McpServersResponse {
  /** Sorted by name. */
  servers: McpServerSummary[];
  /** omp's user MCP config file; null when omp's agent dir cannot be resolved. */
  configPath: string | null;
  /** Why mcp.json cannot be read or written (omp not found, unparsable JSON), else null. */
  configError: string | null;
  external: McpExternalServer[];
}

/** POST /mcp: connect a catalog server. Exactly one of `credentialId` / `credential`. */
export interface McpConnectInput {
  providerId: CredentialProviderId;
  /** Server name in mcp.json; defaults to the provider id, or `<id>-2`, `<id>-3`, … when taken. */
  name?: string;
  /** Reuse a saved credential of the same provider. */
  credentialId?: string;
  /** Or save a new credential (validated like POST /credentials; health-checked before saving). */
  credential?: { name: string; fields: Record<string, string>; expiresAt?: string | null };
  /** Probe the MCP server (initialize + tools/list) before answering. Default true. */
  test?: boolean;
}

export interface McpConnectResult {
  server: McpServerSummary;
}

/** PATCH /mcp/:name. */
export interface McpServerUpdate {
  enabled?: boolean;
  /** Switch to another saved credential of the same provider. */
  credentialId?: string;
}

/** The public MCP server directory the /mcp page browses (read from its sitemaps). */
export const MCP_DIRECTORY_ORIGIN = "https://mcpservers.org";

/** One server listed on mcpservers.org. */
export interface McpDirectoryEntry {
  /** Path of its page under the origin: `/servers/github-mcp-server`, `/servers/modelcontextprotocol/fetch`. */
  path: string;
  /** Readable name derived from the page slug ("GitHub MCP Server" from `github-mcp-server`). */
  name: string;
  /** Publisher for `/servers/<owner>/<repo>` pages, else null. */
  owner: string | null;
  /** Listed in the site's featured (priority) sitemap. */
  featured: boolean;
  /** The page on mcpservers.org (name, description, install steps). */
  url: string;
  /** Sitemap `lastmod`, else null. */
  updatedAt: string | null;
}

/** GET /mcp/directory: one page of the directory, filtered by `q` and `featured`. */
export interface McpDirectoryResponse {
  entries: McpDirectoryEntry[];
  /** Entries matching the filter (all pages). */
  total: number;
  /** Every server in the directory, and how many of them are featured. */
  size: number;
  featured: number;
  offset: number;
  limit: number;
  /** When the list was last read from mcpservers.org. */
  fetchedAt: string;
  /** Why the latest refresh failed; the list is then the previous one. Null when fresh. */
  refreshError: string | null;
}
