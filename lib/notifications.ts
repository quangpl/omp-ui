import type { Task, TaskStatus } from "@/lib/types";

/** Browser Web Notifications helpers (client-only; every call is safe during SSR). */

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

/** Ask for permission only while it is still undecided; resolves the resulting state. */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  const current = notificationPermission();
  if (current !== "default") return current;
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationPermission();
  }
}

/**
 * A card just finished: it moved to Done from a known earlier status. An unknown prior status
 * (cards already Done on load, first seen via an event) never counts.
 */
export function isNewCompletion(previous: TaskStatus | undefined, next: Pick<Task, "status">): boolean {
  return previous !== undefined && previous !== "done" && next.status === "done";
}

/**
 * Show "Task completed" for a card; clicking it focuses the tab and runs `onClick`. Null when
 * unsupported, not granted, or the browser refuses page notifications (Chrome on Android).
 */
export function showTaskCompletedNotification(
  task: Pick<Task, "id" | "title">,
  onClick: () => void,
): Notification | null {
  if (notificationPermission() !== "granted") return null;
  try {
    const notification = new Notification("Task completed", {
      body: task.title || "Untitled card",
      tag: `task-done-${task.id}`,
      icon: "/icon.svg",
    });
    notification.onclick = (event) => {
      event.preventDefault();
      window.focus();
      onClick();
      notification.close();
    };
    return notification;
  } catch {
    return null;
  }
}
