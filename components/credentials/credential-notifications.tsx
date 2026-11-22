"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellIcon, CircleAlertIcon, InfoIcon, ShieldCheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, formatDateTime, formatRelative } from "@/components/board/format";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api-client";
import type {
  CredentialNotification,
  CredentialNotificationAction,
  CredentialNotificationsResponse,
} from "@/lib/credential-types";
import { notificationPermission } from "@/lib/notifications";
import { cn } from "@/lib/utils";

/** Window event that makes the bell refetch at once (dispatch it after creating/editing/checking credentials). */
export const CREDENTIALS_CHANGED_EVENT = "credentials:changed";

const POLL_MS = 60_000;

// One shared store so the sidebar and header bells poll once between them.
let snapshot: CredentialNotificationsResponse | null = null;
const listeners = new Set<() => void>();
/** Bumped by every applied response; a poll that started before a newer write is dropped. */
let version = 0;
let inflight: Promise<void> | null = null;
let stopPolling: (() => void) | null = null;
/** Ids already seen, so only new error notifications raise a browser notification (null until the first load). */
let seenIds: Set<string> | null = null;
/** Latest router of a mounted consumer, for browser-notification clicks. */
let navigate: ((href: string) => void) | null = null;

function emit(next: CredentialNotificationsResponse) {
  version += 1;
  snapshot = next;
  announceNewErrors(next.notifications);
  for (const listener of listeners) listener();
}

function announceNewErrors(notifications: CredentialNotification[]) {
  const first = seenIds === null;
  seenIds ??= new Set();
  for (const notification of notifications) {
    if (seenIds.has(notification.id)) continue;
    seenIds.add(notification.id);
    if (!first && notification.severity === "error" && !notification.read) showBrowserNotification(notification);
  }
}

function showBrowserNotification(notification: CredentialNotification) {
  if (notificationPermission() !== "granted") return;
  try {
    const shown = new Notification(notification.title, {
      body: notification.message,
      tag: `credential-${notification.id}`,
      icon: "/icon-192.png",
    });
    shown.onclick = (event) => {
      event.preventDefault();
      window.focus();
      const href = "/mcp";
      if (navigate) navigate(href);
      else location.assign(href);
      shown.close();
    };
  } catch {
    // Some browsers (Chrome on Android) refuse page notifications; the bell still shows it.
  }
}

