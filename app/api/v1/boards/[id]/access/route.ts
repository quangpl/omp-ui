import { HttpError, json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Records that the board was opened (`lastAccessedAt`), which picks the sidebar's "Your projects". */
export const POST = withApi<{ id: string }>(async ({ repo, params }) => {
  const board = await repo.markBoardAccessed(params.id);
  if (!board) throw new HttpError(404, "Board not found");
  return json(board);
});
