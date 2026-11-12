import { BRIEF_FILE } from "@/lib/card-draft";
import type { CreateTaskInput } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { writeTextFile } from "@/lib/files";
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
 * Create a card. Created directly in "In progress" on an autoRun board → the agent starts.
 * `brief` (the free text the card was written from) is saved among the card's files as `brief.md`
 * before its agent starts, and the description points the agent to it.
 */
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
  const brief = body.brief === undefined ? null : parseBrief(body.brief, "brief");
  if (brief) {
    const note = `The user's full original request, word for word, is in ${BRIEF_FILE} among this card's files.`;
    input.description = [input.description, note].filter(Boolean).join("\n\n");
  }
  const task = await repo.createTask(input);
  if (brief) {
    try {
      await writeTextFile("tasks", task.id, BRIEF_FILE, `${brief}\n`);
    } catch (err) {
      await repo.deleteTask(task.id);
      throw err;
    }
  }
  publish({ type: "task.updated", task });
  if (task.status === "in_progress" && board.autoRun) {
    await manager.start(task.id);
    return json((await repo.getTask(task.id)) ?? task, { status: 201 });
  }
  return json(task, { status: 201 });
});
