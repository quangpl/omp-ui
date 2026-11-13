"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Collapsible } from "radix-ui";
import {
  ArrowRightIcon,
  ChartColumnIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  KeyboardIcon,
  LogOutIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  SettingsIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { LogoMark } from "@/components/app-header";
import { TOP_TABS } from "@/components/bottom-tabs";
import { RunningContainersButton, RunningCountBadge } from "@/components/containers/running-containers-button";
import { openCommandPalette } from "@/components/command-palette";
import { CredentialNotificationsButton } from "@/components/credentials/credential-notifications";
import { openKeyboardHelp } from "@/components/keyboard-help";
import { useNewCard } from "@/components/new-card";
import { QueueButton } from "@/components/queue-panel";
import { openRestartServer } from "@/components/restart-server";
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
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GO_SHORTCUTS } from "@/hooks/use-go-hotkeys";
import { api } from "@/lib/api-client";
import type { BoardWithCounts } from "@/lib/types";
import { cn } from "@/lib/utils";

const BOARDS_REFRESH_MS = 30_000;
/** Projects listed before the "All projects" overflow link. */
const MAX_LISTED_BOARDS = 8;

/** Phone-sized (sheet) rows get 44px touch targets and slightly larger text and icons. */
const ROW = "max-md:h-11 max-md:gap-3 max-md:px-3 max-md:text-[0.95rem] max-md:[&_svg]:size-5";

async function logout() {
  try {
    await api.auth.logout();
  } catch {
    // The cookie is cleared server-side when possible; either way we leave the app.
  }
  location.href = "/login";
}

