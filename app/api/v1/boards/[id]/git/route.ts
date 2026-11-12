import { gitStatus } from "@/lib/git";
import { json, withApi } from "@/lib/server/http";
import { requireBoard } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** Git status of every project folder: workdir first, then extraFolders. */
export const GET = withApi<{ id: string }>(async ({ repo, params }) => {
  const board = await requireBoard(repo, params.id);
  return json(await Promise.all([board.workdir, ...board.extraFolders].map(gitStatus)));
});
