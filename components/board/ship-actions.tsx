"use client";

import { type ReactNode, useEffect, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronsUpDown,
  CircleCheck,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Rocket,
  TriangleAlert,
  Undo2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ApiRequestError, api } from "@/lib/api-client";
import type { Comment, GitActionResult, GitBranches, GitDiscardResult, GitStatus, Task } from "@/lib/types";
import { errorMessage } from "@/components/board/format";

/** Last path segment, for compact folder labels. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function changesLabel(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

/**
 * Compact header badge: current branch, plus a change-count chip. Tap the branch to list every
 * repo and switch any of them to another branch; tap the chip to commit and push everything.
 */
export function GitIndicator({
  boardId,
  statuses,
  pushBranch,
  onChanged,
}: {
  boardId: string;
  statuses: GitStatus[] | null;
  /** The project's push branch: where the quick push chip lands every repo's changes. */
  pushBranch: string;
  /** Called after a branch switch or quick push so the board can re-read git status. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<GitStatus | null>(null);
  const repos = statuses?.filter((status) => status.isRepo) ?? [];
  if (repos.length === 0) return null;

  const primary = repos[0];
  const changes = repos.reduce((sum, repo) => sum + (repo.dirty ? repo.changedFiles : 0), 0);
  const unpushed = repos.reduce((sum, repo) => sum + repo.ahead, 0);

  return (
    <div className="flex min-w-0 items-center">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPicking(null);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            className="h-11 max-w-56 min-w-0 gap-1.5 px-2.5 font-normal text-muted-foreground md:h-9"
            aria-label={`Git: ${primary.branch ?? "detached"}`}
          >
            <GitBranch />
            <span className="truncate font-mono text-xs max-sm:hidden">
              {primary.branch ?? "detached"}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1.5rem)] p-0">
          {picking ? (
            <BranchPicker
              boardId={boardId}
              repo={picking}
              onBack={() => setPicking(null)}
              onSwitched={() => {
                setOpen(false);
                setPicking(null);
                onChanged();
              }}
            />
          ) : (
            <>
              <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                Git status{unpushed > 0 ? ` · ${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}` : ""}
              </div>
              <ul className="flex flex-col py-1">
                {repos.map((repo) => (
                  <li key={repo.folder} className="flex flex-col gap-0.5 px-3 py-2">
                    <span className="truncate text-sm font-medium" title={repo.folder}>
                      {folderName(repo.folder)}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => setPicking(repo)}
                        className="-mx-1 inline-flex min-h-8 max-w-full items-center gap-1 rounded-md px-1 font-mono hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-label={`Switch branch in ${folderName(repo.folder)} (on ${repo.branch ?? "detached HEAD"})`}
                      >
                        <GitBranch className="size-3 shrink-0" />
                        <span className="truncate">{repo.branch ?? "detached"}</span>
                        <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
                      </button>
                      <span>{repo.dirty ? changesLabel(repo.changedFiles) : "clean"}</span>
                      {repo.ahead > 0 && <span>{repo.ahead} ahead</span>}
                      {repo.behind > 0 && <span>{repo.behind} behind</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </PopoverContent>
      </Popover>
      {(changes > 0 || unpushed > 0) && (
        <>
          <QuickPushChip
            boardId={boardId}
            repos={repos}
            pushBranch={pushBranch}
            changes={changes}
            unpushed={unpushed}
            onPushed={onChanged}
          />
          {changes > 0 && (
            <DiscardChangesButton
              compact
              discard={() => api.git.discardBoard(boardId)}
              repos={repos}
              onDiscarded={onChanged}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Amber "N changes" chip: one click commits every repo's changes and pushes to the project's push branch. */
function QuickPushChip({
  boardId,
  repos,
  pushBranch,
  changes,
  unpushed,
  onPushed,
}: {
  boardId: string;
  repos: GitStatus[];
  pushBranch: string;
  changes: number;
  unpushed: number;
  onPushed: () => void;
}) {
  const [pushing, setPushing] = useState(false);
  const { pushTarget } = shipLabels(repos, pushBranch);
  const noRemote = !canShip(repos);
  const count = changes > 0 ? changes : unpushed;
  const noun = changes > 0 ? (changes === 1 ? "change" : "changes") : "unpushed";
  const what = changes > 0 ? changesLabel(changes) : `${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}`;
  const hint = noRemote
    ? `${what} · add a git remote (origin) to push`
    : pushing
      ? `Pushing to ${pushTarget}…`
      : changes > 0
        ? `Commit ${what} and push to ${pushTarget}`
        : `Push ${what} to ${pushTarget}`;

  const push = async () => {
    if (noRemote || pushing) return;
    setPushing(true);
    try {
      const { results } = await api.git.pushBoard(boardId);
      const failed = results.filter((r) => r.error);
      const done = results.filter((r) => !r.error && !r.skipped);
      if (done.length === 0 && failed.length === 0) {
        toast("Nothing to push", { description: "No uncommitted or unpushed changes were found." });
      } else if (done.length === 0) {
        toast.error("Couldn't push", { description: failed[0]?.error ?? undefined });
      } else if (failed.length > 0) {
        toast.warning("Pushed some folders", {
          description: failed.map((r) => `${folderName(r.folder)}: ${r.error}`).join("\n"),
        });
      } else {
        const link = done.length === 1 ? done[0].url : null;
        toast.success(`Pushed to ${pushTarget}`, {
          action: link
            ? { label: done[0].commit ? "View commit" : "Open", onClick: () => window.open(link, "_blank", "noopener") }
            : undefined,
        });
      }
    } catch (err) {
      toast.error("Couldn't push", {
        description:
          err instanceof ApiRequestError && err.status === 409
            ? "An agent is working in this project. Try again when it finishes."
            : errorMessage(err),
      });
    } finally {
      setPushing(false);
      onPushed();
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void push()}
          aria-disabled={noRemote || pushing || undefined}
          aria-busy={pushing || undefined}
          aria-label={hint}
          className="group -ml-1.5 flex h-11 shrink-0 items-center rounded-md px-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:cursor-default md:h-9"
        >
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 text-[11px] leading-5 font-medium text-amber-700 tabular-nums transition-[background-color,transform] dark:text-amber-300",
              !noRemote &&
                !pushing &&
                "group-hover:bg-amber-500/30 group-active:scale-[0.96] motion-reduce:group-active:scale-100",
            )}
          >
            {pushing ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              !noRemote && <ArrowUp className="size-3" />
            )}
            {count}
            <span className="max-sm:hidden">{noun}</span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * "Discard all changes" control: a destructive action with a per-repo confirmation. Discards
 * uncommitted changes (tracked, staged and untracked) in the repos it is given — the header shows
 * it as a small icon button, the Ship panel as a labelled button.
 */
export function DiscardChangesButton({
  discard,
  repos,
  disabled = false,
  onDiscarded,
  compact = false,
}: {
  /** Runs the discard request for the button's scope and resolves its result (null on request failure). */
  discard: () => Promise<GitDiscardResult>;
  /** Repos the discard acts on (their uncommitted change counts drive the confirmation). */
  repos: GitStatus[];
  disabled?: boolean;
  onDiscarded: () => void;
  /** Small icon button (header) instead of a labelled button (Ship panel). */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const changed = repos.filter((repo) => repo.isRepo && repo.dirty);
  const changedFiles = changed.reduce((sum, repo) => sum + repo.changedFiles, 0);
  if (changed.length === 0) return null;

  const run = async () => {
    setBusy(true);
    try {
      const outcome = await discard();
      if (outcome) {
        const failed = outcome.results.filter((r) => r.error);
        const done = outcome.results.filter((r) => !r.error && r.discardedFiles > 0);
        if (done.length === 0 && failed.length === 0) {
          toast("Nothing to discard", { description: "No uncommitted changes were found." });
        } else if (done.length === 0) {
          toast.error("Couldn't discard changes", { description: failed[0]?.error ?? undefined });
        } else if (failed.length > 0) {
          toast.warning("Discarded some folders", {
            description: failed.map((r) => `${folderName(r.folder)}: ${r.error}`).join("\n"),
          });
        } else {
          const files = done.reduce((sum, r) => sum + r.discardedFiles, 0);
          toast.success("Changes discarded", {
            description: `${files} ${files === 1 ? "file" : "files"} reset in ${done.length === 1 ? folderName(done[0].folder) : `${done.length} folders`}.`,
          });
        }
      }
      onDiscarded();
    } catch (err) {
      toast.error("Couldn't discard changes", {
        description:
          err instanceof ApiRequestError && err.status === 409
            ? "An agent is working in this project. Try again when it finishes."
            : errorMessage(err),
      });
      onDiscarded();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setOpen(true)}
              disabled={disabled}
              aria-disabled={disabled || undefined}
              aria-label={`Discard all changes (${changesLabel(changedFiles)})`}
              className="-ml-1 flex h-11 shrink-0 items-center rounded-md px-1 text-muted-foreground outline-none hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50 md:h-9"
            >
              <Undo2 className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Discard all changes</TooltipContent>
        </Tooltip>
      ) : (
        <Button
          variant="outline"
          className="h-11 w-full min-w-0 transition-transform active:scale-[0.98] md:h-9"
          disabled={disabled || busy}
          onClick={() => setOpen(true)}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <Undo2 />}
          <span className="truncate">{busy ? "Discarding…" : "Discard all changes"}</span>
        </Button>
      )}

      <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard all changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {changed.length === 1
                ? `${changesLabel(changed[0].changedFiles)} in ${folderName(changed[0].folder)}/ will be discarded: tracked edits are reset and new untracked files are deleted. This cannot be undone.`
                : `${changesLabel(changedFiles)} across ${changed.length} folders will be discarded: tracked edits are reset and new untracked files are deleted. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:h-11" disabled={busy}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="max-md:h-11"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              {busy ? "Discarding…" : "Discard changes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Filterable branch list for one repo; tapping a branch checks it out. */
function BranchPicker({
  boardId,
  repo,
  onBack,
  onSwitched,
}: {
  boardId: string;
  repo: GitStatus;
  onBack: () => void;
  onSwitched: () => void;
}) {
  const [list, setList] = useState<GitBranches | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.git.branches(boardId, repo.folder).then(
      (result) => !cancelled && setList(result),
      (err) => !cancelled && setLoadError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [boardId, repo.folder]);

  const switchTo = async (branch: string) => {
    setSwitching(branch);
    try {
      const result = await api.git.switchBranch(boardId, { folder: repo.folder, branch });
      const title = `Switched ${folderName(repo.folder)} to ${branch}`;
      if (result.pullError) {
        toast.warning(title, { description: `Couldn't pull the latest changes: ${result.pullError}` });
      } else {
        toast.success(title, {
          description:
            result.pulled > 0 ? `Pulled ${result.pulled} new ${result.pulled === 1 ? "commit" : "commits"}.` : undefined,
        });
      }
      onSwitched();
    } catch (err) {
      toast.error("Couldn't switch branch", {
        description:
          err instanceof ApiRequestError && err.status === 409
            ? "An agent is working in this project. Try again when it finishes."
            : errorMessage(err),
      });
      setSwitching(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = list?.branches.filter((b) => b.name.toLowerCase().includes(needle)) ?? [];

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 border-b px-1 py-1">
        <Button variant="ghost" size="icon" className="size-11 md:size-8" onClick={onBack} aria-label="Back to git status">
          <ChevronLeft />
        </Button>
        <span className="truncate text-xs font-medium text-muted-foreground" title={repo.folder}>
          Switch branch · {folderName(repo.folder)}
        </span>
      </div>
      <div className="border-b p-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter branches"
          aria-label="Filter branches"
          className="h-11 md:h-8"
        />
      </div>
      {repo.dirty && (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          {changesLabel(repo.changedFiles)} will come along to the new branch.
        </p>
      )}
      {loadError ? (
        <p className="px-3 py-3 text-sm text-destructive">{loadError}</p>
      ) : !list ? (
        <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Loading branches…
        </p>
      ) : shown.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">No matching branches.</p>
      ) : (
        <ul className="flex max-h-72 flex-col overflow-y-auto py-1">
          {shown.map((branch) => {
            const current = branch.name === list.current;
            return (
              <li key={`${branch.remoteOnly ? "origin/" : ""}${branch.name}`}>
                <button
                  type="button"
                  disabled={switching !== null || current}
                  onClick={() => void switchTo(branch.name)}
                  aria-current={current || undefined}
                  className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent md:min-h-8"
                >
                  {switching === branch.name ? (
                    <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <Check className={cn("size-3.5 shrink-0", !current && "invisible")} />
                  )}
                  <span className={cn("truncate font-mono text-xs", current && "font-semibold")}>{branch.name}</span>
                  {branch.remoteOnly && (
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
                      origin
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export type ShipAction = "pr" | "push" | "push-current";

/** User-facing names for a set of repos: "PR" vs GitLab's "MR", and the project's push branch a push lands on. */
export function shipLabels(statuses: GitStatus[], pushBranch: string): { prNoun: string; pushTarget: string } {
  const repos = statuses.filter((status) => status.isRepo);
  return {
    prNoun: repos[0]?.provider === "gitlab" ? "MR" : "PR",
    pushTarget: pushBranch,
  };
}

/** True when at least one folder is a git repo with a remote, so Push / Create PR can work. */
export function canShip(statuses: GitStatus[] | null): boolean {
  return statuses?.some((status) => status.isRepo && status.remoteUrl) ?? false;
}

/**
 * Runs Create PR / Push to main / Push to current branch for a card and toasts the outcome.
 * Resolves the server's result, or null when the request itself failed (already toasted).
 */
export async function shipTask(
  action: ShipAction,
  taskId: string,
  { prNoun, pushTarget }: { prNoun: string; pushTarget: string },
): Promise<GitActionResult | null> {
  try {
    const outcome =
      action === "pr"
        ? await api.git.pr(taskId)
        : action === "push-current"
          ? await api.git.pushCurrent(taskId)
          : await api.git.push(taskId);
    const failed = outcome.results.filter((r) => r.error);
    const done = outcome.results.filter((r) => !r.error && !r.skipped);
    const branches = [...new Set(done.flatMap((r) => (r.branch ? [r.branch] : [])))];
    const pushedTo =
      branches.length === 1 ? branches[0] : action === "push-current" ? "the current branch" : pushTarget;
    if (done.length === 0 && failed.length === 0) {
      toast("Nothing to ship", { description: "No uncommitted or unpushed changes were found." });
    } else if (done.length === 0) {
      toast.error(action === "pr" ? `Couldn't create the ${prNoun}` : "Couldn't push", {
        description: failed[0]?.error ?? undefined,
      });
    } else if (failed.length > 0) {
      toast.warning(
        action === "pr" ? `${prNoun} created for some folders` : "Pushed some folders",
        { description: `${failed.length} folder${failed.length === 1 ? "" : "s"} failed — see details.` },
      );
    } else {
      toast.success(action === "pr" ? `${prNoun} created` : `Pushed to ${pushedTo}`);
    }
    return outcome;
  } catch (err) {
    toast.error(action === "pr" ? `Couldn't create the ${prNoun}` : "Couldn't push", {
      description:
        err instanceof ApiRequestError && err.status === 409
          ? "The agent is still working. Try again when it finishes."
          : errorMessage(err),
    });
    return null;
  }
}

/**
 * "Ship" panel on a card: open a PR/MR, push straight to the project's push branch, or push to the
 * branch each repo is already on. Acts on every project folder; "Create PR" ships only this card's
 * changes, on top of the default branch. Results link out per folder.
 */
export function ShipActions({
  task,
  statuses,
  pushBranch,
  onShipped,
  onDiscarded,
}: {
  task: Task;
  statuses: GitStatus[] | null;
  /** The project's push branch: where "Push to …" lands the card's changes. */
  pushBranch: string;
  /** Called after an action finishes, with the agent comment the server posted. */
  onShipped: (comment: Comment) => void;
  /** Called after the discard-changes action finishes so the card re-reads git status. */
  onDiscarded: () => void;
}) {
  const [busy, setBusy] = useState<ShipAction | null>(null);
  const [result, setResult] = useState<GitActionResult | null>(null);

  const repos = statuses?.filter((status) => status.isRepo) ?? [];
  const { prNoun, pushTarget } = shipLabels(repos, pushBranch);
  const agentActive = task.agentState === "running" || task.agentState === "queued";
  const noRemote = !canShip(repos);
  /** A folder on a detached HEAD has no branch to push to; the button needs at least one that has. */
  const hasCurrentBranch = repos.some((repo) => repo.branch !== null);
  // Without gh/glab the server pushes the branch and returns a pre-filled compare / new-MR page.
  const prOpensBrowser = !noRemote && !repos.some((repo) => repo.remoteUrl && repo.prCliAvailable);

  if (statuses === null) {
    return (
      <ShipFrame>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Checking the project&apos;s git status…
        </p>
      </ShipFrame>
    );
  }

  if (repos.length === 0) {
    return (
      <ShipFrame>
        <p className="text-sm text-muted-foreground">
          This project&apos;s folders aren&apos;t git repositories; nothing to ship.
        </p>
      </ShipFrame>
    );
  }

  const run = async (action: ShipAction) => {
    setBusy(action);
    const outcome = await shipTask(action, task.id, { prNoun, pushTarget });
    if (outcome) {
      setResult(outcome);
      onShipped(outcome.comment);
    }
    setBusy(null);
  };

  const hint = agentActive
    ? "Wait for the agent to finish before shipping."
    : noRemote
      ? "Add a git remote (origin) to push or open a pull request."
      : `Create ${prNoun} opens a branch off the default branch with only this card's changes${prOpensBrowser ? " and a pre-filled page in your browser" : ""}; your checked-out branch stays as it is. The push buttons commit everything in ${repos.length > 1 ? `the ${repos.length} folders` : "the folder"}.`;
  const changedFiles = repos.reduce((sum, repo) => sum + (repo.dirty ? repo.changedFiles : 0), 0);
  const unpushed = repos.reduce((sum, repo) => sum + repo.ahead, 0);
  const summary = [
    changedFiles > 0 && changesLabel(changedFiles),
    unpushed > 0 && `${unpushed} unpushed`,
  ].filter(Boolean);

  return (
    <ShipFrame
      aside={
        summary.length > 0 ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
            {summary.join(" · ")}
          </span>
        ) : null
      }
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {task.pullRequests.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-2 sm:col-span-2">
            {task.pullRequests.map((pr) => (
              <Button key={pr.folder} asChild className="h-11 w-full min-w-0 md:h-9">
                <a href={pr.url} target="_blank" rel="noopener noreferrer" title={pr.url}>
                  <GitPullRequest />
                  <span className="truncate">
                    {task.pullRequests.length > 1 ? `Open ${prNoun} · ${folderName(pr.folder)}` : `Open ${prNoun}`}
                  </span>
                  <ExternalLink className="ml-auto" />
                </a>
              </Button>
            ))}
          </div>
        ) : (
          <Button
            className="h-11 w-full min-w-0 transition-transform active:scale-[0.98] sm:col-span-2 md:h-9"
            disabled={agentActive || busy !== null || noRemote}
            onClick={() => void run("pr")}
          >
            {busy === "pr" ? <LoaderCircle className="animate-spin" /> : <GitPullRequest />}
            <span className="truncate">{busy === "pr" ? `Creating ${prNoun}…` : `Create ${prNoun}`}</span>
          </Button>
        )}
        <Button
          variant="outline"
          className="h-11 w-full min-w-0 transition-transform active:scale-[0.98] md:h-9"
          disabled={agentActive || busy !== null || noRemote}
          onClick={() => void run("push")}
        >
          {busy === "push" ? <LoaderCircle className="animate-spin" /> : <Upload />}
          <span className="truncate">{busy === "push" ? "Pushing…" : `Push to ${pushTarget}`}</span>
        </Button>
        <Button
          variant="outline"
          className="h-11 w-full min-w-0 transition-transform active:scale-[0.98] md:h-9"
          disabled={agentActive || busy !== null || noRemote || !hasCurrentBranch}
          onClick={() => void run("push-current")}
          title="Commit the changes and push them to the branch each repo is already on"
        >
          {busy === "push-current" ? <LoaderCircle className="animate-spin" /> : <GitBranch />}
          <span className="truncate">
            {busy === "push-current" ? "Pushing…" : "Push to current branch"}
          </span>
        </Button>
      </div>
      {changedFiles > 0 && (
        <DiscardChangesButton
          discard={() => api.git.discard(task.id)}
          repos={repos}
          disabled={agentActive || busy !== null}
          onDiscarded={onDiscarded}
        />
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>

      {result && <ShipResults result={result} prNoun={prNoun} linked={task.pullRequests.map((pr) => pr.url)} />}
    </ShipFrame>
  );
}

function ShipFrame({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <section
      aria-label="Ship changes"
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3 shadow-xs md:p-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
          <Rocket className="size-4 text-muted-foreground" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">Ship changes</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ShipResults({ result, prNoun, linked }: { result: GitActionResult; prNoun: string; linked: string[] }) {
  const multiple = result.results.length > 1;
  return (
    <ul className="flex flex-col gap-2 border-t pt-2.5">
      {result.results.map((entry) => (
        <li key={entry.folder} className="flex flex-col gap-1.5 text-sm">
          <div className="flex items-start gap-2">
            {entry.error ? (
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <CircleCheck
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  entry.skipped ? "text-muted-foreground" : "text-emerald-600 dark:text-emerald-400",
                )}
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="break-words">
                {multiple && <span className="font-medium">{folderName(entry.folder)}: </span>}
                {entry.error
                  ? "Failed"
                  : entry.skipped
                    ? "Nothing to ship"
                    : result.action === "pr"
                      ? `${prNoun} opened${entry.branch ? ` from ${entry.branch}` : ""}`
                      : `Pushed${entry.branch ? ` to ${entry.branch}` : ""}${entry.commit ? ` (${entry.commit.slice(0, 7)})` : ""}`}
              </p>
              {entry.error && (
                <p className="mt-1 rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-destructive break-words dark:bg-destructive/20">
                  {entry.error}
                </p>
              )}
            </div>
          </div>
          {entry.url && !entry.error && !linked.includes(entry.url) && (
            <Button asChild variant="outline" className="h-11 w-full sm:w-auto sm:self-start md:h-8">
              <a href={entry.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                {result.action === "pr" ? `Open ${prNoun}` : entry.commit ? "View commit" : "Open repository"}
              </a>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
