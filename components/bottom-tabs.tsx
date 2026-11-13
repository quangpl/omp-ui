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
  SettingsIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { RunningCountBadge } from "@/components/containers/running-containers-button";
import { cn } from "@/lib/utils";

/**
 * Top-level sections: the sidebar's "Navigate" list. `phoneTab` ones are also bottom tabs on
 * phones; the rest stay in the sidebar sheet so the bar keeps seven tabs that still fit a 360px phone.
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
  { href: "/settings", label: "Settings", icon: SettingsIcon, phoneTab: true },
] as const;

export function isTopLevelPath(pathname: string | null): boolean {
  return TOP_TABS.some((tab) => tab.href === pathname);
}

const BAR_HEIGHT = "calc(3.5rem + env(safe-area-inset-bottom))";

/**
 * Fixed bottom tab bar for phones (<768px, hidden via CSS so there is no post-hydration flash);
 * only on top-level routes, for thumb reach. Everything else (projects, utilities, account) is in
 * the sidebar sheet behind the header's menu button. Renders an in-flow spacer so page content is
 * never covered.
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
          {TOP_TABS.filter((tab) => tab.phoneTab).map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              // `min-w-0` lets six tabs share a 360px bar; long labels truncate instead of widening it.
              <li key={href} className="min-w-0 flex-1">
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group/tab flex h-full flex-col items-center justify-center gap-0.5 text-[0.65rem] font-medium min-[400px]:text-[0.7rem] outline-none transition-colors focus-visible:bg-muted",
                    active ? "text-primary" : "text-muted-foreground active:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "relative flex h-7 w-12 items-center justify-center rounded-full transition-[background-color,transform] duration-150 group-active/tab:scale-90 motion-reduce:transition-none",
                      active && "bg-primary/12",
                    )}
                  >
                    <Icon className="size-5" />
                    {href === "/containers" && <RunningCountBadge className="absolute top-0 right-1" />}
                  </span>
                  <span className="max-w-full truncate px-0.5">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
