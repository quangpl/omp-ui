import { getDockerOverview } from "@/lib/docker";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Containers, compose projects, images, volumes and networks; `available: false` without Docker. */
export const GET = withApi(async () => json(await getDockerOverview()));
