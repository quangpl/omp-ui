import { getRunningSummary } from "@/lib/docker";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Running containers + compose projects only (cheap; polled by the header badge). */
export const GET = withApi(async () => json(await getRunningSummary()));
