"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeftIcon, MenuIcon, PanelLeftIcon, SearchIcon } from "lucide-react";
import { isTopLevelPath } from "@/components/bottom-tabs";
import { openCommandPalette } from "@/components/command-palette";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The AgentMan mark: three kanban columns on an accent tile. Matches `public/icon.svg`. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-7 shrink-0", className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <rect x="7" y="7" width="5" height="16" rx="2.5" className="fill-primary-foreground" />
      <rect
        x="13.5"
        y="7"
        width="5"
        height="10"
        rx="2.5"
        className="fill-primary-foreground"
        opacity="0.75"
      />
      <rect
        x="20"
        y="7"
        width="5"
        height="13"
        rx="2.5"
        className="fill-primary-foreground"
        opacity="0.5"
      />
    </svg>
  );
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
    <header className="pt-safe px-safe sticky top-0 z-40 border-b bg-background/80 backdrop-blur-lg supports-backdrop-filter:bg-background/65">
      <div className="flex h-14 items-center gap-1 px-1.5 sm:gap-1.5 sm:px-3 md:px-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 rounded-full text-muted-foreground hover:text-foreground active:scale-95 md:size-8 md:rounded-lg"
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
            className={cn("-ml-1 size-11 shrink-0 rounded-full md:ml-0 md:size-9", topLevel && "md:hidden")}
          >
            <Link href={backHref} aria-label="Back">
              <ChevronLeftIcon className="size-5" />
            </Link>
          </Button>
        )}

        <div className="min-w-0 flex-1 px-1">
          <h1 className="truncate text-[0.95rem] leading-tight font-semibold tracking-tight sm:text-base">{title}</h1>
          {subtitle && <p className="truncate text-xs leading-tight text-muted-foreground">{subtitle}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {actions}
          {/* Desktop has Search in the sidebar; phones keep it one tap away here. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-11 rounded-full active:scale-95 md:hidden"
            aria-label="Search and commands"
            onClick={openCommandPalette}
          >
            <SearchIcon className="size-5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