function refresh(): Promise<void> {
  if (inflight) return inflight;
  const started = version;
  inflight = (async () => {
    try {
      const next = await api.credentials.notifications();
      if (started === version) emit(next);
    } catch {
      // Signed out or offline: keep the last list until the next poll.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function startPolling(): () => void {
  void refresh();
  const onVisible = () => {
    if (document.visibilityState === "visible") void refresh();
  };
  const onRefresh = () => void refresh();
  const timer = window.setInterval(onVisible, POLL_MS);
  window.addEventListener("focus", onRefresh);
  window.addEventListener(CREDENTIALS_CHANGED_EVENT, onRefresh);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", onRefresh);
    window.removeEventListener(CREDENTIALS_CHANGED_EVENT, onRefresh);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stopPolling ??= startPolling();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPolling?.();
      stopPolling = null;
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => null;

/** Applies the action locally first so the badge reacts at once; the server's answer then wins. */
async function update(action: CredentialNotificationAction, ids?: string[]) {
  if (snapshot) {
    const targeted = (n: CredentialNotification) => action.endsWith("-all") || (ids ?? []).includes(n.id);
    const notifications = action.startsWith("dismiss")
      ? snapshot.notifications.filter((n) => !targeted(n))
      : snapshot.notifications.map((n) => (targeted(n) ? { ...n, read: true } : n));
    emit({ notifications, unread: notifications.filter((n) => !n.read).length });
  }
  try {
    emit(await api.credentials.updateNotifications(action, ids));
  } catch (err) {
    toast.error("Couldn't update notifications", { description: errorMessage(err) });
    // A poll that started before the optimistic change is dropped; fetch the server's state afresh.
    await inflight;
    await refresh();
  }
}

const markRead = (ids: string[]) => update("read", ids);
const dismiss = (ids: string[]) => update("dismiss", ids);
const markAllRead = () => update("read-all");
const dismissAll = () => update("dismiss-all");

/**
 * Credential health notifications (failing, expired, expiring, untested). Fetched on mount, every
 * 60 s while the tab is visible, on focus and on `credentials:changed`; all consumers share one poll.
 * `data` is null until the first answer.
 */
export function useCredentialNotifications() {
  const data = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const router = useRouter();
  useEffect(() => {
    navigate = (href) => router.push(href);
  }, [router]);
  return { data, refresh, markRead, dismiss, markAllRead, dismissAll };
}

function SeverityIcon({ severity }: { severity: CredentialNotification["severity"] }) {
  if (severity === "error") return <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Error" />;
  if (severity === "warning") {
    return <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-500" aria-label="Warning" />;
  }
  return <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Info" />;
}

/**
 * Bell with the unread count (red when an unread one is an error, amber otherwise); opens the list
 * of credential notifications. Nothing is marked read just by opening it.
 */
export function CredentialNotificationsButton({
  side = "bottom",
  align = "end",
  className,
  onNavigate,
}: {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
  /** A link in the list was followed (e.g. close the phone sidebar sheet). */
  onNavigate?: () => void;
}) {
  const { data } = useCredentialNotifications();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const notifications = data?.notifications ?? [];
  const unread = data?.unread ?? 0;
  const urgent = notifications.some((n) => !n.read && n.severity === "error");
  const label = `Credential notifications, ${unread} unread`;

  const followed = () => {
    setOpen(false);
    onNavigate?.();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("relative size-9 rounded-full active:scale-95", className)}
              aria-label={label}
            >
              <BellIcon className="size-5 md:size-4" />
              {unread > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold text-white tabular-nums md:top-0 md:right-0",
                    urgent ? "bg-destructive" : "bg-amber-500",
                  )}
                >
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side={side} hidden={isMobile || open}>
          Credential notifications
        </TooltipContent>
      </Tooltip>
      <PopoverContent align={align} side={side} className="w-[min(24rem,calc(100vw-2rem))] gap-0 p-0">
        <div className="flex items-center gap-1 border-b px-3 py-2">
          <span className="flex-1 text-sm font-medium">Credentials</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={unread === 0}
            onClick={() => void markAllRead()}
          >
            Mark all read
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={notifications.length === 0}
            onClick={() => void dismissAll()}
          >
            Dismiss all
          </Button>
        </div>
        {!data ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
            <ShieldCheckIcon className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm">All credentials are healthy</p>
            <Link href="/mcp" onClick={followed} className="text-xs text-primary hover:underline">
              Open MCP
            </Link>
          </div>
        ) : (
          <>
            <ul className="max-h-[min(60dvh,24rem)] divide-y overflow-y-auto overscroll-contain">
              {notifications.map((n) => (
                <li key={n.id} className="relative">
                  <Link
                    href="/mcp"
                    onClick={() => {
                      if (!n.read) void markRead([n.id]);
                      followed();
                    }}
                    className="flex gap-2.5 px-3 py-2.5 pr-10 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted"
                  >
                    <SeverityIcon severity={n.severity} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("truncate text-sm", !n.read && "font-medium")}>{n.title}</span>
                        {!n.read && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{n.message}</span>
                      <time dateTime={n.createdAt} title={formatDateTime(n.createdAt)} className="text-[0.7rem] text-muted-foreground">
                        {formatRelative(n.createdAt)}
                      </time>
                    </span>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 right-2 size-7 rounded-full text-muted-foreground"
                    aria-label={`Dismiss "${n.title}"`}
                    onClick={() => void dismiss([n.id])}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            <div className="border-t px-3 py-2">
              <Link href="/mcp" onClick={followed} className="text-xs font-medium text-primary hover:underline">
                Open MCP
              </Link>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
