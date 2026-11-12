"use client";

import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { BottomTabs } from "@/components/bottom-tabs";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

/**
 * App chrome: the left sidebar (icon rail when collapsed on desktop, off-canvas sheet on phones),
 * the page column, and the phone bottom tabs. The login page renders bare.
 * `defaultOpen` comes from the `sidebar_state` cookie so the server renders the persisted state.
 */
export function AppShell({ defaultOpen, children }: { defaultOpen: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login" || pathname?.startsWith("/login/")) return <>{children}</>;

  return (
    <SidebarProvider defaultOpen={defaultOpen} className="min-h-dvh">
      <AppSidebar />
      <SidebarInset className="min-h-dvh min-w-0">
        {children}
        <BottomTabs />
      </SidebarInset>
    </SidebarProvider>
  );
}
