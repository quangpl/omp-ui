"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLineIcon,
  BadgeCheckIcon,
  BoxIcon,
  CheckCircle2Icon,
  CopyIcon,
  EyeIcon,
  FileCodeIcon,
  GlobeIcon,
  HardDriveIcon,
  Loader2Icon,
  PlayIcon,
  RocketIcon,
  ScrollTextIcon,
  SearchIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  StarIcon,
  XCircleIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { LogsTarget } from "@/components/containers/logs-sheet";
import {
  appendJobLine,
  envRows,
  errorMessage,
  formFromTemplate,
  imageBaseName,
  JobLog,
  projectNameFrom,
  TemplateLogo,
} from "@/components/containers/shared";
import { repositoryOf, TagPicker } from "@/components/containers/tag-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { api, type DockerJobResult } from "@/lib/api-client";
import type { ContainerTemplate, DockerOverview, EnvVar, HubRepository, QuickRunSpec } from "@/lib/docker-types";
import { cn } from "@/lib/utils";

/** One-click picks under the search box: single containers, then compose stacks. */
const POPULAR_CONTAINERS = ["postgres", "redis", "mysql", "mongo", "nginx", "rabbitmq", "minio", "mailpit", "ollama"];
const POPULAR_STACKS = [
  "postgres-pgadmin",
  "mongo-express",
  "mysql-adminer",
  "redis-insight",
  "prometheus-grafana",
  "elastic-kibana",
  "n8n-postgres",
  "minio-console",
  "ollama-open-webui",
  "kafka",
];

/** Friendly names of well-known registries for pasted references. */
const REGISTRY_NAMES: Record<string, string> = {
  "docker.io": "Docker Hub",
  "ghcr.io": "GitHub",
  "quay.io": "Quay",
  "registry.k8s.io": "Kubernetes",
  "public.ecr.aws": "Amazon ECR Public",
  "mcr.microsoft.com": "Microsoft",
  "gcr.io": "Google",
  "registry.gitlab.com": "GitLab",
  "nvcr.io": "NVIDIA",
  "lscr.io": "LinuxServer",
  "docker.elastic.co": "Elastic",
};

/** Same loose check as the server (lib/docker.ts): registry/repo:tag@digest characters only. */
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;
const HUB_LIMIT = 8;
const TEMPLATE_LIMIT = 5;
const LOCAL_LIMIT = 4;
/** Chip rows scroll sideways on phones (edge to edge of the card), wrap from `sm` up. */
const CHIP_ROW =
  "-mx-4 -my-1 flex gap-1.5 overflow-x-auto px-4 py-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

interface ParsedQuery {
  /** Lowercased text templates and local images are matched against. */
  filter: string;
  /** Docker Hub search text, or null (other registry, too short). */
  hubTerm: string | null;
  /** A runnable reference the user typed or pasted (tag, digest, registry host, "docker pull …"). */
  ref: { image: string; registry: string } | null;
}

