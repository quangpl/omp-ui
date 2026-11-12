import { json, withApi } from "@/lib/server/http";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

export const GET = withApi(
  ({ repo, manager }) =>
    json({ ok: true, version: APP_VERSION, db: repo.driver, agents: manager.stats() }),
  { auth: false },
);
