import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchMcpDirectory,
  nameFromSlug,
  parseMcpDirectoryQuery,
  parseSitemapIndex,
  parseServerSitemap,
  queryMcpDirectory,
  resetMcpDirectoryCache,
} from "@/lib/server/mcp-directory";
import { HttpError } from "@/lib/server/http";

const ORIGIN = "https://mcpservers.org";

function sitemapIndex(paths: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <sitemap>\n    <loc>${p.startsWith("http") ? p : ORIGIN + p}</loc>\n  </sitemap>`).join("\n")}
</sitemapindex>`;
}

function urlset(urls: { path: string; lastmod?: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls
  .map(
    (u) => `  <url>
    <loc>${ORIGIN}${u.path}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}
    <xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}${u.path}" />
  </url>`,
  )
  .join("\n")}
</urlset>`;
}

const SITES: Record<string, string> = {
  "/sitemap.xml": sitemapIndex([
    "/sitemaps/static.xml",
    "/sitemaps/priority-servers.xml",
    "/sitemaps/servers/1.xml",
    "/sitemaps/servers/2.xml",
    "/sitemaps/skills.xml",
    "/sitemaps/remote-mcp-servers.xml",
  ]),
  "/sitemaps/priority-servers.xml": urlset([
    { path: "/servers/github-mcp-server" },
    { path: "/zh-CN/servers/github-mcp-server" },
    { path: "/servers/ahrefs-mcp-server" },
  ]),
  "/sitemaps/servers/1.xml": urlset([
    { path: "/servers/modelcontextprotocol/fetch", lastmod: "2026-11-01T00:00:00.000Z" },
    { path: "/es/servers/modelcontextprotocol/fetch", lastmod: "2026-11-01T00:00:00.000Z" },
    { path: "/servers/github-mcp-server", lastmod: "2026-10-01T00:00:00.000Z" },
  ]),
  "/sitemaps/servers/2.xml": urlset([
    { path: "/servers/podop29/shotpipe-mcp%23shotpipe-mcp", lastmod: "2026-11-10T00:00:00.000Z" },
    { path: "/servers/0xarchive-io" },
  ]),
  "/sitemaps/remote-mcp-servers.xml": urlset([{ path: "/remote-mcp-servers/clockwise" }]),
};

/** A fake mcpservers.org serving `sites`; records every path asked for. */
function fakeSite(sites: Record<string, string> = SITES) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const body = url.origin === ORIGIN ? sites[url.pathname] : undefined;
    return body === undefined ? new Response("Not found", { status: 404 }) : new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function query(overrides: Partial<Parameters<typeof queryMcpDirectory>[0]> = {}) {
  return { q: "", featured: false, offset: 0, limit: 50, refresh: false, ...overrides };
}

beforeEach(() => resetMcpDirectoryCache());

describe("mcpservers.org sitemaps", () => {
  it("follows only server sitemaps on mcpservers.org", () => {
    const urls = parseSitemapIndex(
      sitemapIndex([
        "/sitemaps/static.xml",
        "/sitemaps/priority-servers.xml",
        "/sitemaps/servers/12.xml",
        "/sitemaps/remote-mcp-servers.xml",
        "https://evil.example.com/sitemaps/servers/1.xml",
      ]),
    );
    expect(urls).toEqual([
      `${ORIGIN}/sitemaps/priority-servers.xml`,
      `${ORIGIN}/sitemaps/servers/12.xml`,
      `${ORIGIN}/sitemaps/remote-mcp-servers.xml`,
    ]);
  });

  it("reads English server pages with publisher, name and date", () => {
    const entries = parseServerSitemap(SITES["/sitemaps/servers/1.xml"], false);
    expect(entries).toEqual([
      {
        path: "/servers/modelcontextprotocol/fetch",
        name: "Fetch",
        owner: "modelcontextprotocol",
        featured: false,
        url: `${ORIGIN}/servers/modelcontextprotocol/fetch`,
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
      expect.objectContaining({ path: "/servers/github-mcp-server", owner: null, name: "Github MCP Server" }),
    ]);
  });

  it("derives readable names from slugs", () => {
    expect(nameFromSlug("postgresql-mcp-server")).toBe("Postgresql MCP Server");
    expect(nameFromSlug("shotpipe-mcp%23shotpipe-mcp")).toBe("Shotpipe MCP");
    expect(nameFromSlug("constructor_api")).toBe("Constructor API");
  });

  it("merges every sitemap: featured first in site order, then newest first, no duplicates", async () => {
    const { fetchImpl } = fakeSite();
    const directory = await fetchMcpDirectory(fetchImpl);
    expect(directory.entries.map((e) => [e.path, e.featured])).toEqual([
      ["/servers/github-mcp-server", true],
      ["/servers/ahrefs-mcp-server", true],
      ["/servers/podop29/shotpipe-mcp%23shotpipe-mcp", false],
      ["/servers/modelcontextprotocol/fetch", false],
      ["/servers/0xarchive-io", false],
      ["/remote-mcp-servers/clockwise", false],
    ]);
    // A featured page keeps the date its servers sitemap gives it.
    expect(directory.entries[0].updatedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(directory.featured).toBe(2);
  });

  it("fails when the index lists no server sitemaps", async () => {
    const { fetchImpl } = fakeSite({ "/sitemap.xml": sitemapIndex(["/sitemaps/static.xml"]) });
    await expect(fetchMcpDirectory(fetchImpl)).rejects.toThrow("lists no server sitemaps");
  });
});

describe("queryMcpDirectory", () => {
  it("searches name, path and publisher and pages the matches", async () => {
    const { fetchImpl } = fakeSite();
    const byOwner = await queryMcpDirectory(query({ q: "modelcontext" }), { fetchImpl });
    expect(byOwner.entries.map((e) => e.path)).toEqual(["/servers/modelcontextprotocol/fetch"]);
    expect(byOwner).toMatchObject({ total: 1, size: 6, featured: 2, refreshError: null });

    const allTerms = await queryMcpDirectory(query({ q: "MCP server" }), { fetchImpl });
    expect(allTerms.entries.map((e) => e.path)).toEqual(["/servers/github-mcp-server", "/servers/ahrefs-mcp-server"]);

    const featured = await queryMcpDirectory(query({ featured: true, offset: 1, limit: 1 }), { fetchImpl });
    expect(featured).toMatchObject({ total: 2, offset: 1, limit: 1 });
    expect(featured.entries.map((e) => e.path)).toEqual(["/servers/ahrefs-mcp-server"]);
  });

  it("serves the cached list for 12 h and re-reads it on refresh", async () => {
    const { fetchImpl, calls } = fakeSite();
    const t0 = Date.parse("2026-11-14T00:00:00Z");
    await queryMcpDirectory(query(), { fetchImpl, now: t0 });
    const perLoad = calls.length;
    expect(perLoad).toBe(5); // index + 4 server sitemaps

    await queryMcpDirectory(query(), { fetchImpl, now: t0 + 11 * 3600_000 });
    expect(calls.length).toBe(perLoad);

    await queryMcpDirectory(query({ refresh: true }), { fetchImpl, now: t0 + 11 * 3600_000 });
    expect(calls.length).toBe(2 * perLoad);

    await queryMcpDirectory(query(), { fetchImpl, now: t0 + 24 * 3600_000 });
    expect(calls.length).toBe(3 * perLoad);
  });

  it("shares one load between concurrent requests", async () => {
    const { fetchImpl, calls } = fakeSite();
    await Promise.all([queryMcpDirectory(query(), { fetchImpl }), queryMcpDirectory(query({ q: "fetch" }), { fetchImpl })]);
    expect(calls.filter((p) => p === "/sitemap.xml")).toHaveLength(1);
  });

  it("keeps the previous list when a refresh fails, and retries after 5 min", async () => {
    const t0 = Date.parse("2026-11-14T00:00:00Z");
    const first = await queryMcpDirectory(query(), { fetchImpl: fakeSite().fetchImpl, now: t0 });

    const down = fakeSite({});
    const stale = await queryMcpDirectory(query(), { fetchImpl: down.fetchImpl, now: t0 + 13 * 3600_000 });
    expect(stale.size).toBe(first.size);
    expect(stale.fetchedAt).toBe(first.fetchedAt);
    expect(stale.refreshError).toBe("/sitemap.xml answered 404");

    await queryMcpDirectory(query(), { fetchImpl: down.fetchImpl, now: t0 + 13 * 3600_000 + 60_000 });
    expect(down.calls).toHaveLength(1);

    const back = await queryMcpDirectory(query(), { fetchImpl: fakeSite().fetchImpl, now: t0 + 13 * 3600_000 + 6 * 60_000 });
    expect(back.refreshError).toBeNull();
    expect(back.fetchedAt).not.toBe(first.fetchedAt);
  });

  it("answers 502 when mcpservers.org cannot be read and nothing is cached", async () => {
    const challenge = vi.fn(async () => new Response("Just a moment...", { status: 403 })) as unknown as typeof fetch;
    const err = await queryMcpDirectory(query(), { fetchImpl: challenge }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 502, message: expect.stringContaining("/sitemap.xml answered 403") });
  });
});

describe("parseMcpDirectoryQuery", () => {
  it("applies defaults and caps the page size", () => {
    expect(parseMcpDirectoryQuery(new URLSearchParams(""))).toEqual(query());
    expect(parseMcpDirectoryQuery(new URLSearchParams("q=%20git%20&featured=1&offset=30&limit=9999&refresh=1"))).toEqual({
      q: "git",
      featured: true,
      offset: 30,
      limit: 200,
      refresh: true,
    });
  });

  it("rejects malformed numbers with 400", () => {
    for (const search of ["offset=-1", "limit=abc", "limit=0"]) {
      expect(() => parseMcpDirectoryQuery(new URLSearchParams(search))).toThrow(HttpError);
    }
  });
});
