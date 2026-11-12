import type { CreateTaskInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { json, readJson, withApi } from "@/lib/server/http";
import {
  parseBlockedBy,
  parseDescription,
  parsePosition,
  parseStatus,
  parseTitle,
  requireBoard,
} from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = withApi<Params>(async ({ repo, params }) => {
  await requireBoard(repo, params.id);
  return json(await repo.listTasks(params.id));
});

/** Create a card. Created directly in "In progress" on an autoRun board → the agent starts. */
export const POST = withApi<Params>(async ({ req, repo, manager, params }) => {
  const board = await requireBoard(repo, params.id);
  const body = await readJson(req);
  const input: CreateTaskInput = { boardId: board.id, title: parseTitle(body.title) };
  if (body.description !== undefined) input.description = parseDescription(body.description);
  if (body.status !== undefined) input.status = parseStatus(body.status);
  if (body.position !== undefined) input.position = parsePosition(body.position);
  if (body.blockedBy !== undefined) {
    input.blockedBy = await parseBlockedBy(repo, body.blockedBy, board.id, null);
  }
  const task = await repo.createTask(input);
  publish({ type: "task.updated", task });
  if (task.status === "in_progress" && board.autoRun) {
    await manager.start(task.id);
    return json((await repo.getTask(task.id)) ?? task, { status: 201 });
  }
  return json(task, { status: 201 });
});
