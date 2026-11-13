"use client";

import { useSyncExternalStore } from "react";
import { api } from "@/lib/api-client";
import { DASHBOARD_MENU_IDS, type DashboardMenuId } from "@/lib/types";

// Which optional navigation sections show (Settings → Menu `visibleDashboardMenus`), shared by the
// sidebar, the phone tabs and the home "Go to" strip. Loaded once per page load; the Settings page
// publishes saves so every menu updates without a reload.

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

/** The visible optional sections; every section until the settings load. */
export function useVisibleDashboardMenus(): readonly DashboardMenuId[] {
  return useSyncExternalStore(
    subscribe,
    () => visible,
    () => DASHBOARD_MENU_IDS,
  );
}

/** Whether a navigation link to `href` shows: sections outside DASHBOARD_MENU_IDS always do. */
export function isMenuHrefVisible(href: string, ids: readonly DashboardMenuId[]): boolean {
  const id = DASHBOARD_MENU_IDS.find((menu) => `/${menu}` === href);
  return id === undefined || ids.includes(id);
}
