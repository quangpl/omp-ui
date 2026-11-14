import { PRUNE_KINDS, prune } from "@/lib/docker";
import type { PruneKind } from "@/lib/docker-types";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** `{ kind }`: remove stopped containers, dangling images, unused volumes/networks or build cache. */
export const POST = withApi(async ({ req }) => {
  const { kind } = await readJson<{ kind?: unknown }>(req);
  if (!PRUNE_KINDS.includes(kind as PruneKind)) {
    throw new HttpError(400, `kind must be one of ${PRUNE_KINDS.join(", ")}`);
  }
  return json({ message: await prune(kind as PruneKind) });
}, { admin: true });
