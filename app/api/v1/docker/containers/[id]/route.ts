import {
  CONTAINER_ACTIONS,
  containerAction,
  inspectContainer,
  parseContainerRef,
  removeContainer,
} from "@/lib/docker";
import type { ContainerAction } from "@/lib/docker-types";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** `docker inspect` of one container. */
export const GET = withApi<Params>(async ({ params }) => json(await inspectContainer(parseContainerRef(params.id))), { admin: true });

/** `{ action: "start" | "stop" | "restart" | "pause" | "unpause" | "kill" }` */
export const POST = withApi<Params>(async ({ req, params }) => {
  const ref = parseContainerRef(params.id);
  const { action } = await readJson<{ action?: unknown }>(req);
  if (!CONTAINER_ACTIONS.includes(action as ContainerAction)) {
    throw new HttpError(400, `action must be one of ${CONTAINER_ACTIONS.join(", ")}`);
  }
  await containerAction(ref, action as ContainerAction);
  return json({ ok: true });
}, { admin: true });

/** Force-remove; `?volumes=1` also removes its anonymous volumes. */
export const DELETE = withApi<Params>(async ({ req, params }) => {
  const ref = parseContainerRef(params.id);
  await removeContainer(ref, new URL(req.url).searchParams.get("volumes") === "1");
  return json({ ok: true });
}, { admin: true });
