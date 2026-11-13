"use client";

import { useState } from "react";
import {
  ArrowDownToLineIcon,
  BrushCleaningIcon,
  ChevronDownIcon,
  HardDriveIcon,
  ImageIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { EmptyState, formatBytes, SectionHeader } from "@/components/containers/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { DockerContainer, DockerImage, DockerNetwork, DockerVolume, PruneKind } from "@/lib/docker-types";
import { cn } from "@/lib/utils";

/** Rows shown before "Show all": the resources column stays compact next to the running list. */
const PREVIEW_ROWS = 6;
const ICON_BUTTON = "size-11 pressable-icon md:size-8";
const LIST = "divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10";
const ROW = "flex items-center gap-3 py-2 pr-2 pl-4 transition-colors hover:bg-muted/40 md:px-4";

/** `docker images` sizes are SI strings ("1.23GB", "85.2MB", "0B"); unknown formats count as 0. */
function parseDockerSize(size: string): number {
  const match = /^([\d.]+)\s*([kKMGT]?)B$/.exec(size.trim());
  if (!match) return 0;
  const power = { "": 0, k: 1, K: 1, M: 2, G: 3, T: 4 }[match[2]] ?? 0;
  return Number(match[1]) * 1000 ** power;
}

/** First rows plus a "Show all" toggle, so long lists don't stretch the column. */
function usePreview<T>(items: T[]) {
  const [expanded, setExpanded] = useState(false);
  const hidden = items.length - PREVIEW_ROWS;
  const toggle =
    hidden > 0 ? (
      <Button
        variant="ghost"
        className="h-11 w-full gap-1.5 rounded-none text-xs text-muted-foreground md:h-8"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        {expanded ? "Show fewer" : `Show all ${items.length}`}
        <ChevronDownIcon
          className={cn(
            "size-3.5 transition-transform duration-300 ease-(--ease-fluid) motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </Button>
    ) : null;
  return { shown: expanded ? items : items.slice(0, PREVIEW_ROWS), toggle };
}

/** Approximate disk use from image sizes, and every prune action in one place. */
export function DiskUsage({
  containers,
  images,
  volumes,
  networks,
  onPrune,
}: {
  containers: DockerContainer[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  onPrune: (kind: PruneKind) => void;
}) {
  let used = 0;
  let unused = 0;
  for (const image of images) {
    if (image.containers > 0) used += parseDockerSize(image.size);
    else unused += parseDockerSize(image.size);
  }
  const total = used + unused;
  const stopped = containers.filter((c) => c.state !== "running" && c.state !== "paused").length;
  const dangling = images.filter((i) => i.repository === "<none>").length;
  const unusedVolumes = volumes.filter((v) => v.usedBy.length === 0).length;
  const customNetworks = networks.filter((n) => !n.builtin).length;

  const cleanups: [PruneKind, string, string, string][] = [
    ["containers", "Stopped containers", String(stopped), "Remove"],
    ["images", "Dangling images", String(dangling), "Remove"],
    ["volumes", "Unused volumes", String(unusedVolumes), "Remove"],
    ["networks", "Unused networks", `${customNetworks} custom`, "Remove"],
    ["builder", "Build cache", "", "Clear"],
  ];

  return (
    <section aria-labelledby="disk-heading" className="space-y-3">
      <SectionHeader id="disk-heading" title="Disk & cleanup" />
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="space-y-3 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p
              className="font-mono text-2xl font-semibold tracking-tight tabular-nums"
              title="Sum of image sizes; layers shared between images count once per image"
            >
              {formatBytes(total)}
            </p>
            <p className="font-mono text-xs text-muted-foreground tabular-nums">
              {images.length} {images.length === 1 ? "image" : "images"}
            </p>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div
              className="h-full w-full origin-left bg-foreground/70 transition-transform duration-500 ease-(--ease-fluid) motion-reduce:transition-none"
              style={{ transform: `scaleX(${total ? used / total : 0})` }}
            />
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <div className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-foreground/70" />
              <dt>In use</dt>
              <dd className="font-mono text-foreground">{formatBytes(used)}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-muted-foreground/30" />
              <dt>Unused</dt>
              <dd className="font-mono text-foreground">{formatBytes(unused)}</dd>
            </div>
          </dl>
        </div>
        <ul className="divide-y border-t">
          {cleanups.map(([kind, label, count, verb]) => (
            <li key={kind} className="flex items-center gap-3 py-1 pr-1.5 pl-4">
              <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
              {count && <span className="font-mono text-xs text-muted-foreground tabular-nums">{count}</span>}
              <Button
                variant="ghost"
                size="sm"
                className="pressable h-11 gap-1.5 text-muted-foreground hover:text-destructive md:h-8"
                onClick={() => onPrune(kind)}
                aria-label={`${verb} ${label.toLowerCase()}`}
              >
                <BrushCleaningIcon />
                {verb}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function ImagesList({
  images,
  onRun,
  onPull,
  onRemove,
}: {
  images: DockerImage[];
  onRun: (image: string) => void;
  onPull: (image: string) => void;
  onRemove: (image: DockerImage) => void;
}) {
  const [pull, setPull] = useState("");
  const { shown, toggle } = usePreview(images);
  const refOf = (image: DockerImage) =>
    image.repository === "<none>" ? image.id : `${image.repository}:${image.tag}`;
  return (
    <section aria-labelledby="images-heading" className="space-y-3">
      <SectionHeader id="images-heading" title="Images" count={images.length} />
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pull.trim()) onPull(pull.trim());
          setPull("");
        }}
      >
        <Input
          value={pull}
          onChange={(e) => setPull(e.target.value)}
          placeholder="Pull: redis:7, ghcr.io/org/app:tag"
          className="h-11 min-w-0 font-mono text-base md:h-9 md:text-sm"
          aria-label="Image to pull"
          spellCheck={false}
        />
        <Button type="submit" className="pressable h-11 shrink-0 gap-2 md:h-9" disabled={!pull.trim()}>
          <ArrowDownToLineIcon />
          Pull
        </Button>
      </form>
      {images.length === 0 ? (
        <EmptyState compact icon={<ImageIcon />} title="No images">
          Pulled and built images show here.
        </EmptyState>
      ) : (
        <div className={LIST}>
          <ul className="divide-y">
            {shown.map((image) => {
              const ref = refOf(image);
              return (
                <li key={`${image.id}-${image.repository}-${image.tag}`} className={ROW}>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-sm" title={ref}>
                        {image.repository}
                        <span className="text-muted-foreground">:{image.tag}</span>
                      </span>
                      {image.containers > 0 && (
                        <Badge variant="secondary" className="shrink-0 font-normal">
                          in use
                        </Badge>
                      )}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">
                      {image.size} · {image.createdSince} · {image.id}
                    </p>
                  </div>
                  {/* Phones: Run + overflow; desktop: every action inline. */}
                  <div className="flex shrink-0 items-center">
                    {image.repository !== "<none>" && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(ICON_BUTTON, "max-md:hidden")}
                          title="Pull latest"
                          aria-label={`Pull ${ref}`}
                          onClick={() => onPull(ref)}
                        >
                          <ArrowDownToLineIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={ICON_BUTTON}
                          title="Run"
                          aria-label={`Run ${ref}`}
                          onClick={() => onRun(ref)}
                        >
                          <PlayIcon />
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        ICON_BUTTON,
                        "text-muted-foreground hover:text-destructive",
                        image.repository !== "<none>" && "max-md:hidden",
                      )}
                      title="Remove"
                      aria-label={`Remove ${ref}`}
                      onClick={() => onRemove(image)}
                    >
                      <Trash2Icon />
                    </Button>
                    {image.repository !== "<none>" && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(ICON_BUTTON, "md:hidden")}
                            aria-label={`More actions for ${ref}`}
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onSelect={() => onPull(ref)}>
                            <ArrowDownToLineIcon />
                            Pull latest
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => onRemove(image)}>
                            <Trash2Icon />
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {toggle && <div className="border-t">{toggle}</div>}
        </div>
      )}
    </section>
  );
}

export function VolumesList({
  volumes,
  onRemove,
}: {
  volumes: DockerVolume[];
  onRemove: (volume: DockerVolume) => void;
}) {
  const { shown, toggle } = usePreview(volumes);
  return (
    <section aria-labelledby="volumes-heading" className="space-y-3">
      <SectionHeader
        id="volumes-heading"
        title="Volumes"
        count={volumes.length}
        description="Named volumes keep data when containers are removed."
      />
      {volumes.length === 0 ? (
        <EmptyState compact icon={<HardDriveIcon />} title="No volumes" />
      ) : (
        <div className={LIST}>
          <ul className="divide-y">
            {shown.map((v) => (
              <li key={v.name} className={ROW}>
                <HardDriveIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm" title={v.name}>
                    {v.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {v.usedBy.length > 0 ? `Used by ${v.usedBy.join(", ")}` : "Unused"} · {v.driver}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(ICON_BUTTON, "text-muted-foreground hover:text-destructive")}
                  title={v.usedBy.length > 0 ? "In use" : "Remove"}
                  aria-label={`Remove volume ${v.name}`}
                  disabled={v.usedBy.length > 0}
                  onClick={() => onRemove(v)}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
          {toggle && <div className="border-t">{toggle}</div>}
        </div>
      )}
    </section>
  );
}

export function NetworksList({
  networks,
  onRemove,
}: {
  networks: DockerNetwork[];
  onRemove: (network: DockerNetwork) => void;
}) {
  const { shown, toggle } = usePreview(networks);
  return (
    <section aria-labelledby="networks-heading" className="space-y-3">
      <SectionHeader
        id="networks-heading"
        title="Networks"
        count={networks.length}
        description="Containers on the same network reach each other by name."
      />
      <div className={LIST}>
        <ul className="divide-y">
          {shown.map((n) => (
            <li key={n.id} className={ROW}>
              <NetworkIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm">{n.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {n.driver} · {n.scope} · <span className="font-mono">{n.id}</span>
                </p>
              </div>
              {!n.builtin && (
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(ICON_BUTTON, "text-muted-foreground hover:text-destructive")}
                  title="Remove"
                  aria-label={`Remove network ${n.name}`}
                  onClick={() => onRemove(n)}
                >
                  <Trash2Icon />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {toggle && <div className="border-t">{toggle}</div>}
      </div>
    </section>
  );
}
