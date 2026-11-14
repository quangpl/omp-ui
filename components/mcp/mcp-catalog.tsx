"use client";

import { useId, useMemo, useState } from "react";
import { ExternalLinkIcon, PlusIcon, SearchIcon, SearchXIcon } from "lucide-react";
import { ProviderTile } from "@/components/credentials/provider-tile";
import { type McpBadgeStatus, McpStatusBadge } from "@/components/mcp/mcp-status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCredentialProvider } from "@/lib/credential-providers";
import { CREDENTIAL_CATEGORY_LABELS, type CredentialCategory, type CredentialProvider } from "@/lib/credential-types";
import { MCP_CATALOG } from "@/lib/mcp-catalog";
import type { McpCatalogEntry, McpServerStatus, McpServerSummary } from "@/lib/mcp-types";
import { cn } from "@/lib/utils";

type CatalogFilter = "all" | "popular" | CredentialCategory;

interface CatalogItem {
  entry: McpCatalogEntry;
  provider: CredentialProvider;
  /** Lowercased text the search matches against. */
  haystack: string;
}

/** Catalog entries with their provider template (an entry without one would be a catalog bug: skipped). */
const ITEMS: CatalogItem[] = MCP_CATALOG.flatMap((entry) => {
  const provider = getCredentialProvider(entry.providerId);
  if (!provider) return [];
  const haystack = [
    provider.id,
    provider.name,
    provider.description,
    CREDENTIAL_CATEGORY_LABELS[provider.category],
    ...entry.capabilities,
  ]
    .join(" ")
    .toLowerCase();
  return [{ entry, provider, haystack }];
});

/** Worst first: a provider tile shows the most urgent status among its servers. */
const STATUS_PRIORITY: McpServerStatus[] = ["error", "failing", "untested", "connected", "disabled"];

function providerStatus(servers: McpServerSummary[]): { status: McpBadgeStatus; message: string | null } {
  if (servers.length === 0) return { status: "not-configured", message: null };
  const worst = [...servers].sort((a, b) => STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status))[0];
  return {
    status: worst.status,
    message: servers.length > 1 ? `${servers.length} servers: ${servers.map((s) => s.name).join(", ")}` : worst.statusMessage,
  };
}

function matches(item: CatalogItem, filter: CatalogFilter, terms: string[]): boolean {
  if (filter === "popular" && !item.entry.popular) return false;
  if (filter !== "all" && filter !== "popular" && item.provider.category !== filter) return false;
  return terms.every((term) => item.haystack.includes(term));
}

function filterLabel(filter: CatalogFilter): string {
  if (filter === "all") return "All";
  if (filter === "popular") return "Popular";
  return CREDENTIAL_CATEGORY_LABELS[filter];
}

/** Chips: All, Popular, then the categories the catalog has (in the label table's order), with counts. */
const FILTERS = (["all", "popular", ...Object.keys(CREDENTIAL_CATEGORY_LABELS)] as CatalogFilter[])
  .map((value) => ({ value, label: filterLabel(value), count: ITEMS.filter((item) => matches(item, value, [])).length }))
  .filter((chip) => chip.value === "all" || chip.count > 0);

function CatalogTile({
  item,
  index,
  servers,
  onConnect,
}: {
  item: CatalogItem;
  index: number;
  /** This provider's connected servers; null until the list has loaded. */
  servers: McpServerSummary[] | null;
  onConnect: () => void;
}) {
  const { entry, provider } = item;
  const connected = (servers?.length ?? 0) > 0;
  const badge = servers ? providerStatus(servers) : null;
  const runtime = entry.requires ? `Runs locally · ${entry.requires}` : "Remote · HTTP";
  const docsUrl = provider.mcp?.source ?? provider.docsUrl;

  return (
    <li
      style={{ "--stagger": index } as React.CSSProperties}
      className="animate-card-in flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4 ring-1 ring-foreground/10"
    >
      <div className="flex items-start gap-3">
        <ProviderTile provider={provider} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{provider.name}</h3>
          <p className="truncate text-xs text-muted-foreground">{runtime}</p>
        </div>
        {badge && <McpStatusBadge status={badge.status} message={badge.message} />}
      </div>

      <p className="line-clamp-2 text-sm text-pretty text-muted-foreground">{provider.description}</p>

      <ul className="flex flex-wrap gap-1.5" aria-label={`${provider.name} capabilities`}>
        {entry.capabilities.map((capability) => (
          <li key={capability} className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {capability}
          </li>
        ))}
      </ul>

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <a
          href={docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11"
        >
          Docs
          <ExternalLinkIcon className="size-3" aria-hidden="true" />
          <span className="sr-only">for the {provider.name} MCP server (opens in a new tab)</span>
        </a>
        <Button
          variant={connected ? "outline" : "default"}
          className="pressable h-11 gap-1.5 md:h-8"
          aria-label={connected ? `Add another ${provider.name} server` : `Connect ${provider.name}`}
          onClick={onConnect}
        >
          {connected && <PlusIcon />}
          {connected ? "Add another" : "Connect"}
        </Button>
      </div>
    </li>
  );
}

/**
 * The curated MCP servers: search, category chips and a grid of tiles. A tile shows the status of
 * the provider's servers ("Not configured" when none) and connects one through `onConnect`.
 */
export function McpCatalog({
  servers,
  onConnect,
}: {
  /** Connected servers; null while loading (tiles then show no status). */
  servers: McpServerSummary[] | null;
  onConnect: (entry: McpCatalogEntry) => void;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");

  const byProvider = useMemo(() => {
    if (!servers) return null;
    const map = new Map<string, McpServerSummary[]>();
    for (const server of servers) map.set(server.providerId, [...(map.get(server.providerId) ?? []), server]);
    return map;
  }, [servers]);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = ITEMS.filter((item) => matches(item, filter, terms));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative md:w-72 md:shrink-0">
          <label htmlFor={searchId} className="sr-only">
            Search MCP servers
          </label>
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search servers or capabilities"
            className="pl-8"
          />
        </div>
        <div
          role="group"
          aria-label="Category"
          className="scroll-row -mx-4 flex min-w-0 items-center gap-1.5 px-4 sm:-mx-6 sm:px-6 md:mx-0 md:px-0"
        >
          {FILTERS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              aria-pressed={filter === chip.value}
              onClick={() => setFilter(chip.value)}
              className={cn(
                "pressable inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap text-muted-foreground ring-1 ring-inset ring-foreground/10 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:h-8",
                "aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:ring-0",
              )}
            >
              {chip.label}
              <span className="tabular-nums opacity-60">{chip.count}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-card px-4 py-10 text-center ring-1 ring-foreground/10">
          <SearchXIcon className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No MCP servers match {query ? `“${query}”` : "this filter"}.</p>
          <Button
            variant="outline"
            className="pressable h-11 md:h-8"
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            Show all servers
          </Button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="MCP server catalog">
          {visible.map((item, i) => (
            <CatalogTile
              key={item.entry.providerId}
              item={item}
              index={i}
              servers={byProvider ? (byProvider.get(item.entry.providerId) ?? []) : null}
              onConnect={() => onConnect(item.entry)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