/** Understand what was typed: a search, a full image reference, `docker pull x` or a Hub page link. */
function parseQuery(raw: string): ParsedQuery {
  const typed = raw.trim();
  let text = typed;
  const pull = /^(?:docker|podman)\s+pull\s+(?:-\S+\s+)*(\S+)$/.exec(text);
  if (pull) text = pull[1];
  const hubLink = /^https?:\/\/hub\.docker\.com\/(?:_\/([\w.-]+)|r\/([\w.-]+\/[\w.-]+))/.exec(text);
  if (hubLink) text = hubLink[1] ?? hubLink[2];

  if (!text || /\s/.test(text) || !IMAGE_RE.test(text)) {
    const filter = typed.toLowerCase();
    return { filter, hubTerm: filter.length >= 2 ? filter : null, ref: null };
  }
  const first = text.split("/")[0];
  const hasRegistry = text.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  const hasTag = (text.split("/").pop() ?? "").includes(":") || text.includes("@");
  const onHub = !hasRegistry || first === "docker.io";
  const hubRepo = onHub ? repositoryOf(text).replace(/^docker\.io\//, "").replace(/^library\//, "") : null;
  const isRef = hasRegistry || hasTag || text !== typed;
  return {
    filter: (hubRepo ?? imageBaseName(text)).toLowerCase(),
    hubTerm: hubRepo && hubRepo.length >= 2 ? hubRepo.toLowerCase() : null,
    ref: isRef ? { image: text, registry: hasRegistry ? (REGISTRY_NAMES[first] ?? first) : "Docker Hub" } : null,
  };
}

type Result =
  | { key: string; kind: "ref"; image: string; registry: string }
  | { key: string; kind: "template"; template: ContainerTemplate }
  | { key: string; kind: "local"; image: string; size: string }
  | { key: string; kind: "hub"; repo: HubRepository };

interface RemoteState {
  term: string;
  loading: boolean;
  hub: HubRepository[];
  hubError: string | null;
  quay: HubRepository[];
}

interface LaunchJob {
  key: number;
  /** Result / template key it came from: its Run button spins meanwhile. */
  source: string;
  title: string;
  kind: "container" | "compose";
  status: "running" | "ok" | "failed";
  lines: string[];
  message: string;
  /** Container id or compose project name once started. */
  id?: string;
  /** Generated passwords worth showing once. */
  secrets: EnvVar[];
}

/** Layers done / total of a running `docker pull`, from the collapsed per-layer lines. */
function pullProgress(lines: string[]): { done: number; total: number } | null {
  const layers = lines.filter((l) => /^[0-9a-f]{12}: /.test(l));
  if (layers.length === 0) return null;
  const done = layers.filter((l) => /: (Pull complete|Already exists)/.test(l)).length;
  return { done, total: layers.length };
}

function Secret({ entry }: { entry: EnvVar }) {
  const [shown, setShown] = useState(false);
  const canCopy = typeof navigator !== "undefined" && Boolean(navigator.clipboard);
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-muted/70 py-0.5 pr-0.5 pl-2 font-mono text-[0.7rem]">
      <span className="text-muted-foreground">{entry.key}=</span>
      <span className="truncate">{shown ? entry.value : "••••••••"}</span>
      <button
        type="button"
        className="rounded p-1.5 text-muted-foreground hover:text-foreground md:p-1"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? `Hide ${entry.key}` : `Show ${entry.key}`}
      >
        <EyeIcon className="size-3" />
      </button>
      {canCopy && (
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:text-foreground md:p-1"
          onClick={() =>
            void navigator.clipboard.writeText(entry.value).then(
              () => toast.success(`Copied ${entry.key}`),
              () => toast.error("Could not copy"),
            )
          }
          aria-label={`Copy ${entry.key}`}
        >
          <CopyIcon className="size-3" />
        </button>
      )}
    </span>
  );
}

