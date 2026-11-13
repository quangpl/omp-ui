"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { BottomTabs } from "@/components/bottom-tabs";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { api } from "@/lib/api-client";

/**
 * Records each client-side page view in the access log (the path only, never the query string).
 * `null` skips (the login page). The ref keeps it to one beacon per pathname change, also under
 * React's dev double effects.
 */
function usePageViewBeacon(pathname: string | null): void {
  const lastRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname) {
      lastRef.current = null;
      return;
    }
    if (lastRef.current === pathname) return;
    lastRef.current = pathname;
    void api.logs.pageView(pathname);
  }, [pathname]);
}

/**
 * App chrome: the left sidebar (icon rail when collapsed on desktop, off-canvas sheet on phones),
 * the page column, and the phone bottom tabs. The login page renders bare.
 * `defaultOpen` comes from the `sidebar_state` cookie so the server renders the persisted state.
 */
export function AppShell({ defaultOpen, children }: { defaultOpen: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const login = pathname === "/login" || Boolean(pathname?.startsWith("/login/"));
  usePageViewBeacon(login ? null : pathname);
  if (login) return <>{children}</>;

  return (
    <SidebarProvider defaultOpen={defaultOpen} className="min-h-dvh">
      <AppSidebar />
      {/* `overflow-x-clip` (not hidden) keeps a stray wide child from scrolling the phone page sideways without
          creating a scroll container, so the sticky header keeps working. */}
      <SidebarInset className="min-h-dvh min-w-0 max-md:overflow-x-clip">
        {children}
        <BottomTabs />
      </SidebarInset>
    </SidebarProvider>
  );
}
