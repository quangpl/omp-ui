import { revokeUserSessions } from "@/lib/auth";
import type { UpdateUserInput } from "@/lib/db/types";
import { auditFailures, HttpError, json, readJson, securityEvent, withApi } from "@/lib/server/http";
import { assertLoginAvailable, deleteUserWithData, isLastActiveAdmin, requireUser } from "@/lib/server/users";
import { parseBoolean, parseEmail, parseUsername, parseUserRole } from "@/lib/server/validate";
import type { User } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { id: string };

export const GET = withApi<Params>(async ({ repo, params }) => json(await requireUser(repo, params.id)), {
  admin: true,
});

/**
 * Body: `UpdateUserRequest`. Admins cannot demote or deactivate themselves, and the last active
 * admin must stay one. A role change or deactivation revokes the target's sessions.
 */
export const PATCH = withApi<Params>(
  async ({ req, repo, params, user }) =>
    auditFailures(req, "users", "User update failed", async () => {
      const target = await requireUser(repo, params.id);
      const body = await readJson(req);
      const patch: Pick<UpdateUserInput, "username" | "email" | "role" | "isActive"> = {};
      if (body.username !== undefined) patch.username = parseUsername(body.username);
      if (body.email !== undefined) patch.email = parseEmail(body.email);
      if (body.role !== undefined) patch.role = parseUserRole(body.role);
      if (body.isActive !== undefined) patch.isActive = parseBoolean(body.isActive, "isActive");
      const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((key) => patch[key] !== target[key]);
      if (changed.length === 0) return json(target);

      const losesAdmin = patch.role === "user" || patch.isActive === false;
      if (losesAdmin && target.id === user.id) {
        throw new HttpError(400, "You cannot demote or deactivate your own account");
      }
      if (losesAdmin && (await isLastActiveAdmin(repo, target))) {
        throw new HttpError(409, "At least one active admin is required");
      }
      await assertLoginAvailable(
        repo,
        {
          username: changed.includes("username") ? patch.username : undefined,
          email: changed.includes("email") ? patch.email : undefined,
        },
        target.id,
      );

      const updated = await repo.updateUser(target.id, patch);
      if (!updated) throw new HttpError(404, "User not found");
      if (updated.role !== target.role || (target.isActive && !updated.isActive)) {
        await revokeUserSessions(updated.id);
      }
      securityEvent(req, "info", "users", `User updated: ${updated.username} (${changed.join(", ")})`, {
        targetId: updated.id,
        targetUsername: updated.username,
        changed: changed.join(","),
      });
      return json(updated);
    }),
  { admin: true },
);

/**
 * `?reassignTo=<userId>` moves the user's boards and credentials to that active user; without it
 * they are deleted. Admins cannot delete themselves, and the last active admin cannot be deleted.
 */
export const DELETE = withApi<Params>(
  async ({ req, repo, manager, params, user }) =>
    auditFailures(req, "users", "User delete failed", async () => {
      const target = await requireUser(repo, params.id);
      if (target.id === user.id) throw new HttpError(400, "You cannot delete your own account");
      const reassignId = new URL(req.url).searchParams.get("reassignTo") || null;
      let reassignTo: User | null = null;
      if (reassignId !== null) {
        if (reassignId === target.id) throw new HttpError(400, "Cannot transfer a user's data to that same user");
        reassignTo = await repo.getUser(reassignId);
        if (!reassignTo?.isActive) throw new HttpError(400, "reassignTo must be an existing active user");
      }
      if (await isLastActiveAdmin(repo, target)) throw new HttpError(409, "Cannot delete the last active admin");

      const result = await deleteUserWithData(repo, manager, target, reassignTo);
      const outcome = reassignTo ? `data transferred to ${reassignTo.username}` : "data deleted";
      securityEvent(req, "info", "users", `User deleted: ${target.username} (${outcome})`, {
        targetId: target.id,
        targetUsername: target.username,
        boards: result.boards,
        credentials: result.credentials,
        reassignedTo: result.reassignedTo,
      });
      return json(result);
    }),
  { admin: true },
);
