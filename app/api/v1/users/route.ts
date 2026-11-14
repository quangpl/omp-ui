import { hashPassword } from "@/lib/auth";
import { auditFailures, json, readJson, securityEvent, withApi } from "@/lib/server/http";
import { assertLoginAvailable } from "@/lib/server/users";
import { parseEmail, parseNewPassword, parseUsername, parseUserRole } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

export const GET = withApi(async ({ repo }) => json(await repo.listUsers()), { admin: true });

/** Body: `CreateUserRequest`. `role` defaults to "user". */
export const POST = withApi(
  async ({ req, repo }) =>
    auditFailures(req, "users", "User create failed", async () => {
      const body = await readJson(req);
      const username = parseUsername(body.username);
      const email = parseEmail(body.email);
      const password = parseNewPassword(body.password);
      const role = body.role === undefined ? "user" : parseUserRole(body.role);
      await assertLoginAvailable(repo, { username, email });
      const user = await repo.createUser({ username, email, passwordHash: await hashPassword(password), role });
      securityEvent(req, "info", "users", `User created: ${user.username} (${user.role})`, {
        targetId: user.id,
        targetUsername: user.username,
      });
      return json(user, { status: 201 });
    }),
  { admin: true },
);
