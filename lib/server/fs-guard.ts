// Keeps non-admins out of the app's data directory (database, credentials key, every user's card
// and board files) on the server file-system routes (`/api/v1/fs/**`).
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/files";
import { HttpError } from "@/lib/server/http";
import type { User } from "@/lib/types";

/**
 * Real path of `p`: its nearest existing ancestor resolved through symlinks, plus the missing
 * names. `p` is first resolved lexically (like the fs helpers), so `..` can't hide anything.
 */
function realPath(p: string): string {
  let current = path.resolve(p);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** `child` is `parent` or lies below it (path.relative follows the platform's case rules). */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The data directory as configured and with symlinks resolved. */
function dataDirs(): string[] {
  const configured = path.resolve(dataDir());
  return [configured, realPath(configured)];
}

/**
 * `absPath` is one of `dirs` or inside one (as written or after resolving symlinks), or with
 * `containing` also when it contains one.
 */
function reaches(dirs: string[], absPath: string, containing: boolean): boolean {
  const written = path.resolve(absPath);
  const targets = [written, realPath(written)];
  return dirs.some((dir) =>
    targets.some((target) => isWithin(target, dir) || (containing && isWithin(dir, target))),
  );
}

/**
 * 403 when a non-admin's fs request touches the data directory or anything below it (symlinks
 * and `..` resolved); admins pass. `containing` also rejects its ancestors (delete, move, copy).
 */
export function assertFsAccess(user: User, absPath: string, options: { containing?: boolean } = {}): void {
  if (user.role === "admin") return;
  if (reaches(dataDirs(), absPath, options.containing === true)) {
    throw new HttpError(403, "This folder is restricted to administrators");
  }
}

/** `items` without those whose absolute path (`toPath`) is in the data directory; admins see all. */
export function withoutRestricted<T>(user: User, items: T[], toPath: (item: T) => string): T[] {
  if (user.role === "admin") return items;
  const dirs = dataDirs();
  return items.filter((item) => !reaches(dirs, toPath(item), false));
}
