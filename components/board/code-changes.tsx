"use client";

/**
 * The diff toolkit of the card's Review tab: loading the task diff and its summary, the view
 * preferences, one file's diff body (unified or side by side) and the small pieces around it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, RefreshCw, SquareTerminal, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/components/board/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import type { AgentState } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Re-read the diff this often while the card's agent works and the tab is shown. */
const POLL_MS = 15_000;
/** Summary requests per diff while the summary agent writes (each waits on the server). */
const SUMMARY_ATTEMPTS = 8;
const SUMMARY_RETRY_MS = 2000;
const PREFS_KEY = "omp-ui:diff-view";

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

export interface DiffEntry {
  /** `${repo.folder}\0${file.path}`: unique across the diff's repos. */
  key: string;
  repo: RepoDiff;
  file: DiffFile;
  /** Lines in the file's patch (0 without one). */
  lines: number;
}

/** Every changed file of `diff`, repo by repo, in the diff's order. */
export function diffEntries(diff: TaskDiff | null): DiffEntry[] {
  return (diff?.repos ?? []).flatMap((repo) =>
    repo.files.map((file) => ({
      key: `${repo.folder}\0${file.path}`,
      repo,
      file,
      lines: file.patch ? file.patch.split("\n").length : 0,
    })),
  );
}

export interface DiffViewPrefs {
  split: boolean;
  wrap: boolean;
}

/** How diffs are shown, kept in localStorage "omp-ui:diff-view"; defaults to side by side, no wrap. */
export function useDiffViewPrefs(): [DiffViewPrefs, (patch: Partial<DiffViewPrefs>) => void] {
  const [prefs, setPrefs] = useState<DiffViewPrefs>({ split: true, wrap: false });
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<DiffViewPrefs>;
      setPrefs({ split: saved.split !== false, wrap: saved.wrap === true });
    } catch {
      // Defaults.
    }
  }, []);
  const updatePrefs = useCallback((patch: Partial<DiffViewPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [prefs, updatePrefs];
}

export interface DiffSummaryState {
  summary: DiffSummary | null;
  error: string | null;
  regenerate: () => void;
}

/**
 * The summary of `diff`, fetched while `enabled` (tab shown, agent idle). The server answers the
 * fallback with `pending` while its summary agent writes; ask again until it is done.
 */
export function useDiffSummary(taskId: string, diff: TaskDiff | null, enabled: boolean): DiffSummaryState {
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

export function SummaryBar({ diff, summary, active }: { diff: TaskDiff; summary: DiffSummaryState; active: boolean }) {
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
export function BaseNote({ repo }: { repo: RepoDiff }) {
  if (!repo.baseRef) return <span>uncommitted changes{repo.branch ? ` on ${repo.branch}` : ""}</span>;
  return (
    <span className="truncate" title={repo.branch ? `${repo.branch} compared with ${repo.baseRef}` : undefined}>
      vs {repo.baseRef}
      {repo.commitsAhead > 0 && ` · ${repo.commitsAhead} ${repo.commitsAhead === 1 ? "commit" : "commits"}`}
    </span>
  );
}

export function RepoErrors({ repos, className }: { repos: RepoDiff[]; className?: string }) {
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

export function TruncatedNotice({ repos }: { repos: RepoDiff[] }) {
  return (
    <Alert>
      <SquareTerminal />
      <AlertTitle>Part of this diff isn't shown</AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-1.5">
        <span>Too large to show in full. View it in a terminal:</span>
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

export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
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

export function ToolButton({
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

export function RefreshButton({ onClick, loading, label = "Refresh" }: { onClick: () => void; loading: boolean; label?: string }) {
  return (
    <Button variant="outline" size="sm" className="max-md:h-11" disabled={loading} onClick={onClick}>
      <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} />
      {label}
    </Button>
  );
}

export function StateMessage({
  icon: Icon,
  title,
  detail,
  action,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail?: string;
  action?: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <Icon className={cn("size-5", tone === "error" ? "text-destructive" : "text-muted-foreground")} />
      <p className="text-sm font-medium">{title}</p>
      {detail && <p className="max-w-sm text-xs text-pretty break-words text-muted-foreground">{detail}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ChangesSkeleton() {
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
  R: { label: "Renamed", className: "text-primary" },
};

export function StatusLetter({ file }: { file: DiffFile }) {
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

export function Counts({ additions, deletions, compact }: { additions: number; deletions: number; compact?: boolean }) {
  return (
    <span className={cn("inline-flex shrink-0 gap-1.5 font-mono tabular-nums", compact ? "text-[11px]" : "text-xs")}>
      <span className="text-success">+{additions}</span>
      <span className="text-destructive">−{deletions}</span>
    </span>
  );
}

/** "lib/server/" muted, "git-diff.ts" emphasised; the start is cut first when narrow. */
export function PathLabel({ path, className }: { path: string; className?: string }) {
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

/**
 * One file's diff body: hunks table (unified or side by side), or the binary / too-large /
 * mode-only note. No header, no outer frame and no sticky offsets: the caller frames it.
 */
export function FileDiffBody({ file, split, wrap }: { file: DiffFile; split: boolean; wrap: boolean }) {
  const parsed = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const rows = useMemo(() => (split ? pairLines(parsed) : null), [parsed, split]);
  if (file.binary) return <BodyNote>Binary file — not shown.</BodyNote>;
  if (file.patch === null) {
    return (
      <BodyNote>
        {file.truncated
          ? file.untracked
            ? "Large new file — not shown."
            : "Diff too large to show. Use the terminal command above."
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
      <div className={cn("font-mono text-xs leading-5", !wrap && !split && "overflow-x-auto")} style={style}>
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
        <BodyNote>Diff truncated. Use the terminal command above for the full diff.</BodyNote>
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
  return <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}
