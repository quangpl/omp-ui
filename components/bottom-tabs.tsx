"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BrainIcon,
  CalendarClockIcon,
  ChartColumnIcon,
  ContainerIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  RadarIcon,
  ScrollTextIcon,
  SettingsIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { RunningCountBadge } from "@/components/containers/running-containers-button";
import { isMenuHrefVisible, useVisibleDashboardMenus } from "@/lib/dashboard-menus";
import { cn } from "@/lib/utils";

/**
 * Top-level sections: the sidebar's "Navigate" list. `phoneTab` ones are also bottom tabs on
 * phones; the rest stay in the sidebar sheet so the bar keeps eight tabs that still fit a 360px phone
 * (labels truncate).
 */
export const TOP_TABS = [
  { href: "/", label: "Projects", icon: LayoutGridIcon, phoneTab: true },
  { href: "/schedulers", label: "Schedulers", icon: CalendarClockIcon, phoneTab: true },
  { href: "/visualize", label: "Visualize", icon: RadarIcon, phoneTab: true },
  { href: "/containers", label: "Containers", icon: ContainerIcon, phoneTab: true },
  { href: "/terminal", label: "Terminal", icon: SquareTerminalIcon, phoneTab: true },
  { href: "/memory", label: "Memory", icon: BrainIcon, phoneTab: false },
  { href: "/credentials", label: "Credentials", icon: KeyRoundIcon, phoneTab: false },
  { href: "/stats", label: "Stats", icon: ChartColumnIcon, phoneTab: true },
  { href: "/logs", label: "Logs", icon: ScrollTextIcon, phoneTab: true },
  { href: "/settings", label: "Settings", icon: SettingsIcon, phoneTab: true },
] as const;

export function isTopLevelPath(pathname: string | null): boolean {
  return TOP_TABS.some((tab) => tab.href === pathname);
}

const BAR_HEIGHT = "calc(3.5rem + env(safe-area-inset-bottom))";

const PHONE_TABS = TOP_TABS.filter((tab) => tab.phoneTab);

/** Shared by the label and the indicator's invisible label so the pill lines up with the icon. */
const LABEL = "max-w-full truncate px-0.5 text-[11px] leading-4 font-medium tracking-tight";

/**
 * Fixed bottom tab bar for phones (<768px, hidden via CSS so there is no post-hydration flash);
 * only on top-level routes, for thumb reach. Everything else (projects, utilities, account) is in
 * the sidebar sheet behind the header's menu button. Renders an in-flow spacer so page content is
 * never covered.
 */
export function BottomTabs() {
  const pathname = usePathname();
  const visibleMenus = useVisibleDashboardMenus();
  if (!isTopLevelPath(pathname)) return null;
  const tabs = PHONE_TABS.filter((tab) => isMenuHrefVisible(tab.href, visibleMenus));
  // Sidebar-only and hidden sections still show the bar (they stay reachable by URL), just without
  // an active pill.
  const activeIndex = tabs.findIndex((tab) => tab.href === pathname);

  return (
    <>
      <div aria-hidden="true" className="shrink-0 md:hidden" style={{ height: BAR_HEIGHT }} />
      <nav
        aria-label="Main"
        className="glass-edge pb-safe px-safe fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/85 backdrop-blur-xl backdrop-saturate-150 supports-backdrop-filter:bg-background/70 md:hidden"
      >
        <ul className="relative flex h-14">
          {/* One sliding pill for the whole bar: positioned per tab in the server markup (no layout
              shift on first paint), then glides between tabs with a transform-only transition. */}
          <li
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 flex flex-col items-center justify-center gap-0.5 transition-[transform,opacity] duration-[380ms] ease-(--ease-fluid) motion-reduce:transition-none",
              activeIndex < 0 && "opacity-0",
            )}
            style={
              {
                "--i": Math.max(0, activeIndex),
                width: `${100 / tabs.length}%`,
                transform: "translateX(calc(var(--i) * 100%))",
              } as React.CSSProperties
            }
          >
            <span className="h-7 w-12 rounded-full bg-primary/12" />
            <span className={cn(LABEL, "invisible")}>&nbsp;</span>
          </li>
          {tabs.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              // `min-w-0` lets eight tabs share a 360px bar; long labels truncate instead of widening it.
              <li key={href} className="relative min-w-0 flex-1">
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "pressable-icon flex h-full flex-col items-center justify-center gap-0.5 outline-none [-webkit-tap-highlight-color:transparent] focus-visible:bg-muted",
                    active ? "text-primary" : "text-muted-foreground active:text-foreground",
                  )}
                >
                  <span className="relative flex h-7 w-12 items-center justify-center">
                    <Icon
                      className={cn(
                        "size-5 transition-transform duration-300 ease-(--ease-fluid) motion-reduce:transition-none",
                        active && "scale-110",
                      )}
                    />
                    {href === "/containers" && <RunningCountBadge className="absolute top-0 right-1" />}
                  </span>
                  <span className={LABEL}>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
