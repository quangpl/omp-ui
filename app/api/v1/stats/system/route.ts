import { json, withApi } from "@/lib/server/http";
import { getSystemStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const GET = withApi(async ({ repo, manager }) => json(await getSystemStats(repo, manager)));
