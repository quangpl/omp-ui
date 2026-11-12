"use client";

import { useMemo, useState } from "react";
import { LayersIcon, Loader2Icon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { EmptyState, Notice, TemplateLogo } from "@/components/containers/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps: postgres, wordpress, grafana…"
            className="h-11 pl-9 md:h-9"
            aria-label="Search apps"
          />
        </div>
        <div className="flex gap-1 rounded-lg bg-muted p-1">
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
              className={cn("h-9 flex-1 md:h-7", kind !== value && "text-muted-foreground")}
              onClick={() => setKind(value)}
              aria-pressed={kind === value}
            >
              {label}
            </Button>
          ))}
        </div>
        <Button variant="outline" onClick={onRefresh} disabled={loading} className="h-11 gap-2 md:h-9" title="Reload the remote app catalog">
          {loading ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
          Reload
        </Button>
      </div>

      {categories.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <Button
            size="xs"
            variant={category === null ? "secondary" : "ghost"}
            onClick={() => setCategory(null)}
            className="shrink-0"
          >
            All categories
          </Button>
          {categories.map((c) => (
            <Button
              key={c}
              size="xs"
              variant={category === c ? "secondary" : "ghost"}
              onClick={() => setCategory(category === c ? null : c)}
              className="shrink-0 capitalize"
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
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Loading the app catalog…
          </p>
        )
      ) : visible.length === 0 ? (
        <EmptyState title="No apps match" />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onLaunch(t)}
                className="flex h-full w-full items-start gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-foreground/10 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <TemplateLogo src={t.logo} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{t.title}</span>
                    {t.kind === "compose" && (
                      <Badge variant="secondary" className="gap-1 font-normal">
                        <LayersIcon />
                        Stack
                      </Badge>
                    )}
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
                  <p className="truncate font-mono text-[0.65rem] text-muted-foreground/80">
                    {t.image ?? "docker compose"} · {t.source === "builtin" ? "built-in" : "Portainer catalog"}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
