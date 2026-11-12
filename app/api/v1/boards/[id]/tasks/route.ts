import { createCardFromText } from "@/lib/agent/compose";
import type { CreateTaskInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { json, readJson, withApi } from "@/lib/server/http";
import {
  parseBlockedBy,
  parseBrief,
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

/**
 * Create a card.
 * - `{ text, position? }`: a card from free text, created in "In progress" with its agent started
 *   (whatever the board's autoRun); the card writer turns the text into its title and brief in the
 *   background before the run starts (see lib/agent/compose.ts). Responds right away.
 * - `{ title, … }`: the card as given. Created directly in "In progress" on an autoRun board → the
 *   agent starts.
 */
export const POST = withApi<Params>(async ({ req, repo, manager, params }) => {
  const board = await requireBoard(repo, params.id);
  const body = await readJson(req);
  if (body.text !== undefined) {
    const text = parseBrief(body.text);
    const position = body.position === undefined ? undefined : parsePosition(body.position);
    return json(await createCardFromText({ repo, manager, board, text, position }), { status: 201 });
  }
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
