import { setUserPassword } from "@/lib/auth";
import { auditFailures, json, readJson, securityEvent, sessionResponse, withApi } from "@/lib/server/http";
import { requireUser } from "@/lib/server/users";
import { parseNewPassword } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

type Params = { id: string };

/**
 * Body: `{ password }`. Sets the user's password and signs out all their sessions. When it is the
 * caller's own account, answers with a fresh session so the admin stays signed in.
 */
export const PATCH = withApi<Params>(
  async ({ req, repo, params, user }) =>
    auditFailures(req, "users", "User password change failed", async () => {
      const target = await requireUser(repo, params.id);
      const { password } = await readJson(req);
      await setUserPassword(target.id, parseNewPassword(password));
      securityEvent(req, "info", "users", `User password set: ${target.username}; sessions revoked`, {
        targetId: target.id,
        targetUsername: target.username,
      });
      return target.id === user.id ? sessionResponse(req, user) : json({ ok: true });
    }),
  { admin: true },
);
