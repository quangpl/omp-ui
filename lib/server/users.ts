// Server helpers for the admin-only `app/api/v1/users/**` routes.
import type { AgentManager } from "@/lib/agent/types";
import type { Repository } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { deleteUserCredentials, reassignCredentials } from "@/lib/server/credentials";
import { deleteBoardWithData } from "@/lib/server/delete-board";
import { HttpError } from "@/lib/server/http";
import { syncMcpServers } from "@/lib/server/mcp";
import type { DeleteUserResult, User } from "@/lib/types";

export async function requireUser(repo: Repository, id: string): Promise<User> {
  const user = await repo.getUser(id);
  if (!user) throw new HttpError(404, "User not found");
  return user;
}

/**
 * 409 when `username` or `email` (already normalized) belongs to another account than `exceptId`.
 * Checked up front for a clear message; the drivers' unique indexes still guard against races.
 */
export async function assertLoginAvailable(
  repo: Repository,
  login: { username?: string; email?: string | null },
  exceptId: string | null = null,
): Promise<void> {
  if (login.username !== undefined) {
    const owner = await repo.findUserAuthByLogin(login.username);
    if (owner && owner.id !== exceptId) throw new HttpError(409, "Username already taken");
  }
  if (login.email) {
    const owner = await repo.findUserAuthByLogin(login.email);
    if (owner && owner.id !== exceptId) throw new HttpError(409, "Email already in use");
  }
}

export async function countActiveAdmins(repo: Repository): Promise<number> {
  return (await repo.listUsers()).filter((u) => u.role === "admin" && u.isActive).length;
}

/** True when `user` is the only active admin left, so it must stay an active admin. */
export async function isLastActiveAdmin(repo: Repository, user: User): Promise<boolean> {
  return user.role === "admin" && user.isActive && (await countActiveAdmins(repo)) <= 1;
}

/**
 * Removes `user`. With `reassignTo` their boards (with cards, comments, runs, schedulers) and
 * credentials move to that user; otherwise each board gets the same teardown as
 * `DELETE /boards/:id` and their credentials are deleted. `repo` must see every user's rows
 * (the base repository or an admin-scoped one).
 */
export async function deleteUserWithData(
  repo: Repository,
  manager: AgentManager,
  user: User,
  reassignTo: User | null,
): Promise<DeleteUserResult> {
  const boards = await repo.listBoards(user.id);
  let boardCount: number;
  let credentials: number;
  if (reassignTo) {
    boardCount = await repo.reassignUserData(user.id, reassignTo.id);
    credentials = await reassignCredentials(repo, user.id, reassignTo.id);
    // Open clients re-read the moved boards (their owner changed).
    for (const { id } of boards) {
      const board = await repo.getBoard(id);
      if (board) publish({ type: "board.updated", board });
    }
  } else {
    // One board at a time: their cards' workspaces may share a git repository (lock files).
    for (const board of boards) await deleteBoardWithData(repo, manager, board);
    boardCount = boards.length;
    credentials = await deleteUserCredentials(repo, user.id);
    // MCP servers bound to the deleted credentials must drop their stale mcp.json entries.
    if (credentials > 0) await syncMcpServers(repo);
  }
  await repo.deleteUser(user.id);
  return { ok: true, boards: boardCount, credentials, reassignedTo: reassignTo?.id ?? null };
}
