import { publish } from "@/lib/events";
import { json, readJson, withApi } from "@/lib/server/http";
import { parseCommentBody, requireTask } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = withApi<Params>(async ({ repo, params }) => {
  const task = await requireTask(repo, params.id);
  return json(await repo.listComments(task.id));
});

/** Feedback for the agent: steers a live run, or reopens/resumes a finished card. */
export const POST = withApi<Params>(async ({ req, repo, manager, params }) => {
  const task = await requireTask(repo, params.id);
  const body = await readJson(req);
  const comment = await repo.addComment({
    taskId: task.id,
    author: "user",
    body: parseCommentBody(body.body),
  });
  publish({ type: "comment.added", comment, boardId: task.boardId });
  const counted = await repo.getTask(task.id);
  if (counted) publish({ type: "task.updated", task: counted });
  await manager.onComment(counted ?? task, comment);
  // The hook may already have resolved it (a fast run that finished): answer with the stored state.
  return json((await repo.getComment(comment.id)) ?? comment, { status: 201 });
});
