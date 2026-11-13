import { getNotifications, parseNotificationAction, updateNotifications } from "@/lib/server/credentials";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Failing, expired, expiring and long-untested credentials (not dismissed), newest first. */
export const GET = withApi(async ({ repo }) => json(await getNotifications(repo)));

/** `{ action: "read" | "dismiss" | "read-all" | "dismiss-all", ids?: string[] }`. */
export const POST = withApi(async ({ req, repo }) =>
  auditFailures(req, "credentials", "Credential notification action failed", async () => {
    const { action, ids } = parseNotificationAction(await readJson(req));
    const response = await updateNotifications(repo, action, ids);
    securityEvent(req, "info", "credentials", `Credential notifications: ${action}`, {
      action,
      count: ids.length,
      unread: response.unread,
    });
    return json(response);
  }),
);
