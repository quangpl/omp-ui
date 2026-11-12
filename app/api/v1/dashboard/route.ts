import { buildDashboard } from "@/lib/dashboard";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Home dashboard: projects, cross-project counts, cards needing attention, recent results, queue. */
export const GET = withApi(async ({ repo, manager }) => json(await buildDashboard(repo, manager)));
