import { createCardFromText } from "@/lib/agent/compose";
import type { CreateTaskInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { deleteCard } from "@/lib/server/delete-card";
import { json, readJson, withApi } from "@/lib/server/http";
import {
  parseBlockedBy,
  parseBoolean,
  parseBrief,
  parseDescription,
  parsePosition,
  parseStatus,
  parseTaskIds,
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
 * - `{ text, position? }`: a card from free text, created in "In progress" with its
 *   agent started right away (whatever the board's autoRun), titled from the text as typed (see
 *   lib/agent/compose.ts).
 * - `{ title, … }`: the card as given. Created directly in "In progress" on an autoRun board → the
 *   agent starts.
 * Either may carry `ignoreMemory` (boolean): whether the card's runs start omp without
 * agentmemory (no recall, no capture, no memory tools). Omitted → false.
 */
export const POST = withApi<Params>(async ({ req, repo, manager, params }) => {
  const board = await requireBoard(repo, params.id);
  const body = await readJson(req);
  const ignoreMemory =
    body.ignoreMemory === undefined || body.ignoreMemory === null
      ? false
      : parseBoolean(body.ignoreMemory, "ignoreMemory");
  if (body.text !== undefined) {
    const text = parseBrief(body.text);
    const position = body.position === undefined ? undefined : parsePosition(body.position);
    return json(await createCardFromText({ repo, manager, board, text, position, ignoreMemory }), {
      status: 201,
    });
  }
  const input: CreateTaskInput = {
    boardId: board.id,
    title: parseTitle(body.title),
    ignoreMemory,
  };
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

/**
 * Delete several cards of the board at once: `{ ids }` (e.g. every Done card). Ids not on this
 * board are skipped. Cards go one at a time (see deleteCard). Answers `{ deleted }`.
 */
export const DELETE = withApi<Params>(async ({ req, repo, manager, params }) => {
  const board = await requireBoard(repo, params.id);
  const ids = parseTaskIds((await readJson(req)).ids);
  const tasks = (await repo.listTasks(board.id)).filter((task) => ids.has(task.id));
  for (const task of tasks) await deleteCard(repo, manager, task, board);
  return json({ deleted: tasks.map((task) => task.id) });
});
