"use client";

import { useState } from "react";
import {
  ArrowDownToLineIcon,
  BrushCleaningIcon,
  HardDriveIcon,
  NetworkIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { EmptyState } from "@/components/containers/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DockerImage, DockerNetwork, DockerVolume, PruneKind } from "@/lib/docker-types";

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 sm:flex-row sm:items-center">{children}</div>;
}

function PruneButton({ label, onPrune }: { label: string; onPrune: () => void }) {
  return (
    <Button variant="outline" onClick={onPrune} className="h-11 shrink-0 gap-2 md:h-9">
      <BrushCleaningIcon />
      {label}
    </Button>
  );
}

export function ImagesList({
  images,
  onRun,
  onPull,
  onRemove,
  onPrune,
}: {
  images: DockerImage[];
  onRun: (image: string) => void;
  onPull: (image: string) => void;
  onRemove: (image: DockerImage) => void;
  onPrune: (kind: PruneKind) => void;
}) {
  const [pull, setPull] = useState("");
  const refOf = (image: DockerImage) =>
    image.repository === "<none>" ? image.id : `${image.repository}:${image.tag}`;
  return (
    <div className="space-y-3">
      <Toolbar>
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pull.trim()) onPull(pull.trim());
            setPull("");
          }}
        >
          <Input
            value={pull}
            onChange={(e) => setPull(e.target.value)}
            placeholder="Pull an image: redis:7, ghcr.io/org/app:tag"
            className="h-11 font-mono text-sm md:h-9"
            aria-label="Image to pull"
            spellCheck={false}
          />
          <Button type="submit" className="h-11 shrink-0 gap-2 md:h-9" disabled={!pull.trim()}>
            <ArrowDownToLineIcon />
            Pull
          </Button>
        </form>
        <PruneButton label="Remove dangling" onPrune={() => onPrune("images")} />
      </Toolbar>
      {images.length === 0 ? (
        <EmptyState title="No images" />
      ) : (
        <ul className="divide-y rounded-xl bg-card ring-1 ring-foreground/10">
          {images.map((image) => {
            const ref = refOf(image);
            return (
              <li key={`${image.id}-${image.repository}-${image.tag}`} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm">
                      {image.repository}
                      <span className="text-muted-foreground">:{image.tag}</span>
                    </span>
                    {image.containers > 0 && (
                      <Badge variant="secondary" className="font-normal">
                        in use
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {image.size} · {image.createdSince} · <span className="font-mono">{image.id}</span>
                  </p>
                </div>
                {image.repository !== "<none>" && (
                  <>
                    <Button variant="ghost" size="icon" className="size-11 md:size-8" title="Pull latest" aria-label={`Pull ${ref}`} onClick={() => onPull(ref)}>
                      <ArrowDownToLineIcon />
                    </Button>
                    <Button variant="ghost" size="icon" className="size-11 md:size-8" title="Run" aria-label={`Run ${ref}`} onClick={() => onRun(ref)}>
                      <PlayIcon />
                    </Button>
                  </>
                )}
                <Button variant="ghost" size="icon" className="size-11 text-destructive md:size-8" title="Remove" aria-label={`Remove ${ref}`} onClick={() => onRemove(image)}>
                  <Trash2Icon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function VolumesList({
  volumes,
  onRemove,
  onPrune,
}: {
  volumes: DockerVolume[];
  onRemove: (volume: DockerVolume) => void;
  onPrune: (kind: PruneKind) => void;
}) {
  return (
    <div className="space-y-3">
      <Toolbar>
        <p className="flex-1 text-sm text-muted-foreground">
          Named volumes keep data when containers are removed.
        </p>
        <PruneButton label="Remove unused" onPrune={() => onPrune("volumes")} />
      </Toolbar>
      {volumes.length === 0 ? (
        <EmptyState title="No volumes" />
      ) : (
        <ul className="divide-y rounded-xl bg-card ring-1 ring-foreground/10">
          {volumes.map((v) => (
            <li key={v.name} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
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
                className="size-11 text-destructive md:size-8"
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
      )}
    </div>
  );
}

export function NetworksList({
  networks,
  onRemove,
  onPrune,
}: {
  networks: DockerNetwork[];
  onRemove: (network: DockerNetwork) => void;
  onPrune: (kind: PruneKind) => void;
}) {
  return (
    <div className="space-y-3">
      <Toolbar>
        <p className="flex-1 text-sm text-muted-foreground">Containers on the same network reach each other by name.</p>
        <PruneButton label="Remove unused" onPrune={() => onPrune("networks")} />
      </Toolbar>
      <ul className="divide-y rounded-xl bg-card ring-1 ring-foreground/10">
        {networks.map((n) => (
          <li key={n.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
            <NetworkIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm">{n.name}</p>
              <p className="text-xs text-muted-foreground">
                {n.driver} · {n.scope} · <span className="font-mono">{n.id}</span>
              </p>
            </div>
            {!n.builtin && (
              <Button
                variant="ghost"
                size="icon"
                className="size-11 text-destructive md:size-8"
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
    </div>
  );
}