function JobCard({
  job,
  overview,
  onDismiss,
  onLogs,
}: {
  job: LaunchJob;
  overview: DockerOverview;
  onDismiss: () => void;
  onLogs: (target: LogsTarget) => void;
}) {
  const [showLog, setShowLog] = useState(false);
  const started =
    job.status === "ok" && job.id
      ? overview.containers.filter((c) =>
          job.kind === "compose" ? c.composeProject === job.id : c.id.startsWith(job.id ?? "-"),
        )
      : [];
  const ports = [...new Set(started.flatMap((c) => c.ports.flatMap((p) => (p.hostPort ? [p.hostPort] : []))))].sort(
    (a, b) => a - b,
  );
  const progress = job.status === "running" ? pullProgress(job.lines) : null;
  const host = typeof window === "undefined" ? "localhost" : window.location.hostname;
  const logsTarget: LogsTarget | null =
    job.status !== "ok" || !job.id
      ? null
      : job.kind === "compose"
        ? { kind: "compose", id: job.id, name: job.id }
        : { kind: "container", id: job.id, name: started[0]?.name ?? job.title };

  return (
    <li className="animate-in fade-in-0 slide-in-from-top-1 space-y-2 rounded-xl p-3 ring-1 ring-foreground/10 motion-reduce:animate-none">
      <div className="flex items-start gap-2">
        {job.status === "running" ? (
          <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        ) : job.status === "ok" ? (
          <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
        ) : (
          <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm">{job.title}</p>
          <p
            className={cn(
              "text-xs break-words",
              job.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {job.status === "running"
              ? progress
                ? `Pulling layers ${progress.done}/${progress.total}`
                : (job.lines.at(-1) ?? "Starting…")
              : job.message}
          </p>
        </div>
        {logsTarget && (
          <Button variant="ghost" size="sm" className="h-11 gap-1.5 md:h-7" onClick={() => onLogs(logsTarget)}>
            <ScrollTextIcon />
            Logs
          </Button>
        )}
        {job.lines.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-11 md:h-7"
            onClick={() => setShowLog((s) => !s)}
            aria-expanded={showLog}
          >
            {showLog ? "Hide output" : "Output"}
          </Button>
        )}
        {job.status !== "running" && (
          <Button variant="ghost" size="icon" className="size-11 md:size-7" onClick={onDismiss} aria-label="Dismiss">
            <XIcon />
          </Button>
        )}
      </div>
      {progress && (
        <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div
            className="h-full origin-left bg-primary transition-transform duration-300 motion-reduce:transition-none"
            style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 0})` }}
          />
        </div>
      )}
      {(ports.length > 0 || job.secrets.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {ports.map((port) => (
            <a
              key={port}
              href={`http://${host}:${port}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2 font-mono text-xs text-primary tabular-nums hover:bg-primary/15"
              title="Open in a new tab"
            >
              <GlobeIcon className="size-3" />
              {host}:{port}
            </a>
          ))}
          {job.status === "ok" && job.secrets.map((entry) => <Secret key={entry.key} entry={entry} />)}
        </div>
      )}
      {(showLog || job.status === "failed") && <JobLog lines={job.lines} className="max-h-48" />}
    </li>
  );
}

/**
 * The fastest way in: one search box over built-in/catalog templates, local images and live Docker
 * Hub results; paste any image reference (ghcr.io/…, quay.io/…, registry.k8s.io/…, public.ecr.aws/…).
 * Enter runs with smart defaults (free ports, unused name) and streams progress inline; ⇧Enter
 * opens the run dialog instead. Compose stacks start with one click.
 */
