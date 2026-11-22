"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { api } from "@/lib/api-client";
import { DASHBOARD_MENU_IDS, type DashboardMenuId } from "@/lib/types";

// Which optional navigation sections show (Settings → Menu `visibleDashboardMenus`), shared by the
// sidebar, the phone tabs and the home "Go to" strip. Loaded once per page load; the Settings page
// publishes saves so every menu updates without a reload. Admin-only pages are hidden from regular
// users on top of that.

/** Pages backed by admin-only APIs (terminal, docker, logs): their links show to admins only. */
export const ADMIN_ONLY_HREFS: readonly string[] = ["/containers", "/terminal", "/logs"];

/** What the navigation may show: the chosen optional sections, and whether admin-only pages count. */
export interface MenuVisibility {
  ids: readonly DashboardMenuId[];
  isAdmin: boolean;
}

let visible: readonly DashboardMenuId[] = DASHBOARD_MENU_IDS;
let requested = false;
/** Bumped by every publish so a slower initial load never overwrites a newer save. */
let version = 0;
const listeners = new Set<() => void>();

/** Every menu updates to `ids` (call after saving the setting). */
export function publishVisibleDashboardMenus(ids: readonly DashboardMenuId[]) {
  visible = ids;
  requested = true;
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!requested) {
    requested = true;
    const loadedAt = version;
    api.settings
      .get()
      .then((settings) => {
        if (version === loadedAt) publishVisibleDashboardMenus(settings.visibleDashboardMenus);
      })
      // Unreachable server: keep every menu and try again with the next subscriber.
      .catch(() => {
        requested = false;
      });
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The visible optional sections (every section until the settings load) and the admin flag (false
 * until the account is known, so regular users never see admin-only links flash in).
 */
export function useVisibleDashboardMenus(): MenuVisibility {
  const ids = useSyncExternalStore(
    subscribe,
    () => visible,
    () => DASHBOARD_MENU_IDS,
  );
  const { isAdmin } = useCurrentUser();
  return useMemo(() => ({ ids, isAdmin }), [ids, isAdmin]);
}

/**
 * Whether a navigation link to `href` shows: admin-only pages need an admin; sections outside
 * DASHBOARD_MENU_IDS always show otherwise.
 */
export function isMenuHrefVisible(href: string, { ids, isAdmin }: MenuVisibility): boolean {
  if (!isAdmin && ADMIN_ONLY_HREFS.includes(href)) return false;
  const id = DASHBOARD_MENU_IDS.find((menu) => `/${menu}` === href);
  return id === undefined || ids.includes(id);
}