function isActivePath(pathname: string, href: string): boolean {
  // Boards are part of Projects.
  if (href === "/") return pathname === "/" || pathname.startsWith("/b/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** All projects with live counts; refreshed on navigation, focus, and every 30 s while visible. */
function useSidebarBoards(refreshKey: unknown): BoardWithCounts[] | null {
  const [boards, setBoards] = useState<BoardWithCounts[] | null>(null);

  const load = useCallback(async () => {
    try {
      setBoards(await api.boards.list());
    } catch {
      // Keep the last list; an empty one ends the loading skeleton.
      setBoards((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const onFocus = () => void load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(onVisibility, BOARDS_REFRESH_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  return boards;
}

/** `G` `X` hint revealed on row hover / focus (desktop only; the key sequence needs a keyboard). */
function GoHint({ k }: { k: string }) {
  return (
    <KbdGroup
      aria-hidden="true"
      className="ml-auto opacity-0 transition-opacity duration-150 group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 group-data-[collapsible=icon]:hidden max-md:hidden"
    >
      <Kbd className="bg-sidebar-accent">G</Kbd>
      <Kbd className="bg-sidebar-accent">{k}</Kbd>
    </KbdGroup>
  );
}

function TooltipLabel({ label, keys }: { label: string; keys?: string[] }) {
  return (
    <>
      {label}
      {keys && (
        <KbdGroup>
          {keys.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </KbdGroup>
      )}
    </>
  );
}

/** Round icon button for the footer utility row, with a tooltip. */
function FooterIconButton({
  label,
  hint,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const { state, isMobile } = useSidebar();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 rounded-full text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-95 md:size-9"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={state === "collapsed" ? "right" : "top"} hidden={isMobile}>
        <TooltipLabel label={label} keys={hint ? [hint] : undefined} />
      </TooltipContent>
    </Tooltip>
  );
}

/** Neutral letter tile standing in for a project's icon. */
function ProjectTile({ name, active }: { name: string; active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md text-[0.65rem] leading-none font-semibold uppercase ring-1 ring-sidebar-border transition-colors max-md:size-6 max-md:text-xs",
        active
          ? "bg-sidebar-primary text-sidebar-primary-foreground ring-transparent"
          : "bg-sidebar text-sidebar-foreground/70",
      )}
    >
      {name.trim().charAt(0) || "?"}
    </span>
  );
}

function ProjectsGroup({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const { openMobile } = useSidebar();
  const [open, setOpen] = useState(true);
  // Opening the phone sheet refreshes too, so it never shows a stale list.
  const boards = useSidebarBoards(`${pathname}|${openMobile}`);

  let listed = boards ?? [];
  if (listed.length > MAX_LISTED_BOARDS) {
    const active = listed.find((board) => pathname === `/b/${board.id}`);
    listed = listed.slice(0, MAX_LISTED_BOARDS);
    if (active && !listed.includes(active)) listed = [...listed.slice(0, -1), active];
  }
  const overflow = boards ? boards.length - listed.length : 0;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} asChild>
      {/* The rail has no room for names; the Projects nav item covers it there. */}
      <SidebarGroup className="group/collapsible group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel asChild>
          <Collapsible.Trigger className="w-full gap-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground max-md:h-10 max-md:px-3">
            Your projects
            {boards && boards.length > 0 && (
              <span className="ml-1 text-sidebar-foreground/50 tabular-nums">{boards.length}</span>
            )}
            <ChevronRightIcon className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 motion-reduce:transition-none" />
          </Collapsible.Trigger>
        </SidebarGroupLabel>
        <Collapsible.Content>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {boards === null &&
                Array.from({ length: 3 }, (_, i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuSkeleton showIcon className="max-md:h-11" />
                  </SidebarMenuItem>
                ))}
              {boards?.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-sidebar-foreground/60 max-md:px-3">No projects yet.</li>
              )}
              {listed.map((board) => {
                const href = `/b/${board.id}`;
                const active = pathname === href;
                const running = board.runningCount;
                const pending = board.counts.todo + board.counts.in_progress;
                return (
                  <SidebarMenuItem key={board.id}>
                    <SidebarMenuButton asChild isActive={active} className={ROW}>
                      <Link
                        href={href}
                        // Distinct from the project's own name so page links stay uniquely named.
                        aria-label={`Project ${board.name}${running > 0 ? `, ${running} running` : ""}`}
                        aria-current={active ? "page" : undefined}
                        title={board.name}
                        onClick={onNavigate}
                      >
                        <ProjectTile name={board.name} active={active} />
                        <span className="min-w-0 flex-1 truncate">{board.name}</span>
                        {running > 0 ? (
                          <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-sidebar-primary tabular-nums">
                            <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />
                            {running}
                          </span>
                        ) : (
                          pending > 0 && (
                            <span className="shrink-0 text-xs text-sidebar-foreground/45 tabular-nums">{pending}</span>
                          )
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              {overflow > 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild className={cn(ROW, "text-sidebar-foreground/65")}>
                    <Link href="/" onClick={onNavigate}>
                      <ArrowRightIcon />
                      <span className="flex-1 truncate">All projects</span>
                      <span className="text-xs tabular-nums">+{overflow}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </Collapsible.Content>
      </SidebarGroup>
    </Collapsible.Root>
  );
}

function AccountMenu() {
  const { isMobile } = useSidebar();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          aria-label="Account menu"
          tooltip="Account"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground max-md:h-14 max-md:px-3"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-foreground/75 ring-1 ring-sidebar-border">
            <UserRoundIcon />
          </span>
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate font-medium">admin</span>
            <span className="truncate text-xs text-sidebar-foreground/60">Signed in</span>
          </span>
          <ChevronsUpDownIcon className="ml-auto text-sidebar-foreground/50" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={isMobile ? "top" : "right"}
        align="end"
        sideOffset={8}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Signed in as admin</DropdownMenuLabel>
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
  );
}

/**
 * The app's left sidebar: brand, primary actions, the live project list, section navigation and
 * global utilities. Desktop: collapsible to an icon rail (⌘/Ctrl+B). Phones: an off-canvas sheet
 * opened from the header, closed again on navigation.
 */
export function AppSidebar() {
  const pathname = usePathname() ?? "/";
  const { isMobile, setOpenMobile, state } = useSidebar();
  const openNewCard = useNewCard();

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  const closeMobile = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:justify-center">
          <Link
            href="/"
            aria-label="AgentMan home"
            onClick={closeMobile}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 ring-sidebar-ring outline-none focus-visible:ring-2 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:p-0"
          >
            <LogoMark className="size-7 group-data-[collapsible=icon]:size-8" />
            <span className="truncate text-[0.95rem] font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
              AgentMan
            </span>
          </Link>
          {isMobile ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-11 rounded-full text-sidebar-foreground/70"
              aria-label="Close menu"
              onClick={() => setOpenMobile(false)}
            >
              <XIcon className="size-5" />
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarTrigger
                  aria-label="Collapse sidebar"
                  className="text-sidebar-foreground/60 hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden"
                />
              </TooltipTrigger>
              <TooltipContent side="right">
                <TooltipLabel label="Collapse sidebar" keys={["⌘", "B"]} />
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={{ children: <TooltipLabel label="New card" keys={["N"]} /> }}
              onClick={() => {
                closeMobile();
                openNewCard();
              }}
              className={cn(
                ROW,
                "bg-sidebar-primary font-medium text-sidebar-primary-foreground shadow-xs transition-[width,height,padding,transform] hover:bg-sidebar-primary/90 hover:text-sidebar-primary-foreground active:scale-[0.98] active:bg-sidebar-primary/85 active:text-sidebar-primary-foreground",
              )}
            >
              <PlusIcon />
              <span className="flex-1">New card</span>
              <Kbd
                aria-hidden="true"
                className="bg-sidebar-primary-foreground/15 text-sidebar-primary-foreground group-data-[collapsible=icon]:hidden max-md:hidden"
              >
                N
              </Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              variant="outline"
              tooltip={{ children: <TooltipLabel label="Search" keys={["⌘", "K"]} /> }}
              onClick={() => {
                closeMobile();
                openCommandPalette();
              }}
              className={cn(ROW, "text-sidebar-foreground/65")}
            >
              <SearchIcon />
              <span className="flex-1">Search</span>
              <KbdGroup aria-hidden="true" className="group-data-[collapsible=icon]:hidden max-md:hidden">
                <Kbd className="bg-sidebar-accent">⌘</Kbd>
                <Kbd className="bg-sidebar-accent">K</Kbd>
              </KbdGroup>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <ProjectsGroup pathname={pathname} onNavigate={closeMobile} />

        <SidebarGroup>
          <SidebarGroupLabel className="max-md:px-3">Navigate</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Main">
              <SidebarMenu className="gap-0.5">
                {TOP_TABS.map(({ href, label, icon: Icon }) => {
                  const active = isActivePath(pathname, href);
                  // Second key of the `G` sequence (the first listed alias wins).
                  const key = GO_SHORTCUTS.find((shortcut) => shortcut.href === href)?.key.toUpperCase();
                  const containers = href === "/containers";
                  return (
                    <SidebarMenuItem key={href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={{ children: <TooltipLabel label={label} keys={key ? ["G", key] : undefined} /> }}
                        className={cn(
                          ROW,
                          "data-active:[&>svg:first-child]:text-sidebar-primary",
                          containers && "pr-9 max-md:pr-12",
                        )}
                      >
                        <Link href={href} aria-current={pathname === href ? "page" : undefined} onClick={closeMobile}>
                          <Icon />
                          <span className="min-w-0 flex-1 truncate">{label}</span>
                          {containers && <RunningCountBadge className="shrink-0 group-data-[collapsible=icon]:hidden" />}
                          {key && <GoHint k={key} />}
                        </Link>
                      </SidebarMenuButton>
                      {containers && (
                        <RunningContainersButton
                          side={isMobile ? "bottom" : "right"}
                          align="start"
                          className="absolute top-1/2 right-1 size-9 min-w-0 -translate-y-1/2 rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden md:size-6"
                        />
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator className="mx-0" />
      <SidebarFooter className="gap-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between gap-0.5 px-0.5 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-0">
          <QueueButton />
          <CredentialNotificationsButton
            side={state === "collapsed" && !isMobile ? "right" : "top"}
            align={state === "collapsed" && !isMobile ? "end" : "center"}
            onNavigate={closeMobile}
            className="size-11 text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:size-9"
          />
          <ThemeToggle className="text-sidebar-foreground/75 hover:bg-sidebar-accent active:scale-95" />
          <FooterIconButton label="Keyboard shortcuts" hint="?" onClick={openKeyboardHelp}>
            <KeyboardIcon className="size-5 md:size-4" />
          </FooterIconButton>
          <FooterIconButton label="Restart server" onClick={openRestartServer}>
            <RotateCwIcon className="size-5 md:size-4" />
          </FooterIconButton>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <AccountMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
