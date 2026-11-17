import { getRequestUser } from "@/lib/auth";
import { getRepo } from "@/lib/db";
import { importArchive } from "@/lib/server/data-transfer";
import { auditFailures, HttpError, json, securityEvent, withApi } from "@/lib/server/http";
import type { DataImportResult } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Replace all of this server's data with an export (raw `.tar.gz` body). `?confirm=replace` is
 * required. 409 while agents run or queue; 400 for an invalid archive (nothing changed then).
 */
export const POST = withApi(
  async ({ req, manager }) =>
    auditFailures(req, "data", "Data import failed", async () => {
      if (new URL(req.url).searchParams.get("confirm") !== "replace") {
        throw new HttpError(400, "Add ?confirm=replace: an import replaces all data on this server");
      }
      const imported = await importArchive(await getRepo(), manager, req.body);
      securityEvent(
        req,
        "warn",
        "data",
        `Data imported from an export of ${imported.source.createdAt}; previous data saved as ${imported.backup.name}`,
      );
      const result: DataImportResult = { ...imported, signedOut: !(await getRequestUser(req)) };
      return json(result);
    }),
  { admin: true },
);
