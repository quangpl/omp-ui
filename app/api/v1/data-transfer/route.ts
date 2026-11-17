import { getRepo } from "@/lib/db";
import { dataTransferStatus } from "@/lib/server/data-transfer";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Settings → Data transfer: what an export holds, whether an import may run, and the automatic backups. */
export const GET = withApi(async ({ manager }) => json(await dataTransferStatus(await getRepo(), manager)), {
  admin: true,
});
