"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { BoardStreamListener } from "@/hooks/use-board";
import { api } from "@/lib/api-client";
import { isNewCompletion, showTaskCompletedNotification } from "@/lib/notifications";
import type { Task, TaskStatus } from "@/lib/types";

/**
 * Browser notification when a card of the open board moves to Done via the live stream (Settings →
 * `taskCompletionNotifications`). Loads and reloads never notify; clicking opens the main page.
 */
export function useTaskCompletionNotifications(
  boardId: string,
  tasks: readonly Task[],
  subscribe: (listener: BoardStreamListener) => () => void,
): void {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const enabledRef = useRef(false);
  /** Last known status per card id: the baseline a `task.updated` is compared against. */
  const statusesRef = useRef(new Map<string, TaskStatus>());

  // Re-read the setting when the tab comes back, so a change made in another tab applies.
  useEffect(() => {
    let active = true;
    const load = () => {
      api.settings
        .get()
        .then((settings) => {
          if (active) enabledRef.current = settings.taskCompletionNotifications;
        })
        .catch(() => {
          if (active) enabledRef.current = false;
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    statusesRef.current = new Map();
  }, [boardId]);

  // Loads and reconnect reloads arrive here (never via events), so they only set the baseline.
  useEffect(() => {
    const statuses = statusesRef.current;
    for (const task of tasks) statuses.set(task.id, task.status);
  }, [tasks]);

  useEffect(() => {
    return subscribe((event) => {
      const statuses = statusesRef.current;
      if (event.type === "task.deleted") {
        statuses.delete(event.taskId);
        return;
      }
      if (event.type !== "task.updated" || event.task.boardId !== boardId) return;
      const previous = statuses.get(event.task.id);
      statuses.set(event.task.id, event.task.status);
      if (enabledRef.current && isNewCompletion(previous, event.task)) {
        showTaskCompletedNotification(event.task, () => routerRef.current.push("/"));
      }
    });
  }, [boardId, subscribe]);
}
