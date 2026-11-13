import { getNotifications, parseNotificationAction, updateNotifications } from "@/lib/server/credentials";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Failing, expired, expiring and long-untested credentials (not dismissed), newest first. */
export const GET = withApi(async ({ repo }) => json(await getNotifications(repo)));

/** `{ action: "read" | "dismiss" | "read-all" | "dismiss-all", ids?: string[] }`. */
export const POST = withApi(async ({ req, repo }) => {
  const { action, ids } = parseNotificationAction(await readJson(req));
  return json(await updateNotifications(repo, action, ids));
});
