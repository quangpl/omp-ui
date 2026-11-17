import { getRepo } from "@/lib/db";
import { exportResponse } from "@/lib/server/data-transfer";
import { securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Download every row of the database, the shared files and the credentials key as one `.tar.gz`
 * for POST /data-transfer/import on another server. Holds secrets and password hashes.
 */
export const GET = withApi(
  async ({ req }) => {
    const response = await exportResponse(await getRepo());
    securityEvent(req, "info", "data", "Data exported");
    return response;
  },
  { admin: true },
);
