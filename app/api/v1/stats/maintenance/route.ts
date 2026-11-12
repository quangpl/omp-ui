import { analyzeSystem, runMaintenance } from "@/lib/maintenance";
import { json, readJson, withApi } from "@/lib/server/http";
import { parseMaintenanceAction } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

/** Analyze CPU, memory and storage: top processes, agent leftovers, cleanable data and recommendations (~1 s). */
export const GET = withApi(async ({ repo, manager }) => json(await analyzeSystem(repo, manager)));

/** Clean up storage, end processes, free server memory or stop a card; see MaintenanceAction. */
export const POST = withApi(async ({ req, repo, manager }) =>
  json(await runMaintenance(parseMaintenanceAction(await readJson(req)), repo, manager)),
);
