// The public MCP server directory on the /mcp page, read from https://mcpservers.org. Its HTML pages
// sit behind a Cloudflare browser challenge that server-side clients cannot pass, and it has no
// public API; its sitemaps are served to anyone and list every server page. So the list is built
// from the sitemap index: the featured (priority) sitemap, the remote-servers sitemap and the
// numbered pages of all servers. Each page URL gives the entry's path, publisher and a name; the
// page itself (linked from the UI) has the description and install steps.
//
// The list is cached in memory for 12 h. A failed refresh keeps serving the previous list (and says
// why) and is retried after 5 min; without any list yet it answers 502.
import { MCP_DIRECTORY_ORIGIN, type McpDirectoryEntry, type McpDirectoryResponse } from "@/lib/mcp-types";
import { HttpError } from "@/lib/server/http";

const SITEMAP_INDEX_URL = `${MCP_DIRECTORY_ORIGIN}/sitemap.xml`;
/** Child sitemaps that list server pages; the others (static pages, skills) are skipped. */
const SERVER_SITEMAP_PATH = /^\/sitemaps\/(?:priority-servers|remote-mcp-servers|servers\/\d+)\.xml$/;
const FEATURED_SITEMAP_PATH = "/sitemaps/priority-servers.xml";
/** English server pages only: localized copies start with a locale segment (`/zh-CN/servers/…`). */
const SERVER_PAGE_PATH = /^\/(?:servers|remote-mcp-servers)\/[^/?#]+(?:\/[^/?#]+)?$/;
const TTL_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_QUERY_LENGTH = 200;
/** Words written in capitals in derived names. */
const ACRONYMS: Record<string, true> = {
  mcp: true,
  ai: true,
  api: true,
  aws: true,
  gcp: true,
  sql: true,
  db: true,
  llm: true,
  ui: true,
  cli: true,
  sdk: true,
  http: true,
  url: true,
  pdf: true,
  seo: true,
  crm: true,
};

interface Directory {
  /** Featured first (in the site's order), then newest first. */
  entries: McpDirectoryEntry[];
  /** Lowercased name and slug (`owner/repo` or `name`) of each entry, for search. */
  haystacks: string[];
  featured: number;
  fetchedAt: number;
}

interface CacheState {
  directory: Directory | null;
  /** Last refresh attempt, successful or not. */
  checkedAt: number;
  refreshError: string | null;
  /** The refresh in flight; concurrent requests share it. */
  loading: Promise<Directory> | null;
}

const cache: CacheState = { directory: null, checkedAt: 0, refreshError: null, loading: null };

/** Forget the cached list (tests). */
export function resetMcpDirectoryCache(): void {
  Object.assign(cache, { directory: null, checkedAt: 0, refreshError: null, loading: null });
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** URLs of the server sitemaps an index lists; anything off mcpservers.org is ignored. */
export function parseSitemapIndex(xml: string): string[] {
  const urls: string[] = [];
  for (const match of xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    let url: URL;
    try {
      url = new URL(decodeXml(match[1]));
    } catch {
      continue;
    }
    if (url.origin === MCP_DIRECTORY_ORIGIN && SERVER_SITEMAP_PATH.test(url.pathname)) urls.push(url.href);
  }
  return urls;
}

/** "github-mcp-server" → "Github MCP Server"; a `#fragment` (encoded in some slugs) is dropped. */
export function nameFromSlug(slug: string): string {
  const words = safeDecode(slug).split("#")[0].split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return slug;
  return words
    .map((word) => (Object.hasOwn(ACRONYMS, word.toLowerCase()) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

/** The English server pages of one sitemap, in its order. */
export function parseServerSitemap(xml: string, featured: boolean): McpDirectoryEntry[] {
  const entries: McpDirectoryEntry[] = [];
  for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/.exec(match[1])?.[1];
    if (!loc) continue;
    let url: URL;
    try {
      url = new URL(decodeXml(loc));
    } catch {
      continue;
    }
    if (url.origin !== MCP_DIRECTORY_ORIGIN || !SERVER_PAGE_PATH.test(url.pathname)) continue;
    const segments = url.pathname.split("/").slice(2);
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/.exec(match[1])?.[1];
    const updatedAt = lastmod && !Number.isNaN(Date.parse(lastmod)) ? new Date(lastmod).toISOString() : null;
    entries.push({
      path: url.pathname,
      name: nameFromSlug(segments[segments.length - 1]),
      owner: segments.length === 2 ? safeDecode(segments[0]) : null,
      featured,
      url: url.href,
      updatedAt,
    });
  }
  return entries;
}

/** Featured first in the site's order, then newest first, then by name. */
function compareEntries(a: McpDirectoryEntry, b: McpDirectoryEntry): number {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  if (a.featured) return 0;
  if (a.updatedAt !== b.updatedAt) {
    if (!a.updatedAt) return 1;
    if (!b.updatedAt) return -1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  }
  return a.name.localeCompare(b.name);
}

/** One entry per page path; a page in several sitemaps is featured if any says so. */
export function mergeEntries(lists: McpDirectoryEntry[][]): McpDirectoryEntry[] {
  const byPath = new Map<string, McpDirectoryEntry>();
  for (const list of lists) {
    for (const entry of list) {
      const seen = byPath.get(entry.path);
      if (!seen) byPath.set(entry.path, entry);
      else byPath.set(entry.path, { ...seen, featured: seen.featured || entry.featured, updatedAt: seen.updatedAt ?? entry.updatedAt });
    }
  }
  // Stable sort keeps the featured sitemap's order.
  return [...byPath.values()].sort(compareEntries);
}

async function fetchXml(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/xml, text/xml;q=0.9", "user-agent": "AgentMan (omp-ui)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
  return res.text();
}

/** Read the whole list from mcpservers.org now. */
export async function fetchMcpDirectory(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<Directory> {
  const sitemaps = parseSitemapIndex(await fetchXml(SITEMAP_INDEX_URL, fetchImpl));
  if (sitemaps.length === 0) throw new Error("its sitemap index lists no server sitemaps");
  const lists = await Promise.all(
    sitemaps.map(async (url) =>
      parseServerSitemap(await fetchXml(url, fetchImpl), new URL(url).pathname === FEATURED_SITEMAP_PATH),
    ),
  );
  const entries = mergeEntries(lists);
  if (entries.length === 0) throw new Error("its sitemaps list no server pages");
  return {
    entries,
    // The slug, not the path: every path contains "servers", which would match any search for it.
    haystacks: entries.map((e) => `${e.name} ${safeDecode(e.path.split("/").slice(2).join("/"))}`.toLowerCase()),
    featured: entries.filter((e) => e.featured).length,
    fetchedAt: now,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return `no answer within ${FETCH_TIMEOUT_MS / 1000} s`;
  return err instanceof Error && err.message ? err.message : String(err);
}

/** The cached list, refreshed when older than 12 h (5 min after a failure) or when `refresh` is set. */
async function loadDirectory(refresh: boolean, fetchImpl: typeof fetch, now: number): Promise<Directory> {
  const cached = cache.directory;
  const maxAge = cache.refreshError ? RETRY_MS : TTL_MS;
  if (cached && !refresh && now - cache.checkedAt < maxAge) return cached;
  cache.checkedAt = now;
  try {
    cache.loading ??= fetchMcpDirectory(fetchImpl, now).finally(() => {
      cache.loading = null;
    });
    const directory = await cache.loading;
    cache.directory = directory;
    cache.refreshError = null;
    return directory;
  } catch (err) {
    const message = errorMessage(err);
    cache.refreshError = message;
    if (!cached) throw new HttpError(502, `Could not read the MCP server list from mcpservers.org: ${message}`);
    return cached;
  }
}

export interface McpDirectoryQuery {
  q: string;
  featured: boolean;
  offset: number;
  limit: number;
  refresh: boolean;
}

function intParam(params: URLSearchParams, key: string, fallback: number, max: number): number {
  const raw = params.get(key);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${key} must be a non-negative integer`);
  return Math.min(Number(raw), max);
}

/** `?q=&featured=1&offset=&limit=&refresh=1`; 400 on a malformed number. */
export function parseMcpDirectoryQuery(params: URLSearchParams): McpDirectoryQuery {
  const limit = intParam(params, "limit", DEFAULT_LIMIT, MAX_LIMIT);
  if (limit === 0) throw new HttpError(400, "limit must be at least 1");
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    featured: params.get("featured") === "1",
    offset: intParam(params, "offset", 0, Number.MAX_SAFE_INTEGER),
    limit,
    refresh: params.get("refresh") === "1",
  };
}

/** One page of the directory: every whitespace-separated term of `q` must match the name or slug (publisher included). */
export async function queryMcpDirectory(
  query: McpDirectoryQuery,
  options: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<McpDirectoryResponse> {
  const directory = await loadDirectory(query.refresh, options.fetchImpl ?? fetch, options.now ?? Date.now());
  const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: McpDirectoryEntry[] = [];
  directory.entries.forEach((entry, i) => {
    if (query.featured && !entry.featured) return;
    if (terms.every((term) => directory.haystacks[i].includes(term))) matches.push(entry);
  });
  return {
    entries: matches.slice(query.offset, query.offset + query.limit),
    total: matches.length,
    size: directory.entries.length,
    featured: directory.featured,
    offset: query.offset,
    limit: query.limit,
    fetchedAt: new Date(directory.fetchedAt).toISOString(),
    refreshError: cache.refreshError,
  };
}
