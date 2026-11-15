import { bundleResponse } from "@/lib/cluster/bootstrap";
import { withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Public: gzip tar of this server's app build + bin/supervisor.mjs (the join script installs it). */
export const GET = withApi(bundleResponse, { auth: false });
