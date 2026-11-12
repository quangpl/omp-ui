"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartColumnIcon,
  ChevronLeftIcon,
  KeyboardIcon,
  LogOutIcon,
  SearchIcon,
  SettingsIcon,
  UserRoundIcon,
} from "lucide-react";
import { isTopLevelPath, TOP_TABS } from "@/components/bottom-tabs";
import { openCommandPalette } from "@/components/command-palette";
import { openKeyboardHelp } from "@/components/keyboard-help";
import { QueueButton } from "@/components/queue-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/** The OMP UI mark: three kanban columns on an accent tile. Matches `public/icon.svg`. */
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

async function logout() {
  try {
    await api.auth.logout();
  } catch {
    // The cookie is cleared server-side when possible; either way we leave the app.
  }
  location.href = "/login";
}

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
  // Top-level sections get inline tabs on desktop (phones use the bottom tab bar instead).
  const topLevel = isTopLevelPath(pathname);
  const showLogo = !backHref || topLevel;

  return (
    <header className="pt-safe px-safe sticky top-0 z-40 border-b bg-background/80 backdrop-blur-lg supports-backdrop-filter:bg-background/65">
      <div className="flex h-14 items-center gap-1 px-1.5 sm:gap-2 sm:px-4">
        {backHref && (
          <Button
            asChild
            variant="ghost"
            size="icon"
            className={cn("size-11 shrink-0 rounded-full md:size-9", topLevel && "md:hidden")}
          >
            <Link href={backHref} aria-label="Back">
              <ChevronLeftIcon className="size-5" />
            </Link>
          </Button>
        )}
        {showLogo && (
          <Link
            href="/"
            aria-label="OMP UI home"
            className={cn(
              "flex h-11 shrink-0 items-center gap-2 rounded-lg px-1.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              backHref && "hidden md:flex",
            )}
          >
            <LogoMark />
            <span className="hidden text-sm font-semibold tracking-tight sm:inline">OMP UI</span>
          </Link>
        )}

        {showLogo && (
          <span
            aria-hidden="true"
            className={cn("mx-1 hidden h-5 w-px bg-border", backHref ? "md:block" : "sm:block")}
          />
        )}

        {topLevel && (
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {TOP_TABS.map(({ href, label, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </Link>
              );
            })}
          </nav>
        )}

        <div className="min-w-0 flex-1 px-1">
          {/* On desktop top-level pages the active tab already names the page. */}
          <h1
            className={cn(
              "truncate text-[0.95rem] leading-tight font-semibold tracking-tight sm:text-base",
              topLevel && "md:sr-only",
            )}
          >
            {title}
          </h1>
          {subtitle && (
            <p
              className={cn(
                "truncate text-xs leading-tight text-muted-foreground",
                topLevel && "md:sr-only",
              )}
            >
              {subtitle}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {actions}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 rounded-full max-sm:hidden md:size-9"
                aria-label="Search and commands"
                onClick={openCommandPalette}
              >
                <SearchIcon className="size-4.5 md:size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Search &amp; commands <Kbd>⌘K</Kbd>
            </TooltipContent>
          </Tooltip>
          <QueueButton />
          <ThemeToggle />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 rounded-full md:size-9"
                aria-label="Account menu"
              >
                <span className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <UserRoundIcon className="size-4" />
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Signed in as admin
              </DropdownMenuLabel>
              <DropdownMenuItem asChild className="min-h-11 gap-2.5 px-2.5 md:min-h-8">
                <Link href="/stats">
                  <ChartColumnIcon />
                  Stats
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="min-h-11 gap-2.5 px-2.5 md:min-h-8">
                <Link href="/settings">
                  <SettingsIcon />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={openKeyboardHelp}
                className="min-h-11 gap-2.5 px-2.5 md:min-h-8"
              >
                <KeyboardIcon />
                Keyboard shortcuts
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void logout()}
                className="min-h-11 gap-2.5 px-2.5 md:min-h-8"
              >
                <LogOutIcon />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