export function QuickLaunch({
  overview,
  templates,
  inputRef,
  onWantCatalog,
  onCustomizeTemplate,
  onCustomizeImage,
  onPullImage,
  onLaunched,
  onLogs,
  onImportCompose,
}: {
  overview: DockerOverview;
  /** Built-ins plus the remote catalog once loaded. */
  templates: readonly ContainerTemplate[];
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** First focus: a good moment to fetch the remote app catalog. */
  onWantCatalog: () => void;
  onCustomizeTemplate: (template: ContainerTemplate) => void;
  onCustomizeImage: (image: string) => void;
  onPullImage: (image: string) => void;
  onLaunched: () => void;
  onLogs: (target: LogsTarget) => void;
  onImportCompose: () => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [includeQuay, setIncludeQuay] = useState(false);
  const [showAllHub, setShowAllHub] = useState(false);
  const [tagOverrides, setTagOverrides] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<LaunchJob[]>([]);
  const searchSeq = useRef(0);
  const jobSeq = useRef(0);

  const parsed = useMemo(() => parseQuery(query), [query]);

  useEffect(() => {
    const term = parsed.hubTerm;
    if (!term) {
      searchSeq.current++;
      setRemote(null);
      return;
    }
    const seq = ++searchSeq.current;
    setRemote((prev) => ({
      term,
      loading: true,
      hub: prev?.hub ?? [],
      hubError: null,
      quay: prev?.quay ?? [],
    }));
    const timer = window.setTimeout(async () => {
      const [hub, quay] = await Promise.allSettled([
        api.docker.search(term, "dockerhub"),
        includeQuay ? api.docker.search(term, "quay") : Promise.resolve([]),
      ]);
      if (seq !== searchSeq.current) return;
      setRemote({
        term,
        loading: false,
        hub: hub.status === "fulfilled" ? hub.value : [],
        hubError: hub.status === "rejected" ? errorMessage(hub.reason, "Docker Hub is unreachable") : null,
        quay: quay.status === "fulfilled" ? quay.value : [],
      });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [parsed.hubTerm, includeQuay]);

  const results = useMemo<Result[]>(() => {
    if (!query.trim()) return [];
    const out: Result[] = [];
    if (parsed.ref) out.push({ key: `ref:${parsed.ref.image}`, kind: "ref", ...parsed.ref });
    const term = parsed.filter;
    if (term) {
      const score = (t: ContainerTemplate) => {
        const id = t.id.toLowerCase();
        const title = t.title.toLowerCase();
        if (id === term || title === term) return 0;
        if (id.startsWith(term) || title.startsWith(term)) return 1;
        if (title.includes(term) || (t.image ?? "").toLowerCase().includes(term)) return 2;
        if (t.description.toLowerCase().includes(term)) return 3;
        return 9;
      };
      const matched = templates
        .map((t) => ({ t, s: score(t) + (t.source === "builtin" ? 0 : 0.5) }))
        .filter(({ s }) => s < 9)
        .sort((a, b) => a.s - b.s)
        .slice(0, TEMPLATE_LIMIT);
      for (const { t } of matched) out.push({ key: `template:${t.id}`, kind: "template", template: t });

      const seen = new Set<string>();
      for (const image of overview.images) {
        if (image.repository === "<none>") continue;
        const ref = `${image.repository}:${image.tag}`;
        if (seen.has(ref) || !ref.toLowerCase().includes(term)) continue;
        seen.add(ref);
        out.push({ key: `local:${ref}`, kind: "local", image: ref, size: image.size });
        if (seen.size >= LOCAL_LIMIT) break;
      }
    }
    if (remote && remote.term === parsed.hubTerm) {
      const hub = showAllHub ? remote.hub : remote.hub.slice(0, HUB_LIMIT);
      for (const repo of [...hub, ...remote.quay]) out.push({ key: `hub:${repo.name}`, kind: "hub", repo });
    }
    return out;
  }, [query, parsed, templates, overview.images, remote, showAllHub]);

  useEffect(() => {
    setActive(0);
    setShowAllHub(false);
  }, [query]);

  useEffect(() => {
    if (active >= results.length && results.length > 0) setActive(results.length - 1);
  }, [active, results.length]);

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  const composeNames = useMemo(() => new Set(overview.composeProjects.map((p) => p.name)), [overview.composeProjects]);
  const runningSources = new Set(jobs.filter((j) => j.status === "running").map((j) => j.source));

  function startJob(
    source: string,
    title: string,
    kind: LaunchJob["kind"],
    secrets: EnvVar[],
    run: (onLine: (line: string) => void) => Promise<DockerJobResult>,
  ) {
    const key = ++jobSeq.current;
    const update = (patch: (job: LaunchJob) => Partial<LaunchJob>) =>
      setJobs((list) => list.map((j) => (j.key === key ? { ...j, ...patch(j) } : j)));
    setJobs((list) => [
      { key, source, title, kind, status: "running" as const, lines: [], message: "", secrets },
      ...list.filter((j) => j.status === "running" || list.indexOf(j) < 3),
    ]);
    run((line) => update((j) => ({ lines: appendJobLine(j.lines, line) }))).then(
      (result) => {
        update(() => ({ status: result.ok ? "ok" : "failed", message: result.message, id: result.id }));
        if (result.ok) toast.success(result.message);
        onLaunched();
      },
      (err: unknown) => {
        update(() => ({ status: "failed", message: errorMessage(err, "Could not start it") }));
        onLaunched();
      },
    );
  }

  function runTemplate(template: ContainerTemplate, source: string, image?: string) {
    if (template.kind === "compose") {
      const env = envRows(template);
      startJob(
        source,
        template.title,
        "compose",
        env.filter((e) => e.secret).map(({ key, value }) => ({ key, value })),
        (onLine) =>
          api.docker.quickCompose(
            {
              template: template.id,
              name: projectNameFrom(template.source === "builtin" ? template.id : template.title, composeNames),
              env: env.filter((e) => e.key.trim()).map(({ key, value }) => ({ key, value })),
            },
            onLine,
          ),
      );
      return;
    }
    const form = formFromTemplate(template, overview);
    const spec: QuickRunSpec = {
      image: image ?? form.image,
      name: form.name,
      ports: form.ports.map((p) => ({
        container: Number(p.container),
        host: Number(p.host) || undefined,
        protocol: p.protocol,
      })),
      env: form.env.filter((e) => e.key.trim()).map(({ key, value }) => ({ key, value })),
      volumes: form.volumes,
      restart: form.restart,
      command: form.command || undefined,
      interactive: form.interactive,
      privileged: form.privileged,
    };
    startJob(
      source,
      spec.image,
      "container",
      form.env.filter((e) => e.secret).map(({ key, value }) => ({ key, value })),
      (onLine) => api.docker.quickRun(spec, onLine),
    );
  }

  function runImage(image: string, source: string) {
    startJob(source, image, "container", [], (onLine) => api.docker.quickRun({ image, autoPorts: true }, onLine));
  }

  const imageOf = (r: Result): string => {
    switch (r.kind) {
      case "ref":
      case "local":
        return r.image;
      case "template":
        return tagOverrides[r.key] ?? r.template.image ?? "";
      case "hub":
        return tagOverrides[r.key] ?? (r.repo.name.startsWith("quay.io/") ? r.repo.name : `${r.repo.name}:latest`);
    }
  };

  function run(r: Result) {
    if (runningSources.has(r.key)) return;
    if (r.kind === "template") runTemplate(r.template, r.key, tagOverrides[r.key]);
    else runImage(imageOf(r), r.key);
  }

  function customize(r: Result) {
    if (r.kind === "template") {
      const image = tagOverrides[r.key];
      onCustomizeTemplate(image ? { ...r.template, image } : r.template);
    } else {
      onCustomizeImage(imageOf(r));
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (results.length === 0) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (!r) return;
      if (e.shiftKey) customize(r);
      else run(r);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else e.currentTarget.blur();
    }
  }

  const popularContainers = POPULAR_CONTAINERS.flatMap((id) => templates.find((t) => t.id === id) ?? []);
  const popularStacks = POPULAR_STACKS.flatMap((id) => templates.find((t) => t.id === id) ?? []);
  const hubCount = remote && remote.term === parsed.hubTerm ? remote.hub.length : 0;
  const searching = Boolean(remote?.loading);
  const activeResult = results[active];

  const chip = (t: ContainerTemplate) => {
    const key = `template:${t.id}`;
    const busy = runningSources.has(key);
    return (
      <button
        key={t.id}
        type="button"
        disabled={busy}
        onClick={(e) => (e.shiftKey ? onCustomizeTemplate(t) : runTemplate(t, key))}
        className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-muted/70 py-1 pr-3 pl-1 text-xs font-medium whitespace-nowrap outline-none transition-[background-color,color,scale] hover:bg-primary/10 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.98] disabled:opacity-60 md:h-8"
        title={`${t.description}\nClick to start with defaults, Shift-click to customize.`}
      >
        {busy ? (
          <span className="flex size-6 items-center justify-center">
            <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
          </span>
        ) : (
          <TemplateLogo src={t.logo} className="size-6 rounded-full p-0.5" />
        )}
        {t.title}
      </button>
    );
  };

  return (
    <section
      aria-labelledby="quick-launch"
      className="animate-fade-in-soft space-y-4 rounded-2xl bg-card p-4 ring-1 ring-foreground/10 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary max-sm:hidden">
          <ZapIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="quick-launch" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            Launch
            <Kbd className="max-md:hidden">L</Kbd>
          </h2>
          <p className="line-clamp-2 text-xs text-pretty text-muted-foreground sm:text-sm">
            Templates, local images and Docker Hub in one search; paste any image from ghcr.io, quay.io, registry.k8s.io,
            public.ecr.aws…
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-11 shrink-0 gap-1.5 md:h-8" onClick={onImportCompose}>
          <FileCodeIcon />
          <span className="max-sm:hidden">Compose from YAML / URL</span>
          <span className="sm:hidden">Compose</span>
        </Button>
      </div>

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={onWantCatalog}
          placeholder="redis, grafana/grafana, ghcr.io/org/app:1.2…"
          className="h-12 rounded-xl bg-background pr-10 pl-10 font-mono text-base md:text-sm"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeResult ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          aria-label="Search images and apps, or paste an image reference"
          autoComplete="off"
          spellCheck={false}
        />
        {searching ? (
          <Loader2Icon className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none" />
        ) : (
          query && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-2.5 text-muted-foreground hover:text-foreground md:p-1.5"
              aria-label="Clear"
            >
              <XIcon className="size-4" />
            </button>
          )
        )}
      </div>

      {query.trim() && (
        <div className="space-y-1.5">
          {results.length > 0 ? (
            <ul
              id={listId}
              role="listbox"
              aria-label="Launch results"
              className="max-h-[28rem] divide-y overflow-y-auto rounded-xl ring-1 ring-foreground/10"
            >
              {results.map((r, index) => {
                const image = imageOf(r);
                const busy = runningSources.has(r.key);
                const isCompose = r.kind === "template" && r.template.kind === "compose";
                return (
                  <li
                    key={r.key}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseMove={() => index !== active && setActive(index)}
                    className={cn(
                      "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:flex-nowrap",
                      index === active && "bg-muted/70",
                    )}
                  >
                    {r.kind === "template" ? (
                      <TemplateLogo src={r.template.logo} className="size-8" />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        {r.kind === "local" ? (
                          <HardDriveIcon className="size-4" />
                        ) : r.kind === "ref" ? (
                          <GlobeIcon className="size-4" />
                        ) : (
                          <BoxIcon className="size-4" />
                        )}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-sm">
                          {r.kind === "template" ? r.template.title : r.kind === "hub" ? r.repo.name : r.image}
                        </span>
                        {r.kind === "template" && (
                          <span className="shrink-0 rounded bg-muted px-1.5 text-[0.65rem] font-medium text-muted-foreground">
                            {isCompose ? "Stack" : "Template"}
                          </span>
                        )}
                        {r.kind === "local" && (
                          <span className="shrink-0 rounded bg-muted px-1.5 text-[0.65rem] font-medium text-muted-foreground">
                            Local
                          </span>
                        )}
                        {r.kind === "ref" && (
                          <span className="shrink-0 rounded bg-muted px-1.5 text-[0.65rem] font-medium text-muted-foreground">
                            {r.registry}
                          </span>
                        )}
                        {r.kind === "hub" && r.repo.official && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 text-[0.65rem] font-medium text-sky-600 dark:text-sky-400">
                            <BadgeCheckIcon className="size-3.5" />
                            Official
                          </span>
                        )}
                        {r.kind === "hub" && r.repo.verified && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 text-[0.65rem] font-medium text-emerald-700 dark:text-emerald-400">
                            <ShieldCheckIcon className="size-3.5" />
                            Verified
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.kind === "template"
                          ? isCompose
                            ? r.template.description
                            : `${r.template.image ?? ""} · ${r.template.description}`
                          : r.kind === "hub"
                            ? r.repo.description || "No description"
                            : r.kind === "local"
                              ? `On this host · ${r.size}`
                              : `Run ${r.image} from ${r.registry}`}
                      </p>
                      {r.kind === "hub" && (
                        <p className="flex gap-3 text-[0.7rem] text-muted-foreground tabular-nums">
                          <span className="inline-flex items-center gap-1">
                            <StarIcon className="size-3" />
                            {compact.format(r.repo.stars)}
                          </span>
                          {r.repo.pulls > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <ArrowDownToLineIcon className="size-3" />
                              {compact.format(r.repo.pulls)}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      {(r.kind === "hub" || r.kind === "ref" || (r.kind === "template" && !isCompose)) && (
                        <TagPicker
                          variant="chip"
                          image={image}
                          disabled={busy}
                          onPick={(picked) => setTagOverrides((o) => ({ ...o, [r.key]: picked }))}
                        />
                      )}
                      {!isCompose && r.kind !== "local" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-11 text-muted-foreground md:size-8"
                          onClick={() => onPullImage(image)}
                          disabled={busy}
                          title="Pull only"
                          aria-label={`Pull ${image}`}
                        >
                          <ArrowDownToLineIcon />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 text-muted-foreground md:size-8"
                        onClick={() => customize(r)}
                        disabled={busy}
                        title="Customize (⇧↵)"
                        aria-label={`Customize ${image || (r.kind === "template" ? r.template.title : "")}`}
                      >
                        <SlidersHorizontalIcon />
                      </Button>
                      <Button
                        size="sm"
                        className="h-11 min-w-16 gap-1 md:h-8"
                        onClick={() => run(r)}
                        disabled={busy}
                        title="Start with defaults (↵)"
                      >
                        {busy ? (
                          <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                        ) : isCompose ? (
                          <RocketIcon />
                        ) : (
                          <PlayIcon />
                        )}
                        {isCompose ? "Up" : "Run"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            !searching && (
              <p className="rounded-xl p-4 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
                {parsed.hubTerm || parsed.ref
                  ? `Nothing matches “${query.trim()}”.`
                  : "Type at least two characters to search Docker Hub."}
              </p>
            )
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground">
            <span className="max-md:hidden">
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>↵</Kbd> run with defaults · <Kbd>⇧↵</Kbd> customize ·{" "}
              <Kbd>Esc</Kbd> clear
            </span>
            {remote?.hubError && remote.term === parsed.hubTerm && (
              <span>Docker Hub unreachable; showing templates and local images.</span>
            )}
            <span className="ml-auto flex items-center gap-2">
              {hubCount > HUB_LIMIT && (
                <button type="button" className="hover:text-foreground" onClick={() => setShowAllHub((s) => !s)}>
                  {showAllHub ? "Fewer Docker Hub results" : `All ${hubCount} Docker Hub results`}
                </button>
              )}
              {parsed.hubTerm && (
                <button
                  type="button"
                  className="hover:text-foreground"
                  aria-pressed={includeQuay}
                  onClick={() => setIncludeQuay((s) => !s)}
                >
                  {includeQuay ? "Hide Quay.io" : "Also search Quay.io"}
                </button>
              )}
            </span>
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <ul className="space-y-2" aria-label="Launches">
          {jobs.map((job) => (
            <JobCard
              key={job.key}
              job={job}
              overview={overview}
              onLogs={onLogs}
              onDismiss={() => setJobs((list) => list.filter((j) => j.key !== job.key))}
            />
          ))}
        </ul>
      )}

      {!query.trim() && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-[0.7rem] font-medium text-muted-foreground">
              Popular · one click to start with defaults
            </p>
            <div className={CHIP_ROW} aria-label="Popular containers">
              {popularContainers.map(chip)}
            </div>
          </div>
          {popularStacks.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[0.7rem] font-medium text-muted-foreground">
                Compose stacks · one click to start, Shift-click to customize
              </p>
              <div className={CHIP_ROW} aria-label="Popular compose stacks">
                {popularStacks.map(chip)}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
