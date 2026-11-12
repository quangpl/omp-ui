import { buildDashboard } from "@/lib/dashboard";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Home dashboard: projects (with git status and 30-day run success), cross-project counts, cards
 * that need the user, live agents with their latest activity, 24 h / 7-day stats, recent activity,
 * getting-started progress and the queue.
 */
export const GET = withApi(async ({ repo, manager }) => json(await buildDashboard(repo, manager)));
