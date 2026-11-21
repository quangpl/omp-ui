import { json, readJson, withApi } from "@/lib/server/http";
import { createScheduler } from "@/lib/server/scheduler-ops";
import { requireBoard } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** All schedulers, newest first; `?boardId=` limits them to one project (404 if it doesn't exist). */
export const GET = withApi(async ({ req, repo }) => {
  const boardId = new URL(req.url).searchParams.get("boardId");
  if (boardId) await requireBoard(repo, boardId);
  return json(await repo.listSchedulers(boardId || undefined));
});

/**
 * Create a scheduler: `{ boardId, prompt, cron, timezone?, name?, enabled?, maxRuns?, model? }`. `name`
 * defaults to the prompt's first line, `timezone` to UTC, `enabled` to true, `maxRuns` to null
 * (forever) and `model` (an omp selector) to null: the project's model. Its next fire time is computed right away.
 */
export const POST = withApi(async ({ req, repo }) =>
  json(await createScheduler(repo, await readJson(req)), { status: 201 }),
);
