"use client";

import { useMemo, useState } from "react";
import { LayersIcon, Loader2Icon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { EmptyState, Notice, TemplateLogo } from "@/components/containers/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { ContainerTemplate, TemplateCatalog } from "@/lib/docker-types";
import { cn } from "@/lib/utils";

type KindFilter = "all" | "container" | "compose";

export function AppsCatalog({
  catalog,
  loading,
  error,
  onRefresh,
  onLaunch,
}: {
  catalog: TemplateCatalog | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onLaunch: (template: ContainerTemplate) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");

  const templates = catalog?.templates ?? [];
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of templates) for (const c of t.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [templates]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter(
      (t) =>
        (kind === "all" || t.kind === kind) &&
        (!category || t.categories.includes(category)) &&
        (!q ||
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          (t.image ?? "").toLowerCase().includes(q)),
    );
  }, [templates, query, category, kind]);

  const clearFilters = () => {
    setQuery("");
    setCategory(null);
    setKind("all");
  };

  return (
    <div className="@container space-y-3">
      <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps: postgres, wordpress, grafana…"
            className="h-11 pl-9 text-base md:h-9 md:text-sm"
            aria-label="Search apps"
          />
        </div>
        <div className="flex min-w-0 gap-2">
          <div className="scroll-row flex min-w-0 flex-1 gap-1 rounded-lg bg-muted p-1">
            {(
              [
                ["all", "All"],
                ["container", "Containers"],
                ["compose", "Stacks"],
              ] as [KindFilter, string][]
            ).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={kind === value ? "outline" : "ghost"}
                className={cn("pressable h-9 flex-1 shrink-0 md:h-7", kind !== value && "text-muted-foreground")}
                onClick={() => setKind(value)}
                aria-pressed={kind === value}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            onClick={onRefresh}
            disabled={loading}
            className="pressable h-11 shrink-0 gap-2 md:h-9"
            title="Reload the remote app catalog"
          >
            {loading ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RefreshCwIcon />}
            Reload
          </Button>
        </div>
      </div>

      {categories.length > 0 && (
        <div className="scroll-row -mx-4 flex gap-1.5 px-4 py-1 sm:-mx-1 sm:px-1" role="group" aria-label="Categories">
          <Button
            size="sm"
            variant={category === null ? "secondary" : "ghost"}
            onClick={() => setCategory(null)}
            aria-pressed={category === null}
            className="pressable h-11 shrink-0 rounded-full px-3.5 md:h-7"
          >
            All categories
          </Button>
          {categories.map((c) => (
            <Button
              key={c}
              size="sm"
              variant={category === c ? "secondary" : "ghost"}
              onClick={() => setCategory(category === c ? null : c)}
              aria-pressed={category === c}
              className={cn(
                "pressable h-11 shrink-0 rounded-full px-3.5 capitalize md:h-7",
                category !== c && "text-muted-foreground",
              )}
            >
              {c.replace(/-/g, " ")}
            </Button>
          ))}
        </div>
      )}

      {error && <Notice tone="error" title="Could not load apps">{error}</Notice>}
      {catalog?.remoteError && (
        <Notice title="Showing built-in apps only">{catalog.remoteError}</Notice>
      )}

      {!catalog ? (
        loading && (
          <ul
            className="grid gap-2 @xl:grid-cols-2 @4xl:grid-cols-4"
            aria-busy="true"
            aria-label="Loading the app catalog"
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li
                key={i}
                className={cn(
                  "flex items-start gap-3 rounded-xl p-3 ring-1 ring-foreground/10",
                  i < 2 && "@4xl:col-span-2",
                )}
              >
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </li>
            ))}
          </ul>
        )
      ) : visible.length === 0 ? (
        <EmptyState
          title="No apps match"
          icon={<SearchIcon />}
          action={
            <Button variant="outline" className="pressable h-11 md:h-8" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        /* Phones: one column of rows. Wide: a 4-track grid where built-in apps take two tracks,
           so rows alternate between featured pairs and dense community tiles. */
        <ul className="grid grid-flow-row-dense gap-2 @xl:grid-cols-2 @4xl:grid-cols-4">
          {visible.map((t, index) => {
            const featured = t.source === "builtin";
            return (
              <li
                key={t.id}
                className={cn("animate-card-in", featured && "@4xl:col-span-2")}
                style={{ "--stagger": index } as React.CSSProperties}
              >
                <button
                  type="button"
                  onClick={() => onLaunch(t)}
                  className="pressable flex h-full w-full items-start gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-foreground/10 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted/60"
                >
                  <TemplateLogo src={t.logo} className={cn(featured && "@4xl:size-11")} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium tracking-tight">{t.title}</span>
                      {t.kind === "compose" && (
                        <Badge variant="secondary" className="gap-1 font-normal">
                          <LayersIcon />
                          Stack
                        </Badge>
                      )}
                    </div>
                    <p className="line-clamp-2 text-xs text-pretty text-muted-foreground">{t.description}</p>
                    <p className="truncate font-mono text-[0.65rem] text-muted-foreground/80">
                      {t.image ?? "docker compose"} · {t.source === "builtin" ? "built-in" : "Portainer catalog"}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
