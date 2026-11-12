"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  FileDiff,
  FolderGit2,
  FolderX,
  RefreshCw,
  Rows2,
  SquareTerminal,
  TextWrap,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/components/board/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import {
  fallbackSummary,
  type DiffFile,
  type DiffFileStatus,
  type DiffSummary,
  type RepoDiff,
  type TaskDiff,
} from "@/lib/diff-types";
import { isTypingTarget } from "@/lib/hotkeys";
import type { AgentState } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Re-read the diff this often while the card's agent works and the tab is shown. */
const POLL_MS = 15_000;
/** Files with more diff lines than this start collapsed. */
const LARGE_FILE_LINES = 600;
/** Summary requests per diff while the summary agent writes (each waits on the server). */
const SUMMARY_ATTEMPTS = 8;
const SUMMARY_RETRY_MS = 2000;
const PREFS_KEY = "omp-ui:diff-view";
/** Below the sticky tab bar of the card panel (TabsList + padding + border). */
const STICKY_TOP = "top-[53px] md:top-[45px]";

export interface TaskDiffState {
  diff: TaskDiff | null;
  /** The last load failed; the previous diff (if any) stays shown. */
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * The card's code changes. Re-read whenever the agent's state changes (it started, finished or
 * failed), every few seconds while `poll` is on, and on `refresh()`.
 */
export function useTaskDiff(taskId: string, agentState: AgentState | undefined, poll: boolean): TaskDiffState {
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.tasks.diff(taskId, { signal: controller.signal }).then(
      (next) => {
        setDiff(next);
        setError(null);
        setLoading(false);
      },
      (err) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [taskId, agentState, version]);

  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(() => setVersion((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  const refresh = useCallback(() => setVersion((n) => n + 1), []);
  return { diff, error, loading, refresh };
}

interface ViewPrefs {
  split: boolean;
  wrap: boolean;
}

interface Entry {
  key: string;
  repo: RepoDiff;
  file: DiffFile;
  /** Lines in the file's patch (0 without one). */
  lines: number;
}

/** The Changes tab: summary, stats, file list and the diff of every changed file. */
export function CodeChanges({
  taskId,
  active,
  visible,
  state,
}: {
  taskId: string;
  /** The card's agent is queued or running (the summary waits until it finishes). */
  active: boolean;
  /** The tab is shown: keys work, the summary is fetched. */
  visible: boolean;
  state: TaskDiffState;
}) {
  const { diff, error, loading, refresh } = state;
  const rootRef = useRef<HTMLDivElement>(null);
  // Nothing heavy renders until the tab is first opened.
  const [seen, setSeen] = useState(visible);
  useEffect(() => {
    if (visible) setSeen(true);
  }, [visible]);

  const [prefs, setPrefs] = useState<ViewPrefs>({ split: false, wrap: false });
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<ViewPrefs>;
      setPrefs({ split: saved.split === true, wrap: saved.wrap === true });
    } catch {
      // Defaults.
    }
  }, []);
  const updatePrefs = (patch: Partial<ViewPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const entries = useMemo<Entry[]>(
    () =>
      (diff?.repos ?? []).flatMap((repo) =>
        repo.files.map((file) => ({
          key: `${repo.folder}\0${file.path}`,
          repo,
          file,
          lines: file.patch ? file.patch.split("\n").length : 0,
        })),
      ),
    [diff],
  );
  // Files the user opened or closed; the rest follow the default (large files start collapsed).
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isOpen = (entry: Entry) => overrides[entry.key] ?? entry.lines <= LARGE_FILE_LINES;
  const allOpen = entries.length > 0 && entries.every(isOpen);
  const setAll = (open: boolean) => setOverrides(Object.fromEntries(entries.map((e) => [e.key, open])));
  const toggle = useCallback(
    (key: string, open: boolean) => setOverrides((prev) => ({ ...prev, [key]: open })),
    [],
  );

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const register = useCallback((key: string, node: HTMLElement | null) => {
    if (node) sectionRefs.current.set(key, node);
    else sectionRefs.current.delete(key);
  }, []);

  const goTo = (key: string) => {
    toggle(key, true);
    setActiveKey(key);
    requestAnimationFrame(() => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      sectionRefs.current.get(key)?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
    });
  };

  // Alt+↓ / Alt+↑: next / previous file (J/K and [/] belong to the panel).
  const stepRef = useRef<(delta: 1 | -1) => void>(() => undefined);
  stepRef.current = (delta) => {
    if (entries.length === 0) return;
    const index = entries.findIndex((e) => e.key === activeKey);
    const next = index === -1 ? (delta === 1 ? 0 : entries.length - 1) : (index + delta + entries.length) % entries.length;
    goTo(entries[next].key);
  };
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !event.altKey) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const panel = rootRef.current?.closest("[role='dialog']");
      const target = event.target;
      if (!(target instanceof HTMLElement) || !(target === document.body || panel?.contains(target))) return;
      if (isTypingTarget(target)) return;
      event.preventDefault();
      stepRef.current(event.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  const summary = useDiffSummary(taskId, diff, visible && !active);

  if (!seen) return null;
  if (!diff) {
    return error ? (
      <StateMessage
        icon={TriangleAlert}
        tone="error"
        title="Couldn't load the changes"
        detail={error}
        action={<RefreshButton onClick={refresh} loading={loading} label="Try again" />}
      />
    ) : (
      <ChangesSkeleton />
    );
  }

  const gitRepos = diff.repos.filter((repo) => repo.isRepo);
  if (gitRepos.length === 0) {
    const missing = diff.repos.find((repo) => repo.error);
    return (
      <StateMessage
        icon={FolderX}
        title="Not a git repository"
        detail={
          missing?.error ??
          `${diff.repos.map((repo) => `${repo.name}/`).join(", ")} ${diff.repos.length === 1 ? "is" : "are"} not tracked by git, so changes can't be shown.`
        }
        action={<RefreshButton onClick={refresh} loading={loading} />}
      />
    );
  }
  const repoErrors = diff.repos.filter((repo) => repo.error);
  if (diff.stats.files === 0) {
    return (
      <div ref={rootRef}>
        <RepoErrors repos={repoErrors} className="px-4 pt-3" />
        <StateMessage
          icon={FileDiff}
          title="No code changes yet"
          detail={
            active
              ? "The agent is working; files it changes show up here."
              : `Files the agent changes in ${gitRepos.map((repo) => `${repo.name}/`).join(", ")} show up here for review.`
          }
          action={<RefreshButton onClick={refresh} loading={loading} />}
        />
      </div>
    );
  }

  const multi = diff.repos.length > 1;
  const truncatedRepos = diff.repos.filter((repo) => repo.truncated);
  return (
    <div ref={rootRef} className="@container flex flex-col gap-3 px-4 py-3">
      <SummaryBar diff={diff} summary={summary} active={active} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">
            {diff.stats.files} {diff.stats.files === 1 ? "file" : "files"}
          </span>
          <Counts additions={diff.stats.additions} deletions={diff.stats.deletions} />
          {!multi && <BaseNote repo={gitRepos[0]} />}
        </p>
        <div className="ml-auto flex items-center gap-0.5">
          <ToolButton
            label={allOpen ? "Collapse all files" : "Expand all files"}
            onClick={() => setAll(!allOpen)}
          >
            {allOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
          </ToolButton>
          <ToolButton
            label={prefs.split ? "Unified view" : "Split view"}
            pressed={prefs.split}
            className="max-md:hidden"
            onClick={() => updatePrefs({ split: !prefs.split })}
          >
            {prefs.split ? <Rows2 /> : <Columns2 />}
          </ToolButton>
          <ToolButton label="Wrap long lines" pressed={prefs.wrap} onClick={() => updatePrefs({ wrap: !prefs.wrap })}>
            <TextWrap />
          </ToolButton>
          <ToolButton label="Refresh changes" onClick={refresh}>
            <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} />
          </ToolButton>
        </div>
      </div>

      {error && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-destructive">
          <TriangleAlert className="size-3.5" />
          Couldn't refresh: {error}
        </p>
      )}
      <RepoErrors repos={repoErrors} />
      {truncatedRepos.length > 0 && <TruncatedNotice repos={truncatedRepos} />}

      <div className="grid gap-3 @3xl:grid-cols-[15rem_minmax(0,1fr)]">
        <nav
          aria-label="Changed files"
          className="min-w-0 @3xl:sticky @3xl:top-14 @3xl:max-h-[calc(100dvh-7rem)] @3xl:self-start @3xl:overflow-y-auto"
        >
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-1.5 rounded-md text-left text-xs font-medium text-muted-foreground hover:text-foreground md:min-h-8 @3xl:hidden"
            aria-expanded={listOpen}
            onClick={() => setListOpen((open) => !open)}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform motion-reduce:transition-none", listOpen && "rotate-90")}
            />
            Files
            <span className="tabular-nums">{entries.length}</span>
          </button>
          <div className={cn(!listOpen && "hidden @3xl:block")}>
            {diff.repos.map((repo) => (
              <div key={repo.folder} className="flex flex-col">
                {multi && (
                  <p className="flex items-center gap-1 truncate px-1.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    <FolderGit2 className="size-3.5 shrink-0" />
                    {repo.name}/
                  </p>
                )}
                {!repo.isRepo && <p className="px-1.5 pb-1 text-xs text-muted-foreground">Not a git repository</p>}
                <ul className="flex flex-col">
                  {entries
                    .filter((entry) => entry.repo === repo)
                    .map((entry) => (
                      <li key={entry.key}>
                        <button
                          type="button"
                          title={entry.file.path}
                          aria-current={entry.key === activeKey ? "true" : undefined}
                          onClick={() => goTo(entry.key)}
                          className={cn(
                            "flex min-h-11 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs hover:bg-accent md:min-h-7",
                            entry.key === activeKey && "bg-accent",
                          )}
                        >
                          <StatusLetter file={entry.file} />
                          <PathLabel path={entry.file.path} className="min-w-0 flex-1" />
                          <Counts additions={entry.file.additions} deletions={entry.file.deletions} compact />
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <div className="flex min-w-0 flex-col gap-3">
          {diff.repos.map((repo) =>
            repo.files.length === 0 ? null : (
              <div key={repo.folder} className="flex flex-col gap-2">
                {multi && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1 font-medium text-foreground">
                      <FolderGit2 className="size-3.5" />
                      {repo.name}/
                    </span>
                    <BaseNote repo={repo} />
                  </div>
                )}
                {entries
                  .filter((entry) => entry.repo === repo)
                  .map((entry) => (
                    <FileDiffView
                      key={entry.key}
                      entryKey={entry.key}
                      file={entry.file}
                      lines={entry.lines}
                      open={isOpen(entry)}
                      current={entry.key === activeKey}
                      split={prefs.split}
                      wrap={prefs.wrap}
                      onToggle={toggle}
                      register={register}
                    />
                  ))}
              </div>
            ),
          )}
          <p className="hidden text-xs text-muted-foreground md:block">
            <Kbd>Alt</Kbd> <Kbd>↓</Kbd> / <Kbd>↑</Kbd> next / previous file
          </p>
        </div>
      </div>
    </div>
  );
}

interface SummaryState {
  summary: DiffSummary | null;
  error: string | null;
  regenerate: () => void;
}

/**
 * The summary of `diff`, fetched while `enabled` (tab shown, agent idle). The server answers the
 * fallback with `pending` while its summary agent writes; ask again until it is done.
 */
function useDiffSummary(taskId: string, diff: TaskDiff | null, enabled: boolean): SummaryState {
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const regenerateRef = useRef(false);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const hash = diff?.hash ?? null;
  const files = diff?.stats.files ?? 0;

  useEffect(() => {
    if (!enabled || !hash || files === 0) return;
    let regenerate = regenerateRef.current;
    regenerateRef.current = false;
    const known = summaryRef.current;
    if (!regenerate && known?.hash === hash && !known.pending) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      for (let attempt = 0; attempt < SUMMARY_ATTEMPTS; attempt++) {
        try {
          const next = await api.tasks.diffSummary(taskId, { regenerate, signal });
          if (signal.aborted) return;
          regenerate = false;
          setSummary(next);
          setError(null);
          if (!next.pending || next.hash !== hash) return;
        } catch (err) {
          if (!signal.aborted) setError(errorMessage(err));
          return;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, SUMMARY_RETRY_MS);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
        await promise;
        if (signal.aborted) return;
      }
      setError("The summary is taking too long. Try Regenerate.");
    })();
    return () => controller.abort();
  }, [taskId, hash, files, enabled, nonce]);

  const regenerate = useCallback(() => {
    regenerateRef.current = true;
    setSummary((prev) => (prev ? { ...prev, pending: true } : prev));
    setError(null);
    setNonce((n) => n + 1);
  }, []);
  return { summary, error, regenerate };
}

function SummaryBar({ diff, summary, active }: { diff: TaskDiff; summary: SummaryState; active: boolean }) {
  const current = summary.summary?.hash === diff.hash ? summary.summary : null;
  const pending = !active && !summary.error && (current?.pending ?? true);
  const text = !active && current ? current.text : fallbackSummary(diff);
  const note = active
    ? "A summary is written once the agent finishes."
    : summary.error
      ? `Summary unavailable: ${summary.error}`
      : current?.source === "fallback" && current.error
        ? `Summary unavailable: ${current.error}`
        : null;
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm text-pretty", pending && "text-muted-foreground")} aria-live="polite">
          {text}
        </p>
        {(pending || note) && (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {pending && (
              <>
                <Skeleton className="h-1.5 w-10 rounded-full" />
                Summarizing…
              </>
            )}
            {!pending && note && <span className="line-clamp-2 break-words">{note}</span>}
          </p>
        )}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="-my-0.5 shrink-0 text-muted-foreground max-md:h-11"
            disabled={active || pending}
            onClick={summary.regenerate}
          >
            <RefreshCw />
            <span className="max-sm:sr-only">Regenerate</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Write the summary again</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** "vs origin/main · 2 commits" or "uncommitted, vs HEAD". */
function BaseNote({ repo }: { repo: RepoDiff }) {
  if (!repo.baseRef) return <span>uncommitted changes{repo.branch ? ` on ${repo.branch}` : ""}</span>;
  return (
    <span className="truncate" title={repo.branch ? `${repo.branch} compared with ${repo.baseRef}` : undefined}>
      vs {repo.baseRef}
      {repo.commitsAhead > 0 && ` · ${repo.commitsAhead} ${repo.commitsAhead === 1 ? "commit" : "commits"}`}
    </span>
  );
}

function RepoErrors({ repos, className }: { repos: RepoDiff[]; className?: string }) {
  if (repos.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {repos.map((repo) => (
        <Alert key={repo.folder} variant="destructive">
          <TriangleAlert />
          <AlertTitle>Couldn't read {repo.name}/</AlertTitle>
          <AlertDescription className="break-words">{repo.error}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

function TruncatedNotice({ repos }: { repos: RepoDiff[] }) {
  return (
    <Alert>
      <SquareTerminal />
      <AlertTitle>Part of this diff isn't shown</AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-1.5">
        <span>It is too large to show in full here. See all of it in a terminal:</span>
        {repos.map((repo) => (
          <CommandLine key={repo.folder} command={repo.command} />
        ))}
      </AlertDescription>
    </Alert>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex w-full min-w-0 items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-2">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap text-foreground">
        {command}
      </code>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn("shrink-0 text-muted-foreground max-md:size-9", className)}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          (err) => toast.error("Couldn't copy", { description: errorMessage(err) }),
        );
      }}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}

function ToolButton({
  label,
  pressed,
  className,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pressed}
          className={cn("text-muted-foreground max-md:size-11 aria-pressed:bg-accent aria-pressed:text-foreground", className)}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function RefreshButton({ onClick, loading, label = "Refresh" }: { onClick: () => void; loading: boolean; label?: string }) {
  return (
    <Button variant="outline" size="sm" className="max-md:h-11" disabled={loading} onClick={onClick}>
      <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} />
      {label}
    </Button>
  );
}

function StateMessage({
  icon: Icon,
  title,
  detail,
  action,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  action: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <Icon className={cn("size-5", tone === "error" ? "text-destructive" : "text-muted-foreground")} />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-pretty break-words text-muted-foreground">{detail}</p>
      <div className="mt-1">{action}</div>
    </div>
  );
}

function ChangesSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 py-3" aria-busy="true" aria-label="Loading changes">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-4 w-40" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ))}
    </div>
  );
}

const STATUS: Record<DiffFileStatus, { label: string; className: string }> = {
  A: { label: "Added", className: "text-success" },
  M: { label: "Modified", className: "text-amber-600 dark:text-amber-400" },
  D: { label: "Deleted", className: "text-destructive" },
  R: { label: "Renamed", className: "text-sky-600 dark:text-sky-400" },
};

function StatusLetter({ file }: { file: DiffFile }) {
  const { label, className } = STATUS[file.status];
  const full = file.untracked ? `${label} (not committed or staged yet)` : label;
  return (
    <span
      title={full}
      aria-label={full}
      className={cn("inline-flex w-3.5 shrink-0 justify-center font-mono text-[11px] font-semibold", className)}
    >
      {file.status}
    </span>
  );
}

function Counts({ additions, deletions, compact }: { additions: number; deletions: number; compact?: boolean }) {
  return (
    <span className={cn("inline-flex shrink-0 gap-1.5 font-mono tabular-nums", compact ? "text-[11px]" : "text-xs")}>
      <span className="text-success">+{additions}</span>
      <span className="text-destructive">−{deletions}</span>
    </span>
  );
}

/** "lib/server/" muted, "git-diff.ts" emphasised; the start is cut first when narrow. */
function PathLabel({ path, className }: { path: string; className?: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <span className={cn("flex min-w-0 font-mono", className)}>
      <span className="truncate text-muted-foreground [direction:rtl]">
        <bdi>{path.slice(0, slash + 1)}</bdi>
      </span>
      <span className="shrink-0 truncate">{path.slice(slash + 1)}</span>
    </span>
  );
}

interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "note";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Unified diff hunks → lines with old/new line numbers. */
function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw, oldNo: null, newNo: null });
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith("\\")) {
      lines.push({ kind: "note", text: raw.slice(2), oldNo: null, newNo: null });
    } else {
      lines.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return lines;
}

