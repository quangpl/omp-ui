import type { AgentManager } from "@/lib/agent/types";
import { visibleQueue } from "@/lib/dashboard";
import type { Repository } from "@/lib/db/types";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { requireTask } from "@/lib/server/validate";
import type { QueueSnapshot, User } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The manager's queue spans every user: non-admins only see the cards of their own boards. */
async function queueFor(user: User, repo: Repository, manager: AgentManager): Promise<QueueSnapshot> {
  if (user.role === "admin") return manager.queueSnapshot();
  const [queue, boards] = await Promise.all([manager.queueSnapshot(), repo.listBoards()]);
  return visibleQueue(queue, new Set(boards.map((board) => board.id)));
}

/**
 * A non-admin's `position` counts only their own queued cards (all they see): the card goes right
 * before their card now at that position, or right after their last one. Without other own cards
 * it keeps its place.
 */
async function wholeQueuePosition(
  repo: Repository,
  manager: AgentManager,
  taskId: string,
  position: number,
): Promise<number> {
  const [queue, boards] = await Promise.all([manager.queueSnapshot(), repo.listBoards()]);
  const boardIds = new Set(boards.map((board) => board.id));
  const others = queue.queued.filter((entry) => entry.taskId !== taskId);
  const own = others.flatMap((entry, i) => (boardIds.has(entry.boardId) ? [i] : []));
  if (own.length === 0) return Math.max(0, queue.queued.findIndex((entry) => entry.taskId === taskId));
  const at = Math.floor(position);
  return at < own.length ? own[at] : own[own.length - 1] + 1;
}

/** Running and queued agents across the caller's boards (queued in start order). */
export const GET = withApi(async ({ user, repo, manager }) => json(await queueFor(user, repo, manager)));

/** Reorder the queue: `{ taskId, position }`, position 0 starts next (among the caller's cards for non-admins). */
export const POST = withApi(async ({ req, user, repo, manager }) => {
  const body = await readJson(req);
  if (typeof body.taskId !== "string" || !body.taskId) throw new HttpError(400, "taskId is required");
  if (typeof body.position !== "number" || !Number.isFinite(body.position) || body.position < 0) {
    throw new HttpError(400, "position must be a number ≥ 0");
  }
  // 404 for cards the caller cannot see (the scoped repo hides other users' cards).
  await requireTask(repo, body.taskId);
  const position =
    user.role === "admin" ? body.position : await wholeQueuePosition(repo, manager, body.taskId, body.position);
  if (!manager.moveInQueue(body.taskId, position)) {
    throw new HttpError(409, "That card is not waiting in the queue.");
  }
  return json(await queueFor(user, repo, manager));
});
