"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeftIcon, MenuIcon, PanelLeftIcon, SearchIcon } from "lucide-react";
import { isTopLevelPath } from "@/components/bottom-tabs";
import { openCommandPalette } from "@/components/command-palette";
import { CredentialNotificationsButton } from "@/components/credentials/credential-notifications";
import { HeaderMetrics } from "@/components/header-metrics";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The OMP-UI mark: a gamepad on a round tile. Same artwork as `public/icon.png`. */
export function LogoMark({ className }: { className?: string }) {
  return <img src="/icon-192.png" alt="" aria-hidden="true" className={cn("size-7 shrink-0 rounded-full", className)} />;
}

/**
 * Sticky page header: sidebar toggle (hamburger on phones), optional Back, the page title and the
 * page's own actions. Navigation and global utilities live in the sidebar (`AppSidebar`).
 */
export function AppHeader({
  title,
  subtitle,
  backHref,
  actions,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
  actions?: React.ReactNode;
}) {
  const pathname = usePathname();
  const { toggleSidebar } = useSidebar();
  // Top-level sections are one click away in the sidebar, so Back is only kept on phones there.
  const topLevel = isTopLevelPath(pathname);

  return (
    <header className="glass-edge pt-safe px-safe sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-xl backdrop-saturate-150 supports-backdrop-filter:bg-background/65">
      <div className="flex h-14 items-center gap-1 px-1.5 sm:gap-1.5 sm:px-3 md:px-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="pressable-icon size-11 shrink-0 rounded-full text-muted-foreground hover:text-foreground md:size-8 md:rounded-lg"
              aria-label="Toggle sidebar"
              onClick={toggleSidebar}
            >
              {/* Icons swap via CSS so server and client markup match. */}
              <MenuIcon className="size-5 md:hidden" />
              <PanelLeftIcon className="hidden size-4 md:block" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Toggle sidebar
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>B</Kbd>
            </KbdGroup>
          </TooltipContent>
        </Tooltip>
        <span aria-hidden="true" className="mx-1 hidden h-5 w-px shrink-0 bg-border md:block" />

        {backHref && (
          <Button
            asChild
            variant="ghost"
            size="icon"
            className={cn(
              "pressable-icon -ml-1 size-11 shrink-0 rounded-full md:ml-0 md:size-9",
              topLevel && "md:hidden",
            )}
          >
            <Link href={backHref} aria-label="Back">
              <ChevronLeftIcon className="size-5" />
            </Link>
          </Button>
        )}

        <div className="min-w-0 flex-1 px-1">
          <h1 className="truncate text-[0.95rem] leading-tight font-semibold tracking-tight text-foreground sm:text-base">
            {title}
          </h1>
          {subtitle && <p className="truncate text-xs leading-tight text-muted-foreground">{subtitle}</p>}
        </div>

        <HeaderMetrics variant="inline" className="mr-1 hidden lg:flex" />

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {actions}
          {/* Phones only: the sidebar (and its footer bell) is a sheet there. */}
          <CredentialNotificationsButton className="pressable-icon size-11 md:hidden" />
          {/* Desktop has Search in the sidebar; phones keep it one tap away here. */}
          <Button
            variant="ghost"
            size="icon"
            className="pressable-icon size-11 rounded-full md:hidden"
            aria-label="Search and commands"
            onClick={openCommandPalette}
          >
            <SearchIcon className="size-5" />
          </Button>
        </div>
      </div>
      {/* Below lg (phones, and tablets beside the desktop sidebar): the live metrics get their own slim row under the title bar. */}
      <HeaderMetrics variant="strip" className="border-t border-border/60 px-1.5 sm:px-3 md:px-4 lg:hidden" />
    </header>
  );
}
