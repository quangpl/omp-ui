// Server-side data for the Artifacts page (GET /api/v1/artifacts[/:boardId]): each card's final
// result (its latest succeeded run with a summary) and the card's shared files that summary links.
// Other files in the card's folder are work in progress (screenshots, notes) and never listed.
import fs from "node:fs/promises";
import type { Repository } from "@/lib/db/types";
import { resolveFile } from "@/lib/files";
import { inlineSources, parseBlocks } from "@/lib/markdown/blocks";
import { type MdInline, parseInline } from "@/lib/markdown/inline";
import { HttpError } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";
import type {
  ArtifactFile,
  ArtifactPeriod,
  ArtifactProject,
  ArtifactProjectResults,
  ArtifactResult,
  Run,
  Task,
} from "@/lib/types";

type FinalRun = Run & { summary: string; endedAt: string };

interface FileRef {
  name: string;
  url: string;
  /** Absolute path inside the card's files folder. */
  path: string;
}

interface CardResult {
  task: Task;
  run: FinalRun;
  refs: FileRef[];
  endedMs: number;
}

/** `[from, to)` in epoch ms; a missing bound is unbounded. */
interface Bounds {
  from: number;
  to: number;
}

const FILES_PATH = /^\/api\/v1\/tasks\/([A-Za-z0-9_-]+)\/files\/([\s\S]+)$/;

/** `from`/`to` query parameters (empty = unset); anything `Date.parse` rejects is 400. */
export function parseArtifactPeriod(params: URLSearchParams): ArtifactPeriod {
  const period: ArtifactPeriod = {};
  for (const key of ["from", "to"] as const) {
    const value = params.get(key)?.trim();
    if (!value) continue;
    if (Number.isNaN(Date.parse(value))) throw new HttpError(400, `${key} must be an ISO date`);
    period[key] = value;
  }
  return period;
}

function toBounds(period: ArtifactPeriod): Bounds {
  return {
    from: period.from ? Date.parse(period.from) : Number.NEGATIVE_INFINITY,
    to: period.to ? Date.parse(period.to) : Number.POSITIVE_INFINITY,
  };
}

function isFinal(run: Run | null): run is FinalRun {
  return !!run && run.status === "succeeded" && !!run.summary?.trim() && !!run.endedAt;
}

/** The card's latest succeeded run with a summary; the last run is usually it, so try that first. */
async function finalRun(repo: Repository, task: Task): Promise<FinalRun | null> {
  if (task.lastRunId) {
    const last = await repo.getRun(task.lastRunId);
    if (isFinal(last)) return last;
  }
  return (await repo.listRuns(task.id)).find(isFinal) ?? null;
}

/** Link, image and bare-path targets outside code, in document order (same walk as the rich-text renderer). */
function collectUrls(nodes: MdInline[], into: string[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "strong":
      case "em":
      case "strike":
        collectUrls(node.children, into);
        break;
      case "link":
        into.push(node.url);
        collectUrls(node.children, into);
        break;
      case "image":
      case "url":
        into.push(node.url);
        break;
      default:
        break;
    }
  }
}

/** `url` as a file of this card's folder, or null (another card's file, not a file URL, or an escaping path). */
function ownFileRef(taskId: string, url: string): FileRef | null {
  const match = FILES_PATH.exec(url.replace(/[?#][\s\S]*$/, ""));
  if (!match || match[1] !== taskId) return null;
  let parts: string[];
  try {
    parts = match[2]
      .split("/")
      .map(decodeURIComponent)
      .join("/")
      .split("/")
      .filter((p) => p !== "" && p !== ".");
  } catch {
    return null;
  }
  const name = parts.join("/");
  let full: string;
  try {
    full = resolveFile("tasks", taskId, name);
  } catch {
    return null;
  }
  return { name, url: `/api/v1/tasks/${taskId}/files/${parts.map(encodeURIComponent).join("/")}`, path: full };
}

/** The card's files referenced by its final summary, in order of first mention. */
function finalFileRefs(taskId: string, summary: string): FileRef[] {
  const urls: string[] = [];
  for (const source of inlineSources(parseBlocks(summary))) collectUrls(parseInline(source), urls);
  const refs = new Map<string, FileRef>();
  for (const url of urls) {
    const ref = ownFileRef(taskId, url);
    if (ref && !refs.has(ref.name)) refs.set(ref.name, ref);
  }
  return [...refs.values()];
}

/** Cards of the board whose final run ended in the period, newest first. */
async function boardResults(repo: Repository, boardId: string, bounds: Bounds): Promise<CardResult[]> {
  const tasks = await repo.listTasks(boardId);
  const found = await Promise.all(
    tasks.map(async (task): Promise<CardResult | null> => {
      const run = await finalRun(repo, task);
      if (!run) return null;
      const endedMs = Date.parse(run.endedAt);
      if (!(endedMs >= bounds.from && endedMs < bounds.to)) return null;
      return { task, run, refs: finalFileRefs(task.id, run.summary), endedMs };
    }),
  );
  return found
    .filter((r): r is CardResult => r !== null)
    .sort((a, b) => b.endedMs - a.endedMs || a.task.id.localeCompare(b.task.id));
}

async function toArtifactFile(ref: FileRef): Promise<ArtifactFile> {
  try {
    const info = await fs.stat(ref.path);
    if (info.isFile()) {
      return { name: ref.name, url: ref.url, size: info.size, modifiedAt: info.mtime.toISOString() };
    }
  } catch {
    // Deleted since the summary was written.
  }
  return { name: ref.name, url: ref.url, size: null, modifiedAt: null };
}

/**
 * Every project with its final-result counts in the period: projects with results first (newest
 * result first), then the rest pinned first, by name.
 */
export async function listArtifactProjects(repo: Repository, period: ArtifactPeriod): Promise<ArtifactProject[]> {
  const bounds = toBounds(period);
  const boards = await repo.listBoards();
  const projects = await Promise.all(
    boards.map(async (board) => {
      const results = await boardResults(repo, board.id, bounds);
      const project: ArtifactProject = {
        boardId: board.id,
        name: board.name,
        workdir: board.workdir,
        pinned: board.pinned,
        resultCount: results.length,
        attachmentCount: results.reduce((sum, r) => sum + r.refs.length, 0),
        latestAt: results[0]?.run.endedAt ?? null,
      };
      return { project, latestMs: results[0]?.endedMs ?? null };
    }),
  );
  projects.sort((a, b) => {
    if (a.latestMs !== null && b.latestMs !== null) {
      return b.latestMs - a.latestMs || a.project.name.localeCompare(b.project.name);
    }
    if (a.latestMs !== null) return -1;
    if (b.latestMs !== null) return 1;
    return Number(b.project.pinned) - Number(a.project.pinned) || a.project.name.localeCompare(b.project.name);
  });
  return projects.map((p) => p.project);
}

/** One project's final results in the period, newest first; 404 for an unknown board. */
export async function artifactProjectResults(
  repo: Repository,
  boardId: string,
  period: ArtifactPeriod,
): Promise<ArtifactProjectResults> {
  const board = await requireBoard(repo, boardId);
  const found = await boardResults(repo, board.id, toBounds(period));
  const results = await Promise.all(
    found.map(
      async ({ task, run, refs }): Promise<ArtifactResult> => ({
        taskId: task.id,
        boardId: board.id,
        title: task.title,
        status: task.status,
        runId: run.id,
        summary: run.summary,
        finishedAt: run.endedAt,
        attachments: await Promise.all(refs.map(toArtifactFile)),
      }),
    ),
  );
  return { board: { id: board.id, name: board.name, workdir: board.workdir }, results };
}
