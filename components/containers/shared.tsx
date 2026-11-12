"use client";

import { useEffect, useRef, useState } from "react";
import { BoxIcon, TriangleAlertIcon } from "lucide-react";
import type {
  ContainerState,
  ContainerTemplate,
  DockerContainer,
  DockerOverview,
  EnvVar,
  RestartPolicy,
} from "@/lib/docker-types";
import { cn } from "@/lib/utils";

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** 20 URL-safe random characters for generated passwords. */
export function randomSecret(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** SI units (1 kB = 1000 B), matching how the docker CLI prints sizes. */
export function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const STATE_STYLES: Record<ContainerState, { dot: string; label: string; text: string }> = {
  running: { dot: "bg-emerald-500", label: "Running", text: "text-emerald-700 dark:text-emerald-400" },
  paused: { dot: "bg-amber-500", label: "Paused", text: "text-amber-700 dark:text-amber-400" },
  restarting: {
    dot: "bg-amber-500 animate-pulse motion-reduce:animate-none",
    label: "Restarting",
    text: "text-amber-700 dark:text-amber-400",
  },
  created: { dot: "bg-sky-500", label: "Created", text: "text-sky-700 dark:text-sky-400" },
  removing: {
    dot: "bg-muted-foreground animate-pulse motion-reduce:animate-none",
    label: "Removing",
    text: "text-muted-foreground",
  },
  exited: { dot: "bg-muted-foreground/50", label: "Stopped", text: "text-muted-foreground" },
  dead: { dot: "bg-destructive", label: "Dead", text: "text-destructive" },
};

export function StateDot({ state, className }: { state: ContainerState; className?: string }) {
  return (
    <span
      aria-label={STATE_STYLES[state].label}
      className={cn("inline-block size-2.5 shrink-0 rounded-full", STATE_STYLES[state].dot, className)}
    />
  );
}

export function Notice({
  tone = "muted",
  title,
  children,
}: {
  tone?: "muted" | "error";
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "animate-fade-in-soft flex gap-3 rounded-xl border p-4 text-sm",
        tone === "error" ? "border-destructive/30 bg-destructive/5" : "border-dashed",
      )}
    >
      <TriangleAlertIcon
        className={cn("mt-0.5 size-4 shrink-0", tone === "error" ? "text-destructive" : "text-muted-foreground")}
      />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{title}</p>
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  icon,
  action,
  compact = false,
}: {
  title: string;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  /** A one-line row instead of a centered block, for secondary sections. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-dashed px-4 py-3.5 text-sm sm:flex-row sm:items-center">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground max-sm:hidden [&_svg]:size-4">
          {icon ?? <BoxIcon />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          {children && <div className="text-xs text-muted-foreground">{children}</div>}
        </div>
        {action}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
      <span className="mb-1 flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-5">
        {icon ?? <BoxIcon />}
      </span>
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-sm text-sm text-balance text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Title row of a page section: label, count and trailing actions on one line. */
export function SectionHeader({
  id,
  title,
  count,
  description,
  actions,
  className,
}: {
  id?: string;
  title: string;
  count?: number | string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0">
        <h2 id={id} className="flex items-baseline gap-2 text-base font-semibold tracking-tight">
          {title}
          {count !== undefined && (
            <span className="text-sm font-normal text-muted-foreground tabular-nums">{count}</span>
          )}
        </h2>
        {description && <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Template logo with a neutral fallback when the remote image fails (offline, missing icon). */
export function TemplateLogo({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted", className)}>
        <BoxIcon className="size-4.5 text-muted-foreground" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("size-9 shrink-0 rounded-lg bg-white object-contain p-1 ring-1 ring-foreground/10", className)}
    />
  );
}

/** Streaming output of a docker job; follows the tail. */
export function JobLog({ lines, className }: { lines: string[]; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  if (lines.length === 0) return null;
  return (
    <pre
      ref={ref}
      aria-live="polite"
      className={cn(
        "max-h-56 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground",
        className,
      )}
    >
      {lines.slice(-400).join("\n")}
    </pre>
  );
}

/** Collapse docker's per-layer progress lines so the log stays readable. */
export function appendJobLine(lines: string[], line: string): string[] {
  const layer = /^([0-9a-f]{12}): /.exec(line)?.[1];
  if (layer) {
    const index = lines.findLastIndex((l) => l.startsWith(`${layer}: `));
    if (index >= 0) {
      const next = lines.slice();
      next[index] = line;
      return next;
    }
  }
  return [...lines, line];
}

// ---------------------------------------------------------------------------------------------
// Run form state

export interface PortRow {
  host: string;
  container: string;
  protocol: "tcp" | "udp";
}

export interface VolumeRow {
  source: string;
  target: string;
  readonly: boolean;
}

export interface EnvRow extends EnvVar {
  label?: string;
  description?: string;
  secret?: boolean;
  options?: { text: string; value: string }[];
}

export interface RunForm {
  image: string;
  name: string;
  ports: PortRow[];
  env: EnvRow[];
  volumes: VolumeRow[];
  restart: RestartPolicy;
  command: string;
  network: string;
  interactive: boolean;
  privileged: boolean;
  note?: string;
}

/** Host ports already published by containers (any state) on this Docker host. */
export function usedHostPorts(containers: DockerContainer[]): Set<number> {
  const used = new Set<number>();
  for (const c of containers) for (const p of c.ports) if (p.hostPort) used.add(p.hostPort);
  return used;
}

function freePort(preferred: number, used: Set<number>): number {
  let port = preferred;
  while (used.has(port) && port < 65535) port++;
  used.add(port);
  return port;
}

/** A container name not taken yet: "postgres", then "postgres-2", … */
export function uniqueName(base: string, taken: Set<string>): string {
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "") || "app";
  if (!taken.has(clean)) return clean;
  let n = 2;
  while (taken.has(`${clean}-${n}`)) n++;
  return `${clean}-${n}`;
}

/** "postgres:17", "ghcr.io/org/app:tag" → "postgres", "app". */
export function imageBaseName(image: string): string {
  const last = image.split("@")[0].split("/").pop() ?? image;
  return last.split(":")[0] || "app";
}

/** Defaults for a container template: free host ports, named volumes, generated secrets. */
export function formFromTemplate(template: ContainerTemplate, overview: DockerOverview | null): RunForm {
  const containers = overview?.containers ?? [];
  const used = usedHostPorts(containers);
  const name = uniqueName(
    template.source === "builtin" ? template.id : imageBaseName(template.image ?? template.title),
    new Set(containers.map((c) => c.name)),
  );
  const ports: PortRow[] = (template.ports ?? []).flatMap((spec) => {
    const match = /^(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/.exec(spec.trim());
    if (!match) return [];
    const container = Number(match[2]);
    const host = freePort(Number(match[1] ?? container), used);
    return [{ host: String(host), container: String(container), protocol: (match[3] ?? "tcp") as "tcp" | "udp" }];
  });
  const volumes: VolumeRow[] = (template.volumes ?? []).map((v) => {
    const suffix = v.container.split("/").filter(Boolean).pop() ?? "data";
    return { source: v.bind ?? `${name}-${suffix}`, target: v.container, readonly: Boolean(v.readonly) };
  });
  return {
    image: template.image ?? "",
    name,
    ports,
    env: envRows(template),
    volumes,
    restart: template.restart ?? (template.interactive ? "no" : "unless-stopped"),
    command: template.command ?? "",
    network: "",
    interactive: Boolean(template.interactive),
    privileged: Boolean(template.privileged),
    note: template.note,
  };
}

export function envRows(template: ContainerTemplate): EnvRow[] {
  return (template.env ?? []).map((e) => ({
    key: e.name,
    value: e.default ?? (e.secret ? randomSecret() : ""),
    label: e.label,
    description: e.description,
    secret: e.secret,
    options: e.options,
  }));
}

/** A blank run form for an image picked from search or typed in. */
export function formForImage(image: string, overview: DockerOverview | null): RunForm {
  return {
    image,
    name: uniqueName(imageBaseName(image), new Set((overview?.containers ?? []).map((c) => c.name))),
    ports: [],
    env: [],
    volumes: [],
    restart: "unless-stopped",
    command: "",
    network: "",
    interactive: false,
    privileged: false,
  };
}

/** Strip HTML tags from catalog notes (Portainer notes contain links and <b>). */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** Compose project names: lowercase, digits, "-", "_". */
export function projectNameFrom(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+|-+$/g, "")
      .slice(0, 40) || "stack";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
