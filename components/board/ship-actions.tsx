"use client";

import { type ReactNode, useState } from "react";
import {
  CircleCheck,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Rocket,
  TriangleAlert,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ApiRequestError, api } from "@/lib/api-client";
import type { Comment, GitActionResult, GitStatus, Task } from "@/lib/types";
import { errorMessage } from "@/components/board/format";

/** Last path segment, for compact folder labels. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function changesLabel(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

/** Compact header badge: current branch + uncommitted change count; lists every repo on tap. */
export function GitIndicator({ statuses }: { statuses: GitStatus[] | null }) {
  const repos = statuses?.filter((status) => status.isRepo) ?? [];
  if (repos.length === 0) return null;

  const primary = repos[0];
  const changes = repos.reduce((sum, repo) => sum + (repo.dirty ? repo.changedFiles : 0), 0);
  const unpushed = repos.reduce((sum, repo) => sum + repo.ahead, 0);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="h-11 max-w-56 gap-1.5 px-2.5 font-normal text-muted-foreground md:h-9"
          aria-label={`Git: ${primary.branch ?? "detached"}${changes ? `, ${changesLabel(changes)}` : ""}`}
        >
          <GitBranch />
          <span className="truncate font-mono text-xs max-sm:hidden">
            {primary.branch ?? "detached"}
          </span>
          {changes > 0 && (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-700 tabular-nums dark:text-amber-300">
              {changes}
              <span className="max-sm:hidden"> {changes === 1 ? "change" : "changes"}</span>
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-1.5rem)] p-0">
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
                <span className="inline-flex items-center gap-1 font-mono">
                  <GitBranch className="size-3" />
                  {repo.branch ?? "detached"}
                </span>
                <span>{repo.dirty ? changesLabel(repo.changedFiles) : "clean"}</span>
                {repo.ahead > 0 && <span>{repo.ahead} ahead</span>}
                {repo.behind > 0 && <span>{repo.behind} behind</span>}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

type ShipAction = "pr" | "push";

/**
 * "Ship" panel on a card: open a PR/MR or push straight to the default branch.
 * Acts on every project folder with changes; results link out per folder.
 */
export function ShipActions({
  task,
  statuses,
  onShipped,
}: {
  task: Task;
  statuses: GitStatus[] | null;
  /** Called after an action finishes, with the agent comment the server posted. */
  onShipped: (comment: Comment) => void;
}) {
  const [busy, setBusy] = useState<ShipAction | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  const [result, setResult] = useState<GitActionResult | null>(null);

  const repos = statuses?.filter((status) => status.isRepo) ?? [];
  const primary = repos[0];
  const isGitlab = primary?.provider === "gitlab";
  const prNoun = isGitlab ? "MR" : "PR";
  const branches = [...new Set(repos.map((repo) => repo.defaultBranch ?? "main"))];
  const pushTarget = branches.length === 1 ? branches[0] : "the default branch";
  const agentActive = task.agentState === "running" || task.agentState === "queued";
  const hasChanges = repos.some((repo) => repo.dirty || repo.ahead > 0);
  const noRemote = !repos.some((repo) => repo.remoteUrl);
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
          This project&apos;s folders aren&apos;t git repositories, so there is nothing to ship.
        </p>
      </ShipFrame>
    );
  }

  const run = async (action: ShipAction) => {
    setBusy(action);
    try {
      const outcome =
        action === "pr" ? await api.git.pr(task.id) : await api.git.push(task.id);
      setResult(outcome);
      onShipped(outcome.comment);
      const failed = outcome.results.filter((r) => r.error);
      const done = outcome.results.filter((r) => !r.error && !r.skipped);
      if (done.length === 0 && failed.length === 0) {
        toast("Nothing to ship", { description: "No uncommitted or unpushed changes were found." });
      } else if (done.length === 0) {
        toast.error(action === "pr" ? `Couldn't create the ${prNoun}` : "Couldn't push");
      } else if (failed.length > 0) {
        toast.warning(
          action === "pr" ? `${prNoun} created for some folders` : "Pushed some folders",
          { description: `${failed.length} folder${failed.length === 1 ? "" : "s"} failed — see details.` },
        );
      } else {
        toast.success(action === "pr" ? `${prNoun} created` : `Pushed to ${pushTarget}`);
      }
    } catch (err) {
      toast.error(action === "pr" ? `Couldn't create the ${prNoun}` : "Couldn't push", {
        description:
          err instanceof ApiRequestError && err.status === 409
            ? "The agent is still working. Try again when it finishes."
            : errorMessage(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const hint = agentActive
    ? "Wait for the agent to finish before shipping."
    : noRemote
      ? "Add a git remote (origin) to the project to push or open a pull request."
      : !hasChanges
        ? "No uncommitted or unpushed changes right now."
        : prOpensBrowser
          ? "Opens a pre-filled PR page in your browser"
          : `Commits all changes${repos.length > 1 ? ` in ${repos.length} folders` : ""}, then opens a ${prNoun} or pushes to ${pushTarget}.`;

  return (
    <ShipFrame>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          className="h-11 w-full sm:w-auto sm:flex-1 md:h-9"
          disabled={agentActive || busy !== null || noRemote}
          onClick={() => void run("pr")}
        >
          {busy === "pr" ? <LoaderCircle className="animate-spin" /> : <GitPullRequest />}
          {busy === "pr" ? `Creating ${prNoun}…` : `Create ${prNoun}`}
        </Button>
        <Button
          variant="outline"
          className="h-11 w-full sm:w-auto sm:flex-1 md:h-9"
          disabled={agentActive || busy !== null || noRemote}
          onClick={() => setConfirmPush(true)}
        >
          {busy === "push" ? <LoaderCircle className="animate-spin" /> : <Upload />}
          {busy === "push" ? "Pushing…" : `Push to ${pushTarget}`}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>

      {result && <ShipResults result={result} prNoun={prNoun} />}

      <AlertDialog open={confirmPush} onOpenChange={setConfirmPush}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Commit all changes and push directly to {pushTarget}?</AlertDialogTitle>
            <AlertDialogDescription>
              {repos.length > 1
                ? `Applies to every changed folder: ${repos.map((repo) => folderName(repo.folder)).join(", ")}.`
                : "No pull request and no review — the commit lands on the main line right away."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction className="max-md:h-11" onClick={() => void run("push")}>
              Push to {pushTarget}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ShipFrame>
  );
}

function ShipFrame({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Ship changes" className="flex flex-col gap-2.5 rounded-xl border bg-muted/30 p-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Rocket className="size-4" />
        Ship changes
      </h3>
      {children}
    </section>
  );
}

function ShipResults({ result, prNoun }: { result: GitActionResult; prNoun: string }) {
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
          {entry.url && !entry.error && (
            <Button asChild variant="outline" className="h-11 self-start md:h-8">
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
