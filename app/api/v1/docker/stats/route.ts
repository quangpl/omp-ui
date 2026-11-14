import { getContainerStats } from "@/lib/docker";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** CPU / memory / IO of running containers (`docker stats --no-stream`, ~2 s). */
export const GET = withApi(async () => json(await getContainerStats()), { admin: true });