/** Side-by-side rows: context on both sides, a removed run paired with the added run after it. */
type SplitRow = { full: DiffLine } | { left: DiffLine | null; right: DiffLine | null };

function pairLines(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "del") {
      if (added.length > 0) flush();
      removed.push(line);
    } else if (line.kind === "add") {
      added.push(line);
    } else {
      flush();
      rows.push(line.kind === "ctx" ? { left: line, right: line } : { full: line });
    }
  }
  flush();
  return rows;
}

const LINE_TONE: Record<DiffLine["kind"], { row: string; gutter: string; sign: string }> = {
  add: { row: "bg-success/10", gutter: "bg-success/15 text-success", sign: "+" },
  del: { row: "bg-destructive/10", gutter: "bg-destructive/15 text-destructive", sign: "−" },
  ctx: { row: "", gutter: "text-muted-foreground/70", sign: " " },
  hunk: { row: "bg-muted/60 text-muted-foreground", gutter: "", sign: "" },
  note: { row: "text-muted-foreground italic", gutter: "", sign: "" },
};

const FileDiffView = memo(function FileDiffView({
  entryKey,
  file,
  lines,
  open,
  current,
  split,
  wrap,
  onToggle,
  register,
}: {
  entryKey: string;
  file: DiffFile;
  lines: number;
  open: boolean;
  current: boolean;
  split: boolean;
  wrap: boolean;
  onToggle: (key: string, open: boolean) => void;
  register: (key: string, node: HTMLElement | null) => void;
}) {
  const bodyId = `diff-${entryKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <section
      ref={(node) => register(entryKey, node)}
      aria-label={file.path}
      className={cn("scroll-mt-14 rounded-lg border", current && "ring-1 ring-ring/50")}
    >
      <div
        className={cn(
          "sticky z-[5] flex items-center gap-1.5 rounded-t-lg border-b bg-card py-1 pr-1 pl-1.5",
          STICKY_TOP,
          !open && "rounded-b-lg border-b-0",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onToggle(entryKey, !open)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 text-left text-xs md:min-h-7"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <StatusLetter file={file} />
          {file.oldPath && (
            <>
              <PathLabel path={file.oldPath} className="max-w-[40%] text-muted-foreground" />
              <span className="shrink-0 text-muted-foreground">→</span>
            </>
          )}
          <PathLabel path={file.path} className="min-w-0" />
          {!open && lines > LARGE_FILE_LINES && (
            <span className="shrink-0 text-muted-foreground">· {lines} lines</span>
          )}
        </button>
        <Counts additions={file.additions} deletions={file.deletions} />
        <CopyButton text={file.path} label="Copy path" />
      </div>
      {open && (
        <div id={bodyId}>
          <FileBody file={file} split={split} wrap={wrap} />
        </div>
      )}
    </section>
  );
});

function FileBody({ file, split, wrap }: { file: DiffFile; split: boolean; wrap: boolean }) {
  const parsed = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const rows = useMemo(() => (split ? pairLines(parsed) : null), [parsed, split]);
  if (file.binary) return <BodyNote>Binary file — not shown.</BodyNote>;
  if (file.patch === null) {
    return (
      <BodyNote>
        {file.truncated
          ? file.untracked
            ? "Large new file — not shown."
            : "This file's diff is too large to show here. See the terminal command above."
          : file.status === "D"
            ? "Empty file deleted."
            : "No content changes (file mode only)."}
      </BodyNote>
    );
  }
  if (file.patch === "") return <BodyNote>Empty file.</BodyNote>;

  const maxNo = parsed.reduce((max, line) => Math.max(max, line.oldNo ?? 0, line.newNo ?? 0), 0);
  const style = { "--ln": `${String(maxNo).length + 2}ch` } as React.CSSProperties;
  const textClass = wrap || split ? "whitespace-pre-wrap break-all" : "whitespace-pre";
  return (
    <>
      <div className={cn("rounded-b-lg font-mono text-xs leading-5", !wrap && !split && "overflow-x-auto")} style={style}>
        {rows ? (
          <div role="table" aria-label="Side-by-side diff" className="w-full">
            {rows.map((row, index) =>
              "full" in row ? (
                <div key={index} role="row" className={cn("px-2", LINE_TONE[row.full.kind].row)}>
                  {row.full.text}
                </div>
              ) : (
                <div
                  key={index}
                  role="row"
                  className="grid grid-cols-[var(--ln)_minmax(0,1fr)_var(--ln)_minmax(0,1fr)]"
                >
                  <SplitCell line={row.left} textClass={textClass} side="old" />
                  <SplitCell line={row.right} textClass={textClass} side="new" />
                </div>
              ),
            )}
          </div>
        ) : (
          <div role="table" aria-label="Diff" className={cn(wrap ? "w-full" : "w-max min-w-full")}>
            {parsed.map((line, index) => {
              const tone = LINE_TONE[line.kind];
              if (line.kind === "hunk" || line.kind === "note") {
                return (
                  <div key={index} role="row" className={cn("px-2", tone.row, textClass)}>
                    {line.text}
                  </div>
                );
              }
              return (
                <div key={index} role="row" className={cn("grid grid-cols-[var(--ln)_var(--ln)_minmax(0,1fr)]", tone.row)}>
                  <span className={cn("pr-1.5 text-right select-none", tone.gutter)}>{line.oldNo ?? ""}</span>
                  <span className={cn("pr-1.5 text-right select-none", tone.gutter)}>{line.newNo ?? ""}</span>
                  <span className={cn("pr-4 pl-1", textClass)}>
                    <span className={cn("inline-block w-3 select-none", tone.gutter, "bg-transparent")}>{tone.sign}</span>
                    {line.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {file.truncated && (
        <BodyNote>Diff cut short — it is too large to show in full. See the terminal command above.</BodyNote>
      )}
    </>
  );
}

function SplitCell({ line, textClass, side }: { line: DiffLine | null; textClass: string; side: "old" | "new" }) {
  if (!line) return <span className="col-span-2 bg-muted/40" />;
  const tone = LINE_TONE[line.kind];
  const no = side === "old" ? line.oldNo : line.newNo;
  return (
    <>
      <span className={cn("pr-1.5 text-right select-none", tone.gutter, side === "new" && "border-l")}>{no ?? ""}</span>
      <span className={cn("pr-2 pl-1", tone.row, textClass)}>
        <span className="inline-block w-3 text-muted-foreground select-none">{tone.sign}</span>
        {line.text}
      </span>
    </>
  );
}

function BodyNote({ children }: { children: React.ReactNode }) {
  return <p className="rounded-b-lg px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}
