"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CalendarSearchIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderOpenIcon,
  PackageCheckIcon,
  PaperclipIcon,
  PinIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { errorMessage, formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { FOCUS_RING, plural, useEntrance } from "@/components/home/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { ArtifactProject, ArtifactProjectResults, ArtifactResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  describePeriod,
  parsePeriod,
  PeriodFilter,
  periodParams,
  periodRange,
  type PeriodSelection,
} from "./period-filter";
import { ResultSkeleton, ResultView, StatusBadge } from "./result-view";

const ALL_TIME: PeriodSelection = { preset: "all", from: "", to: "" };

/** Every level lives in the URL, so back/forward and reload restore it. */
function hrefFor(period: PeriodSelection, project?: string | null, task?: string | null): string {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (project && task) params.set("task", task);
  periodParams(period, params);
  const query = params.toString();
  return query ? `/artifacts?${query}` : "/artifacts";
}

type LoadState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

const LOADING = { status: "loading" } as const;

/**
 * Runs `load` whenever it changes (callers memoize it on its inputs). A response is only kept
 * while its `load` is still current, so a slow answer for an old period or project never wins.
 */
function useLoad<T>(load: (() => Promise<T>) | null): { state: LoadState<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ load: () => Promise<T>; attempt: number; state: LoadState<T> } | null>(
    null,
  );
  useEffect(() => {
    if (!load) return;
    let stale = false;
    load().then(
      (data) => {
        if (!stale) setSettled({ load, attempt, state: { status: "ready", data } });
      },
      (error: unknown) => {
        if (!stale) setSettled({ load, attempt, state: { status: "error", message: errorMessage(error) } });
      },
    );
    return () => {
      stale = true;
    };
  }, [load, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const state = settled && settled.load === load && settled.attempt === attempt ? settled.state : LOADING;
  return { state, retry };
}

/** Rough plain text of a markdown summary for list previews: headings, code, link targets and markup dropped. */
function excerpt(markdown: string): string {
  const text = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split("\n")
    .filter((line) => !/^\s*(?:#{1,6}\s|[-*_]{3,}\s*$|\|?\s*:?-{3,})/.test(line))
    .map((line) => line.replace(/^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?/, ""))
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*{1,3}|~~|__|\|/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 280 ? `${text.slice(0, 280).trimEnd()}…` : text;
}

const ROW = cn(FOCUS_RING, "pressable relative flex w-full min-w-0 rounded-lg px-3 hover:bg-muted");

// ---------------------------------------------------------------------------------------------
// States

function LoadError({ what, message, onRetry }: { what: string; message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Couldn&apos;t load {what} <span className="text-muted-foreground">— {message}</span>
      </span>
      <Button variant="outline" size="sm" className="h-11 shrink-0 md:h-7" onClick={onRetry}>
        <RefreshCwIcon />
        Retry
      </Button>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-start gap-3 rounded-xl border border-dashed px-5 py-8", className)}>
      <span className="flex size-10 items-center justify-center rounded-lg border bg-background text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="max-w-[48ch]">
        <p className="text-sm font-medium">{title}</p>
        {children && <p className="mt-1 text-sm text-muted-foreground">{children}</p>}
      </div>
      {action}
    </div>
  );
}

function WidenLink({ href }: { href: string }) {
  return (
    <Button asChild variant="outline" size="sm" className="h-11 md:h-8">
      <Link href={href} scroll={false}>
        <CalendarSearchIcon />
        Show all time
      </Link>
    </Button>
  );
}

// ---------------------------------------------------------------------------------------------
// Level 1: projects

function ProjectRow({
  project,
  href,
  now,
  index,
}: {
  project: ArtifactProject;
  href: string;
  now: number;
  index: number;
}) {
  const empty = project.resultCount === 0;
  const enter = useEntrance()(index);
  return (
    <li className={enter.className} style={enter.style}>
      <Link href={href} scroll={false} className={cn(ROW, "min-h-14 items-center gap-3 py-2.5", empty && "opacity-60")}>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{project.name}</span>
            {project.pinned && <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
          </span>
          <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground" title={project.workdir}>
            {project.workdir}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
          {empty ? (
            <span className="text-muted-foreground">No results</span>
          ) : (
            <span className="font-medium tabular-nums">{plural(project.resultCount, "result")}</span>
          )}
          <span className="flex items-center gap-2 text-muted-foreground">
            {project.attachmentCount > 0 && (
              <span className="inline-flex items-center gap-0.5 tabular-nums" title={plural(project.attachmentCount, "attachment")}>
                <PaperclipIcon className="size-3" aria-hidden="true" />
                {project.attachmentCount}
              </span>
            )}
            {project.latestAt && (
              <time dateTime={project.latestAt} title={formatDateTime(project.latestAt)}>
                {formatRelative(project.latestAt, now)}
              </time>
            )}
          </span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

function ProjectListSkeleton() {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border bg-card p-1" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex min-h-14 items-center gap-3 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectList({
  state,
  retry,
  period,
  now,
}: {
  state: LoadState<ArtifactProject[]>;
  retry: () => void;
  period: PeriodSelection;
  now: number;
}) {
  if (state.status === "loading") return <ProjectListSkeleton />;
  if (state.status === "error") return <LoadError what="projects" message={state.message} onRetry={retry} />;
  const projects = state.data;
  if (projects.length === 0) {
    return (
      <EmptyState
        icon={FolderOpenIcon}
        title="No projects yet"
        action={
          <Button asChild variant="outline" size="sm" className="h-11 md:h-8">
            <Link href="/">Go to Home</Link>
          </Button>
        }
      >
        Create a project and run agents on its cards; their final results collect here.
      </EmptyState>
    );
  }
  const none = projects.every((project) => project.resultCount === 0);
  return (
    <div className="flex flex-col gap-3">
      {none && (
        <EmptyState
          icon={PackageCheckIcon}
          title={`No results ${describePeriod(period)}`}
          action={period.preset !== "all" ? <WidenLink href={hrefFor(ALL_TIME)} /> : undefined}
        >
          A card shows up once its agent run succeeds with a final report.
        </EmptyState>
      )}
      <ul className="flex flex-col gap-0.5 rounded-xl border bg-card p-1">
        {projects.map((project, index) => (
          <ProjectRow
            key={project.boardId}
            project={project}
            href={hrefFor(period, project.boardId)}
            now={now}
            index={index}
          />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Level 2: one project's results

function TaskRow({
  result,
  href,
  selected,
  now,
  index,
}: {
  result: ArtifactResult;
  href: string;
  selected: boolean;
  now: number;
  index: number;
}) {
  const preview = useMemo(() => excerpt(result.summary), [result.summary]);
  const enter = useEntrance()(index);
  return (
    <li className={enter.className} style={enter.style}>
      <Link
        href={href}
        scroll={false}
        aria-current={selected ? "page" : undefined}
        className={cn(
          ROW,
          "flex-col gap-1.5 py-2.5",
          "aria-[current=page]:bg-muted aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2.5 aria-[current=page]:before:left-0 aria-[current=page]:before:w-0.5 aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-primary",
        )}
      >
        <span className="flex min-w-0 items-start gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium">{result.title}</span>
          <StatusBadge status={result.status} />
        </span>
        {preview && <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{preview}</span>}
        <span className="flex items-center gap-2.5 text-xs text-muted-foreground">
          <time dateTime={result.finishedAt} title={formatDateTime(result.finishedAt)}>
            {formatRelative(result.finishedAt, now)}
          </time>
          {result.attachments.length > 0 && (
            <span className="inline-flex items-center gap-0.5 tabular-nums" title={plural(result.attachments.length, "attachment")}>
              <PaperclipIcon className="size-3" aria-hidden="true" />
              {result.attachments.length}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

function TaskListSkeleton() {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border bg-card p-1" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-2 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-5 w-16" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

function TaskList({
  state,
  retry,
  project,
  task,
  period,
  now,
}: {
  state: LoadState<ArtifactProjectResults>;
  retry: () => void;
  project: string;
  task: string | null;
  period: PeriodSelection;
  now: number;
}) {
  if (state.status === "loading") return <TaskListSkeleton />;
  if (state.status === "error") return <LoadError what="results" message={state.message} onRetry={retry} />;
  const { results } = state.data;
  if (results.length === 0) {
    return (
      <EmptyState
        icon={PackageCheckIcon}
        title={`No results ${describePeriod(period)}`}
        action={period.preset !== "all" ? <WidenLink href={hrefFor(ALL_TIME, project)} /> : undefined}
      >
        {period.preset !== "all"
          ? "Widen the period to see older work from this project."
          : "A card shows up once its agent run succeeds with a final report."}
      </EmptyState>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5 rounded-xl border bg-card p-1">
      {results.map((result, index) => (
        <TaskRow
          key={result.taskId}
          result={result}
          href={hrefFor(period, project, result.taskId)}
          selected={result.taskId === task}
          now={now}
          index={index}
        />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

/** Desktop only: on phones the back link above each level already says where you go. */
function Breadcrumbs({
  period,
  project,
  projectName,
  task,
  taskTitle,
}: {
  period: PeriodSelection;
  project: string;
  projectName: string;
  task: string | null;
  taskTitle: string;
}) {
  const crumbs: Array<{ label: string; href: string | null }> = [
    { label: "Projects", href: hrefFor(period) },
    { label: projectName, href: task ? hrefFor(period, project) : null },
  ];
  if (task) crumbs.push({ label: taskTitle, href: null });
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 max-lg:hidden">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => (
          <li key={index} className={cn("flex min-w-0 items-center gap-1", index === 0 && "shrink-0")}>
            {index > 0 && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
            {crumb.href ? (
              <Link
                href={crumb.href}
                scroll={false}
                className={cn(FOCUS_RING, "truncate rounded-sm text-muted-foreground hover:text-foreground")}
              >
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate font-medium">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      className={cn(
        FOCUS_RING,
        "pressable -ml-2 inline-flex h-11 max-w-full items-center gap-1 self-start rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground md:h-8",
      )}
    >
      <ChevronLeftIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </Link>
  );
}

/** Quiet right-hand placeholder on desktop when nothing is open there. */
function DetailPlaceholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-64 flex-col items-start justify-center gap-2 rounded-xl border border-dashed px-8 py-10 text-muted-foreground">
      <FileTextIcon className="size-5" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children && <p className="max-w-[48ch] text-sm">{children}</p>}
    </div>
  );
}

export function ArtifactsBrowser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const project = searchParams.get("project");
  const task = project ? searchParams.get("task") : null;
  const { preset, from, to } = parsePeriod(searchParams);
  const period = useMemo<PeriodSelection>(() => ({ preset, from, to }), [preset, from, to]);
  const now = useNow(60_000);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // Presets roll back from the moment they are chosen, then stay fixed so lists do not refetch on every render.
  const range = useMemo(() => periodRange(period), [period]);
  const loadProjects = useCallback(() => api.artifacts.projects(range), [range]);
  const loadResults = useMemo(
    () => (project ? () => api.artifacts.results(project, range) : null),
    [project, range],
  );
  const projects = useLoad(loadProjects);
  const results = useLoad(loadResults);

  const changePeriod = (next: PeriodSelection) =>
    router.replace(hrefFor(next, project, task), { scroll: false });

  const board = results.state.status === "ready" ? results.state.data.board : null;
  const projectName =
    board?.name ??
    (projects.state.status === "ready"
      ? projects.state.data.find((p) => p.boardId === project)?.name
      : undefined) ??
    "Project";
  const selected =
    results.state.status === "ready" && task
      ? results.state.data.results.find((result) => result.taskId === task) ?? null
      : null;
  const totals =
    projects.state.status === "ready"
      ? projects.state.data.reduce(
          (sum, p) => ({
            results: sum.results + p.resultCount,
            projects: sum.projects + (p.resultCount > 0 ? 1 : 0),
          }),
          { results: 0, projects: 0 },
        )
      : null;

  // lg+: the list column scrolls on its own, so a result picked far down it may open with its top
  // scrolled away; bring it back (below the sticky app header, via scroll-margin).
  const selectedId = selected?.taskId;
  useEffect(() => {
    const pane = detailRef.current;
    if (!selectedId || !pane || !window.matchMedia("(min-width: 64rem)").matches) return;
    const margin = Number.parseFloat(getComputedStyle(pane).scrollMarginTop) || 0;
    if (pane.getBoundingClientRect().top >= margin) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    pane.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [selectedId]);

  // Keep the open result's row visible in the list column (opened via ?task=, back/forward). Only
  // the column scrolls: below lg it does not overflow, so this is a no-op there.
  const resultList = results.state.status === "ready" ? results.state.data : null;
  useEffect(() => {
    const column = listRef.current;
    const row = column?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!column || !row) return;
    const bounds = column.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < bounds.top) column.scrollTop -= bounds.top - rect.top + 8;
    else if (rect.bottom > bounds.bottom) column.scrollTop += rect.bottom - bounds.bottom + 8;
  }, [resultList, task]);

  let detail: ReactNode;
  if (!project) {
    detail = (
      <DetailPlaceholder title="Pick a project">
        {totals && totals.results > 0
          ? `${plural(totals.results, "result")} across ${plural(totals.projects, "project")} ${describePeriod(period)}.`
          : "Its finished cards and their deliverables open here."}
      </DetailPlaceholder>
    );
  } else if (!task) {
    detail = <DetailPlaceholder title="Select a result">The summary and attachments open here.</DetailPlaceholder>;
  } else if (results.state.status === "loading") {
    detail = <ResultSkeleton />;
  } else if (results.state.status === "error") {
    // On desktop the list column already shows this error.
    detail = (
      <div className="lg:hidden">
        <LoadError what="results" message={results.state.message} onRetry={results.retry} />
      </div>
    );
  } else if (selected) {
    detail = <ResultView key={selected.taskId} result={selected} now={now} />;
  } else {
    detail = (
      <EmptyState
        icon={CalendarSearchIcon}
        title="Not in this period"
        action={period.preset !== "all" ? <WidenLink href={hrefFor(ALL_TIME, project, task)} /> : undefined}
      >
        This card has no final result {describePeriod(period)}.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tighter md:text-3xl">Artifacts</h1>
          <p className="mt-1 text-sm text-muted-foreground">Final results of your agents&apos; work, by project.</p>
        </div>
        <PeriodFilter value={period} onChange={changePeriod} />
      </div>

      {project && (
        <Breadcrumbs
          period={period}
          project={project}
          projectName={projectName}
          task={task}
          taskTitle={selected?.title ?? "Result"}
        />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)] lg:gap-8">
        {/* Phones show one level at a time: the list until a result is open, then only the result.
            lg+: the list sticks below the app header and scrolls on its own, so the window scroll
            belongs to the result. The 4px inset keeps row focus rings inside the scroll box. */}
        <div
          ref={listRef}
          className={cn(
            "flex min-w-0 flex-col gap-3 lg:sticky lg:top-[calc(3.5rem+env(safe-area-inset-top)+1rem)] lg:-m-1 lg:max-h-[calc(100dvh-3.5rem-env(safe-area-inset-top)-2rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:p-1",
            task && "max-lg:hidden",
          )}
        >
          {project ? (
            <>
              <div className="flex min-w-0 flex-col gap-0.5">
                <BackLink href={hrefFor(period)}>Projects</BackLink>
                <h2 className="truncate text-sm font-semibold tracking-tight">{projectName}</h2>
                {board && <p className="truncate font-mono text-xs text-muted-foreground" title={board.workdir}>{board.workdir}</p>}
              </div>
              <TaskList state={results.state} retry={results.retry} project={project} task={task} period={period} now={now} />
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold tracking-tight">Projects</h2>
              <ProjectList state={projects.state} retry={projects.retry} period={period} now={now} />
            </>
          )}
        </div>
        <div
          ref={detailRef}
          className={cn(
            "flex min-w-0 scroll-mt-[calc(3.5rem+env(safe-area-inset-top)+1rem)] flex-col gap-3",
            !task && "max-lg:hidden",
          )}
        >
          {project && task && (
            <div className="lg:hidden">
              <BackLink href={hrefFor(period, project)}>{projectName}</BackLink>
            </div>
          )}
          {detail}
        </div>
      </div>
    </div>
  );
}
