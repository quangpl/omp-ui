"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartColumnIcon, LayoutGridIcon, RadarIcon, SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Top-level sections, shown as bottom tabs on mobile and inline tabs in the desktop header. */
export const TOP_TABS = [
  { href: "/", label: "Projects", icon: LayoutGridIcon },
  { href: "/visualize", label: "Visualize", icon: RadarIcon },
  { href: "/stats", label: "Stats", icon: ChartColumnIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

export function isTopLevelPath(pathname: string | null): boolean {
  return TOP_TABS.some((tab) => tab.href === pathname);
}

const BAR_HEIGHT = "calc(3.5rem + env(safe-area-inset-bottom))";

/**
 * Fixed bottom tab bar for phones (<768px, hidden via CSS so there is no post-hydration flash);
 * only on top-level routes. Renders an in-flow spacer so page content is never covered.
 */
export function BottomTabs() {
  const pathname = usePathname();
  if (!isTopLevelPath(pathname)) return null;

  return (
    <>
      <div aria-hidden="true" className="shrink-0 md:hidden" style={{ height: BAR_HEIGHT }} />
      <nav
        aria-label="Main"
        className="pb-safe px-safe fixed inset-x-0 bottom-0 z-40 border-t bg-background/85 backdrop-blur-lg supports-backdrop-filter:bg-background/70 md:hidden"
      >
        <ul className="flex h-14">
          {TOP_TABS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-full flex-col items-center justify-center gap-0.5 text-[0.7rem] font-medium outline-none transition-colors focus-visible:bg-muted",
                    active ? "text-primary" : "text-muted-foreground active:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-14 items-center justify-center rounded-full transition-colors",
                      active && "bg-primary/12",
                    )}
                  >
                    <Icon className="size-5" />
                  </span>
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
