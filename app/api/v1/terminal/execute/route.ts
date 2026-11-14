import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { getTerminalSession } from "@/lib/server/terminal";
import type { TerminalExecuteRequest } from "@/lib/terminal-types";

export const dynamic = "force-dynamic";

/** Start a command in the terminal session → 201 running block. Its output arrives on /stream. */
export const POST = withApi(async ({ req }) => {
  const body = await readJson<Partial<Record<keyof TerminalExecuteRequest, unknown>>>(req);
  if (typeof body.command !== "string") throw new HttpError(400, "command is required");
  if (body.cwd !== undefined && body.cwd !== null && typeof body.cwd !== "string") {
    throw new HttpError(400, "cwd must be a string");
  }
  const block = await getTerminalSession().execute(body.command, body.cwd || undefined);
  return json(block, { status: 201 });
});
