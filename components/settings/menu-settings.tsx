"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import {
  SettingsGroup,
  SettingsPanel,
  SettingsRows,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { publishVisibleDashboardMenus } from "@/lib/dashboard-menus";
import { DASHBOARD_MENU_IDS, type DashboardMenuId } from "@/lib/types";
import { cn } from "@/lib/utils";

const FIELD = "h-11 md:h-9";

const MENUS: Record<DashboardMenuId, { label: string; hint: string }> = {
  visualize: { label: "Visualize", hint: "Your agent crew at work, live across every project." },
  containers: { label: "Containers", hint: "Docker containers, stacks and the app catalog." },
  terminal: { label: "Terminal", hint: "A shell on the server in the browser." },
  files: { label: "Files", hint: "Browse and edit a project's files or any server folder." },
  artifacts: { label: "Artifacts", hint: "Final results and deliverables of finished cards, by project." },
  env: { label: "Environment", hint: "Environment variables every agent runs with." },
  mcp: { label: "MCP servers", hint: "Popular MCP servers connected to every agent." },
  stats: { label: "Stats", hint: "Usage, cost and throughput over time." },
  settings: {
    label: "Settings",
    hint: "When hidden, Settings stays reachable with G S or the command palette (⌘K / Ctrl K).",
  },
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** `ids` with `id` shown or hidden, in canonical order (the order every menu lists them in). */
function withMenu(ids: readonly DashboardMenuId[], id: DashboardMenuId, show: boolean): DashboardMenuId[] {
  return DASHBOARD_MENU_IDS.filter((menu) => (menu === id ? show : ids.includes(menu)));
}

/**
 * Settings → Menu: which optional sections the sidebar, phone tabs and home "Go to" links show.
 * Each switch saves on its own and publishes the saved list so every menu updates without a reload.
 */
export function MenuSettingsSection() {
  const [visible, setVisible] = useState<DashboardMenuId[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<DashboardMenuId>>(new Set());
  // The latest optimistic list, so quick toggles of different rows build on each other.
  const visibleRef = useRef<DashboardMenuId[] | null>(null);
  // Only the newest save's response is applied: an older one would undo toggles made since.
  const saveSeq = useRef(0);

  const show = useCallback((ids: DashboardMenuId[]) => {
    visibleRef.current = ids;
    setVisible(ids);
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    api.settings
      .get()
      .then((settings) => show(settings.visibleDashboardMenus))
      .catch((err) => setLoadError(errorText(err, "Could not load the menu settings.")));
  }, [show]);

  useEffect(load, [load]);

  async function onToggle(id: DashboardMenuId, checked: boolean) {
    const current = visibleRef.current;
    if (!current || pending.has(id)) return;
    const next = withMenu(current, id, checked);
    const seq = ++saveSeq.current;
    show(next);
    setPending((prev) => new Set(prev).add(id));
    const { label } = MENUS[id];
    try {
      const saved = await api.settings.update({ visibleDashboardMenus: next });
      if (seq === saveSeq.current) {
        show(saved.visibleDashboardMenus);
        publishVisibleDashboardMenus(saved.visibleDashboardMenus);
      }
      toast.success(checked ? `${label} shown in the menu` : `${label} hidden from the menu`);
    } catch (err) {
      // Revert only this row; other rows may have saved meanwhile.
      if (visibleRef.current) show(withMenu(visibleRef.current, id, !checked));
      toast.error(errorText(err, `Could not save the ${label} menu setting.`));
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <SettingsSection
      id="menu"
      icon={<PanelLeftIcon />}
      title="Menu"
      description="Choose which sections show in the sidebar, phone tabs and the home page's Go to links."
    >
      {loadError ? (
        <SettingsPanel className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="flex min-w-0 flex-1 gap-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">Couldn't load menu settings</p>
              <p className="text-destructive">{loadError}</p>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={load} className={cn(FIELD, "pressable w-full gap-2 sm:w-auto")}>
            <RotateCcwIcon />
            Try again
          </Button>
        </SettingsPanel>
      ) : visible === null ? (
        <SettingsPanel>
          <div aria-busy="true" className="space-y-4 p-4 sm:p-5">
            {DASHBOARD_MENU_IDS.map((id) => (
              <div key={id} className="flex items-center gap-4">
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-3 w-full max-w-sm" />
                </div>
                <Skeleton className="h-[18px] w-8 rounded-full" />
              </div>
            ))}
          </div>
        </SettingsPanel>
      ) : (
        <SettingsPanel>
          <SettingsGroup>
            <SettingsRows>
              {DASHBOARD_MENU_IDS.map((id) => (
                <SettingsToggle key={id} htmlFor={`menu-${id}`} title={MENUS[id].label} description={MENUS[id].hint}>
                  <Switch
                    id={`menu-${id}`}
                    checked={visible.includes(id)}
                    disabled={pending.has(id)}
                    onCheckedChange={(checked) => void onToggle(id, checked)}
                  />
                </SettingsToggle>
              ))}
            </SettingsRows>
          </SettingsGroup>
        </SettingsPanel>
      )}
    </SettingsSection>
  );
}
