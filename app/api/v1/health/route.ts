import { json, withApi } from "@/lib/server/http";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

// Probed by bin/supervisor.mjs and the Docker HEALTHCHECK: any failure (database or agent manager
// not answering) is a 500, and repeated failures force a restart. The first call boots the agent
// manager, which resumes interrupted and failed cards.
export const GET = withApi(
  async ({ repo, manager }) => {
    await repo.getSetting("app_settings");
    return json({ ok: true, version: APP_VERSION, db: repo.driver, agents: manager.stats() });
  },
  { auth: false },
);
