"use client";

import { useEffect, useRef } from "react";
import type { BoardMenuActions } from "@/components/board/card-context-menu";
import { quickActionForKey, runQuickAction } from "@/components/board/quick-actions";
import { isModalOpen, isTypingTarget } from "@/lib/hotkeys";
import { TASK_STATUSES, type Task, type TaskStatus } from "@/lib/types";

type ColumnIds = Record<TaskStatus, string[]>;

export interface BoardHotkeysState {
  /** Card ids per column, in visual order. */
  ids: ColumnIds;
  taskById: Map<string, Task>;
  /** True while a dnd drag is active (keyboard drags use the arrow keys themselves). */
  dragging: boolean;
}

function cardElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
}

/**
 * Focus a card and keep re-asserting focus for a few frames: after a quick action the card can
 * re-mount in another list and the first focused element unmounts.
 */
function focusCard(id: string): void {
  let tries = 0;
  const tick = () => {
    const el = cardElement(id);
    if (el && document.activeElement !== el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
    if (++tries < 12) requestAnimationFrame(tick);
  };
  tick();
}

type NavDirection = "next" | "prev" | "left" | "right";

const NAV_KEYS: Record<string, NavDirection> = {
  ArrowDown: "next",
  j: "next",
  ArrowUp: "prev",
  k: "prev",
  ArrowLeft: "left",
  h: "left",
  ArrowRight: "right",
  l: "right",
};

/**
 * Keyboard control for the desktop board:
 * - ↑/↓ (or J/K) move between cards, ←/→ (or H/L) across columns, Enter opens the card;
 * - on the focused card: R starts/resumes/retries the agent, S stops it, Z reverts the card to
 *   To do (the card's quick actions; see quickActionsFor), D duplicates, Delete asks to delete,
 *   Esc drops focus. Cards never move to an arbitrary column.
 * Quiet while typing, while a menu/dialog is open, and during drags.
 */
export function useBoardHotkeys(state: BoardHotkeysState, actions: BoardMenuActions): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const { ids, taskById, dragging } = stateRef.current;
      if (dragging || isTypingTarget(event.target) || isModalOpen()) return;

      const active = document.activeElement;
      const focusedId =
        active instanceof HTMLElement
          ? (active.closest<HTMLElement>("[data-task-id]")?.dataset.taskId ?? null)
          : null;
      const task = focusedId ? taskById.get(focusedId) : undefined;

      const key = event.key;
      const nav = NAV_KEYS[key];

      if (nav) {
        event.preventDefault();
        if (!task) {
          // Nothing focused yet: land on the first card of the first non-empty column.
          const first = TASK_STATUSES.map((status) => ids[status][0]).find(Boolean);
          if (first) focusCard(first);
          return;
        }
        const column = ids[task.status];
        const index = column.indexOf(task.id);
        if (nav === "next" || nav === "prev") {
          const target = column[index + (nav === "next" ? 1 : -1)];
          if (target) focusCard(target);
          return;
        }
        // Left/right: nearest non-empty column, keeping the row.
        const dir = nav === "right" ? 1 : -1;
        for (let i = TASK_STATUSES.indexOf(task.status) + dir; i >= 0 && i < TASK_STATUSES.length; i += dir) {
          const target = ids[TASK_STATUSES[i]];
          if (target.length > 0) {
            focusCard(target[Math.max(0, Math.min(index, target.length - 1))]);
            return;
          }
        }
        return;
      }

      if (!task || event.repeat) return;
      const act = actionsRef.current;
      const quick = quickActionForKey(task, event);
      if (quick) {
        event.preventDefault();
        void runQuickAction(quick.id, task.id, act);
        focusCard(task.id);
        return;
      }
      switch (key) {
        case "d":
          event.preventDefault();
          void act.duplicate(task);
          return;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          act.requestDelete(task);
          return;
        case "Escape":
          if (active instanceof HTMLElement) {
            event.preventDefault();
            active.blur();
          }
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
