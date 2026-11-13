import { checkRepo } from "@/lib/git";
import { HttpError, json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Whether `?path=` (an existing absolute folder) is inside a git repository. */
export const GET = withApi(async ({ req }) => {
  const folder = new URL(req.url).searchParams.get("path");
  if (!folder?.trim()) throw new HttpError(400, "Please choose a folder.");
  return json(await checkRepo(folder));
});
