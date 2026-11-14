import {
  COMPOSE_ACTIONS,
  composeAction,
  jobResponse,
  parseProjectName,
  readComposeFile,
  removeComposeProject,
} from "@/lib/docker";
import type { ComposeAction } from "@/lib/docker-types";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { name: string };

/** The project's compose file and .env (`ComposeFile`). */
export const GET = withApi<Params>(async ({ params }) => json(await readComposeFile(parseProjectName(params.name))), { admin: true });

/** `{ action: "up" | "down" | "stop" | "start" | "restart" | "pull" }`. Streams NDJSON. */
export const POST = withApi<Params>(async ({ req, params }) => {
  const name = parseProjectName(params.name);
  const { action } = await readJson<{ action?: unknown }>(req);
  if (!COMPOSE_ACTIONS.includes(action as ComposeAction)) {
    throw new HttpError(400, `action must be one of ${COMPOSE_ACTIONS.join(", ")}`);
  }
  return jobResponse((send) => composeAction(name, action as ComposeAction, send));
}, { admin: true });

/** `down` (`?volumes=1` also removes its volumes); AgentMan projects also lose their folder. NDJSON. */
export const DELETE = withApi<Params>(async ({ req, params }) => {
  const name = parseProjectName(params.name);
  const removeVolumes = new URL(req.url).searchParams.get("volumes") === "1";
  return jobResponse((send) => removeComposeProject(name, removeVolumes, send));
}, { admin: true });
