"use client";

import { useRef, useState } from "react";
import {
  ArrowDownToLineIcon,
  BadgeCheckIcon,
  Loader2Icon,
  PlayIcon,
  SearchIcon,
  StarIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { errorMessage, TemplateLogo } from "@/components/containers/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { BUILTIN_TEMPLATES } from "@/lib/container-templates";
import type { ContainerTemplate, HubRepository } from "@/lib/docker-types";
import { cn } from "@/lib/utils";

type Registry = "dockerhub" | "quay";

/** One-click picks shown under the search box. */
const POPULAR_IDS = [
  "postgres",
  "redis",
  "mysql",
  "mongo",
  "nginx",
  "rabbitmq",
  "minio",
  "mailpit",
  "ollama",
  "postgres-pgadmin",
  "mongo-express",
  "ollama-open-webui",
];
const POPULAR = POPULAR_IDS.map((id) => BUILTIN_TEMPLATES.find((t) => t.id === id)).filter(
  (t): t is ContainerTemplate => Boolean(t),
);

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Looks like a full reference (tag, digest or registry host) rather than a search term. */
function isImageRef(text: string): boolean {
  if (/\s/.test(text)) return false;
  const first = text.split("/")[0];
  return text.includes(":") || text.includes("@") || (text.includes("/") && (first.includes(".") || first === "localhost"));
}

/**
 * The fastest way in: search Docker Hub / Quay or paste any image reference (ghcr.io, mcr, …),
 * plus one-click popular apps.
 */
export function QuickLaunch({
  onRunImage,
  onPullImage,
  onLaunch,
}: {
  onRunImage: (image: string) => void;
  onPullImage: (image: string) => void;
  onLaunch: (template: ContainerTemplate) => void;
}) {
  const [query, setQuery] = useState("");
  const [registry, setRegistry] = useState<Registry>("dockerhub");
  const [results, setResults] = useState<HubRepository[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  async function search(text: string, reg: Registry) {
    const q = text.trim();
    if (!q) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    setError(null);
    try {
      const found = await api.docker.search(q, reg);
      if (seq === searchSeq.current) setResults(found);
    } catch (err) {
      if (seq === searchSeq.current) setError(errorMessage(err, "Search failed"));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (isImageRef(q)) onRunImage(q);
    else void search(q, registry);
  }

  const looksLikeRef = isImageRef(query.trim());

  return (
    <section aria-labelledby="quick-launch" className="space-y-3 rounded-2xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ZapIcon className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id="quick-launch" className="text-sm font-semibold">
            Quick launch
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            Search a registry, paste any image (ghcr.io/…, quay.io/…, mcr.microsoft.com/…), or pick a popular app.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="postgres, grafana/grafana, ghcr.io/org/app:1.2…"
            className="h-11 pr-9 pl-9 font-mono text-sm md:h-10"
            aria-label="Search images or enter an image reference"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setResults(null);
                setError(null);
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label="Clear"
            >
              <XIcon className="size-4" />
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {(
              [
                ["dockerhub", "Docker Hub"],
                ["quay", "Quay"],
              ] as [Registry, string][]
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={registry === value ? "outline" : "ghost"}
                className={cn("h-9 md:h-8", registry !== value && "text-muted-foreground")}
                aria-pressed={registry === value}
                onClick={() => {
                  setRegistry(value);
                  if (query.trim() && !looksLikeRef) void search(query, value);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button type="submit" className="h-11 flex-1 gap-2 md:h-10" disabled={!query.trim() || searching}>
            {searching ? (
              <Loader2Icon className="animate-spin" />
            ) : looksLikeRef ? (
              <PlayIcon />
            ) : (
              <SearchIcon />
            )}
            {looksLikeRef ? "Run" : "Search"}
          </Button>
        </div>
      </form>

      {error && <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}

      {results && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {results.length === 0 ? "No images found." : `${results.length} results`}
            </p>
            <Button variant="ghost" size="xs" onClick={() => setResults(null)}>
              Hide
            </Button>
          </div>
          {results.length > 0 && (
            <ul className="max-h-80 divide-y overflow-y-auto rounded-lg ring-1 ring-foreground/10">
              {results.map((r) => (
                <li key={r.name} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-sm">{r.name}</span>
                      {r.official && (
                        <BadgeCheckIcon className="size-4 shrink-0 text-sky-500" aria-label="Official image" />
                      )}
                    </div>
                    {r.description && <p className="truncate text-xs text-muted-foreground">{r.description}</p>}
                    <p className="flex gap-3 text-[0.7rem] text-muted-foreground tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <StarIcon className="size-3" />
                        {compact.format(r.stars)}
                      </span>
                      {r.pulls > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <ArrowDownToLineIcon className="size-3" />
                          {compact.format(r.pulls)}
                        </span>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0 md:size-8"
                    onClick={() => onPullImage(r.name)}
                    title="Pull"
                    aria-label={`Pull ${r.name}`}
                  >
                    <ArrowDownToLineIcon />
                  </Button>
                  <Button size="sm" className="h-11 shrink-0 gap-1 md:h-8" onClick={() => onRunImage(r.name)}>
                    <PlayIcon />
                    Run
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {POPULAR.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onLaunch(t)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-muted/70 py-1 pr-3 pl-1 text-xs font-medium outline-none transition-colors hover:bg-primary/10 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 md:h-8"
            title={t.description}
          >
            <TemplateLogo src={t.logo} className="size-6 rounded-full p-0.5" />
            {t.title}
          </button>
        ))}
      </div>
    </section>
  );
}
