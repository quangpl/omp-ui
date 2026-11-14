import { topPosition } from "@/lib/db/util";
import { publish } from "@/lib/events";
import { HttpError, error, json, readJson, withApi } from "@/lib/server/http";
import { parseReviewDecision, parseReviewHash, parseReviewNote, requireTask } from "@/lib/server/validate";
import type { TaskReviewResult } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { id: string };

/**
 * Code review decision on a card's changes. Approve (agent idle) stores the review and moves the
 * card to the top of Done; request changes stores it and posts the note as feedback, which steers
 * a live run or resumes the agent like `POST /tasks/:id/comments`.
 */
export const POST = withApi<Params>(async ({ req, repo, manager, params }) => {
  const previous = await requireTask(repo, params.id);
  const body = await readJson(req);
  const action = parseReviewDecision(body.decision);
  const note = parseReviewNote(body.note, action === "request_changes");
  const hash = parseReviewHash(body.hash);
  const at = new Date().toISOString();

  if (action === "approve") {
    if (previous.agentState === "running" || previous.agentState === "queued") {
      throw new HttpError(409, "The agent is still working; stop it or wait before approving");
    }
    const updated = await repo.updateTask(previous.id, {
      review: { decision: "approved", hash, note, at },
      ...(previous.status === "done"
        ? {}
        : { status: "done" as const, position: await topPosition(repo, previous.boardId, "done", previous.id) }),
    });
    if (!updated) return error(404, "Task not found");
    if (updated.status !== previous.status) await manager.onTaskMoved(updated, previous.status);
    const task = (await repo.getTask(updated.id)) ?? updated;
    publish({ type: "task.updated", task });
    return json({ task, comment: null } satisfies TaskReviewResult);
  }

  // parseReviewNote requires the note for request_changes.
  const reviewed = await repo.updateTask(previous.id, {
    review: { decision: "changes_requested", hash, note, at },
  });
  if (!reviewed) return error(404, "Task not found");
  const added = await repo.addComment({
    taskId: reviewed.id,
    author: "user",
    body: `**Changes requested**\n\n${note}`,
  });
  publish({ type: "comment.added", comment: added, boardId: reviewed.boardId });
  const counted = await repo.getTask(reviewed.id);
  if (counted) publish({ type: "task.updated", task: counted });
  await manager.onComment(counted ?? reviewed, added);
  const task = (await repo.getTask(reviewed.id)) ?? counted ?? reviewed;
  publish({ type: "task.updated", task });
  // The hook may already have resolved it (a fast run that finished): answer with the stored state.
  const comment = (await repo.getComment(added.id)) ?? added;
  return json({ task, comment } satisfies TaskReviewResult);
});
