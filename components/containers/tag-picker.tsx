"use client";

import { useState } from "react";
import { ChevronDownIcon, Loader2Icon, TagIcon } from "lucide-react";
import { errorMessage } from "@/components/containers/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api-client";
import type { HubTag } from "@/lib/docker-types";

/** "postgres:17" → "postgres"; keeps registry ports ("localhost:5000/app:1" → "localhost:5000/app"). */
export function repositoryOf(image: string): string {
  const noDigest = image.split("@")[0];
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  return colon > slash ? noDigest.slice(0, colon) : noDigest;
}

/** "postgres:17" → "17"; null without an explicit tag. */
export function tagOf(image: string): string | null {
  const repo = repositoryOf(image);
  const rest = image.split("@")[0].slice(repo.length);
  return rest.startsWith(":") ? rest.slice(1) : null;
}

/** Only Docker Hub and Quay expose a public tag list. */
export function tagsSupported(repo: string): boolean {
  const first = repo.split("/")[0];
  const hasRegistry = repo.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  return !hasRegistry || first === "quay.io" || first === "docker.io";
}

/**
 * Tag dropdown for Docker Hub / Quay images; `onPick` gets the full "repo:tag". The "chip" variant
 * shows the current tag inline (launcher rows), "button" is the run dialog's "Tags" button.
 */
export function TagPicker({
  image,
  onPick,
  disabled,
  variant = "button",
}: {
  image: string;
  onPick: (image: string) => void;
  disabled?: boolean;
  variant?: "button" | "chip";
}) {
  const repo = repositoryOf(image.trim()).replace(/^docker\.io\//, "");
  const [tags, setTags] = useState<HubTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState("");

  const load = async () => {
    if (!repo || loadedFor === repo) return;
    setLoadedFor(repo);
    setTags(null);
    setError(null);
    try {
      setTags(await api.docker.tags(repo));
    } catch (err) {
      setError(errorMessage(err, "Could not load tags"));
    }
  };

  if (!repo || !tagsSupported(repo)) return null;
  const current = tagOf(image.trim()) ?? "latest";
  return (
    <DropdownMenu onOpenChange={(open) => open && void load()}>
      <DropdownMenuTrigger asChild>
        {variant === "chip" ? (
          <button
            type="button"
            disabled={disabled}
            className="inline-flex h-11 max-w-36 shrink-0 items-center gap-1 rounded-md px-2 font-mono text-xs text-muted-foreground ring-1 ring-foreground/10 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 md:h-7"
            aria-label={`Tag: ${current}. Pick another tag`}
            title="Pick a tag"
          >
            <TagIcon className="size-3 shrink-0" />
            <span className="truncate">{current}</span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          </button>
        ) : (
          <Button type="button" variant="outline" className="h-11 shrink-0 gap-1.5 md:h-9" disabled={disabled}>
            <TagIcon />
            Tags
            <ChevronDownIcon className="opacity-60" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{repo}</DropdownMenuLabel>
        {error ? (
          <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>
        ) : !tags ? (
          <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> Loading tags…
          </p>
        ) : tags.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No tags found</p>
        ) : (
          tags.map((tag) => (
            <DropdownMenuItem key={tag.name} onSelect={() => onPick(`${repo}:${tag.name}`)} className="gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{tag.name}</span>
              {tag.updatedAt && (
                <span className="shrink-0 text-[0.65rem] text-muted-foreground">
                  {new Date(tag.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              )}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
