// Shared handler for the task "Push to main" / "Create PR" buttons.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { publish } from "@/lib/events";
import { createPullRequest, isGitRepo, pushToDefault, type GitFolderOutcome } from "@/lib/git";
import { HttpError, json, readJson, type ApiContext } from "@/lib/server/http";
import { requireBoard, requireTask } from "@/lib/server/validate";
import type { GitActionResult, Task } from "@/lib/types";
import { shipFolders } from "@/lib/workspaces";

const MAX_PR_BODY = 60_000;

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`);
  return trimmed || null;
}

function branchNameFor(task: Task): string {
  const slug =
    task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task";
  return `omp/${slug}-${randomBytes(3).toString("hex")}`;
}

async function defaultPrBody(ctx: ApiContext<{ id: string }>, task: Task): Promise<string> {
  const runs = await ctx.repo.listRuns(task.id);
  const summary = runs.find((r) => r.status === "succeeded" && r.summary?.trim())?.summary?.trim();
  const parts = [task.description.trim(), summary ? `## Agent summary\n\n${summary}` : ""].filter(Boolean);
  parts.push("---\nCreated from OMP UI");
  const body = parts.join("\n\n");
  return body.length > MAX_PR_BODY ? `${body.slice(0, MAX_PR_BODY - 1)}…` : body;
}

/**
 * Push (to each repo's default branch) or open PR/MRs for the task's project folders, one folder
 * at a time, then post one resolved agent comment summarising what happened.
 */
export async function runTaskGitAction(
  ctx: ApiContext<{ id: string }>,
  action: "push" | "pr",
): Promise<Response> {
  const { req, repo, params } = ctx;
  const task = await requireTask(repo, params.id);
  if (task.agentState === "queued" || task.agentState === "running") {
    throw new HttpError(409, "Wait for the agent to finish first.");
  }
  const board = await requireBoard(repo, task.boardId);
  // A card with a dedicated workspace ships from its own worktrees.
  const projectFolders = await shipFolders(board, task);
  const body = await readJson(req);

  let folders = projectFolders;
  if (body.folders !== undefined) {
    if (!Array.isArray(body.folders) || body.folders.some((f) => typeof f !== "string")) {
      throw new HttpError(400, "folders must be a list of folder paths.");
    }
    const requested = [...new Set((body.folders as string[]).map((f) => path.resolve(f.trim())))];
    const unknown = requested.find((f) => !projectFolders.includes(f));
    if (unknown) throw new HttpError(400, `This folder is not part of the project: ${unknown}`);
    folders = requested;
  }
  if (folders.length === 0) throw new HttpError(400, "Choose at least one folder.");

  const repoFlags = await Promise.all(folders.map(isGitRepo));
  if (!repoFlags.some(Boolean)) {
    throw new HttpError(
      400,
      folders.length === 1
        ? "This project folder is not a git repository, so there is nothing to push."
        : "None of the project folders is a git repository, so there is nothing to push.",
    );
  }

  let run: (folder: string) => Promise<GitFolderOutcome>;
  if (action === "push") {
    const message = optionalText(body.message, "message", 5000) ?? task.title;
    run = (folder) => pushToDefault(folder, message);
  } else {
    const title = optionalText(body.title, "title", 200) ?? task.title;
    const prBody = optionalText(body.body, "body", MAX_PR_BODY) ?? (await defaultPrBody(ctx, task));
    const branchName = branchNameFor(task);
    run = (folder) => createPullRequest(folder, { title, body: prBody, branchName });
  }

  const outcomes: GitFolderOutcome[] = [];
  for (const folder of folders) {
    try {
      outcomes.push(await run(folder));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcomes.push({
        result: { folder, branch: null, commit: null, url: null, output: "", error, skipped: false },
        summary: `Something went wrong in ${path.basename(folder)}/: ${error}`,
      });
    }
  }

  const results = outcomes.map((o) => o.result);
  const heading = action === "push" ? "**Push to main**" : "**Create PR**";
  const lines = results.every((r) => r.skipped)
    ? [action === "push" ? "Nothing to push — there are no changes." : "Nothing to put in a pull request — there are no changes."]
    : outcomes.filter((_, i) => repoFlags[i]).map((o) => `- ${o.summary}`);
  const comment = await repo.addComment({
    taskId: task.id,
    author: "agent",
    body: `${heading}\n\n${lines.join("\n")}`,
    resolved: true,
  });
  publish({ type: "comment.added", comment, boardId: task.boardId });
  const fresh = await repo.getTask(task.id);
  if (fresh) publish({ type: "task.updated", task: fresh });

  const response: GitActionResult = { action, results, comment };
  return json(response);
}
