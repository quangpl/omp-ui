import { publish } from "@/lib/events";
import { error, json, readJson, withApi } from "@/lib/server/http";
import { parseBoolean } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const PATCH = withApi<Params>(async ({ req, repo, params }) => {
  const existing = await repo.getComment(params.id);
  if (!existing) return error(404, "Comment not found");
  const body = await readJson(req);
  const resolved = parseBoolean(body.resolved, "resolved");
  const comment = await repo.setCommentResolved(existing.id, resolved, null);
  if (!comment) return error(404, "Comment not found");
  const task = await repo.getTask(comment.taskId);
  if (task) {
    publish({ type: "comment.updated", comment, boardId: task.boardId });
    publish({ type: "task.updated", task });
  }
  return json(comment);
});

export const DELETE = withApi<Params>(async ({ repo, params }) => {
  const comment = await repo.getComment(params.id);
  if (!comment) return error(404, "Comment not found");
  await repo.deleteComment(comment.id);
  const task = await repo.getTask(comment.taskId);
  if (task) {
    publish({
      type: "comment.deleted",
      commentId: comment.id,
      taskId: task.id,
      boardId: task.boardId,
    });
    publish({ type: "task.updated", task });
  }
  return json({ ok: true });
});
