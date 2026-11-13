"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { BoardMenuActions } from "@/components/board/card-context-menu";
import { type BulkKey, isBulkKey } from "@/components/board/bulk-actions";
import { quickActionForKey, runQuickAction } from "@/components/board/quick-actions";
import type { CardSelection } from "@/hooks/use-card-selection";
import { isModalOpen, isTypingTarget } from "@/lib/hotkeys";
import { TASK_STATUSES, type Task, type TaskStatus } from "@/lib/types";

type ColumnIds = Record<TaskStatus, string[]>;

/** Marks the desktop board's root element; ⌘A only selects cards while focus is on the board. */
export const BOARD_ROOT_ATTR = "data-board-root";

export interface BoardHotkeysState {
  /** Card ids per column, in visual order. */
  ids: ColumnIds;
  taskById: Map<string, Task>;
  /** True while a dnd drag is active (keyboard drags use the arrow keys themselves). */
  dragging: boolean;
  selection: CardSelection;
  /** Runs a quick action on many cards (the selection) with one summary toast. */
  runBulk: (tasks: readonly Task[], key: BulkKey) => void;
}

function cardElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
}

/**
 * Focus a card and keep re-asserting focus for a few frames: after a quick action the card can
 * re-mount in another list and the first focused element unmounts.
 */
export function focusCard(id: string): void {
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

/** Opens a card's right-click menu from the keyboard, anchored at the card's bottom-left corner. */
function openCardMenu(id: string): void {
  const el = cardElement(id);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 8,
      clientY: rect.bottom,
    }),
  );
}

async function copyCardLink(boardId: string, taskId: string): Promise<void> {
  const link = `${location.origin}/b/${encodeURIComponent(boardId)}?task=${encodeURIComponent(taskId)}`;
  try {
    await navigator.clipboard.writeText(link);
    toast.success("Link copied");
  } catch {
    toast.error("Couldn't copy link");
  }
}

/**
 * ⌘A belongs to the board only while focus is on it (or nowhere) and no text is selected
 * elsewhere; inputs, the detail panel and page text keep the browser's select-all.
 */
function boardOwnsSelectAll(active: Element | null): boolean {
  if (active && active !== document.body && !active.closest(`[${BOARD_ROOT_ATTR}]`)) return false;
  if (active && active !== document.body) return true;
  const text = window.getSelection();
  return !text || text.isCollapsed;
}

/**
 * ⇧↑/⇧↓: grow or shrink the range between the selection anchor and the focused card (within one
 * column). The anchor defaults to the card focus leaves from.
 */
function extendRange(selection: CardSelection, column: string[], from: number, to: number): void {
  let anchor = selection.anchor.current;
  if (!anchor || !column.includes(anchor)) {
    anchor = column[from];
    selection.anchor.current = anchor;
  }
  const a = column.indexOf(anchor);
  const range = (i: number) => column.slice(Math.min(a, i), Math.max(a, i) + 1);
  const next = new Set(selection.selected);
  for (const id of range(from)) next.delete(id);
  for (const id of range(to)) next.add(id);
  selection.replace(next);
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

/** 1/2/3 jump to the first card of To do / In progress / Done. */
const COLUMN_KEYS: Record<string, TaskStatus> = Object.fromEntries(
  TASK_STATUSES.map((status, i) => [String(i + 1), status]),
);

/**
 * Keyboard control for the desktop board:
 * - Move: ↑/↓ (J/K) previous/next card, ←/→ (H/L) across columns, 1/2/3 first card of To do /
 *   In progress / Done, Home/End first/last card of the column.
 * - Open: Enter (native button), O or E; `.` opens the card's actions menu (⇧F10 natively).
 * - Select: X toggles the focused card, ⇧↑/⇧↓ (⇧J/⇧K) extend the selection within the column,
 *   ⌘A/Ctrl+A selects the focused card's column (every card when none is focused), Esc clears the
 *   selection and, pressed again, drops focus. ⌘/Ctrl/⇧+click toggles a card (see BoardColumn).
 * - Quick actions (see quickActionsFor): R starts/resumes/retries the agent, S stops it, Z reverts
 *   the card to To do, P pushes a Done card to main. They apply to every selected card that offers
 *   them when cards are selected, else to the focused card.
 * - Focused card only: D duplicates, Delete/Backspace asks to delete, Y copies the card's link.
 * Cards never move to an arbitrary column. Quiet while typing, while a menu/dialog is open, on key
 * repeat (except movement), during IME composition and during drags.
 */
export function useBoardHotkeys(state: BoardHotkeysState, actions: BoardMenuActions): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const { ids, taskById, dragging, selection, runBulk } = stateRef.current;
      if (dragging || isTypingTarget(event.target) || isModalOpen()) return;

      const active = document.activeElement;
      const focusedId =
        active instanceof HTMLElement
          ? (active.closest<HTMLElement>("[data-task-id]")?.dataset.taskId ?? null)
          : null;
      const task = focusedId ? taskById.get(focusedId) : undefined;
      const key = event.key;

      // ⌘A / Ctrl+A: the focused card's column, or the whole board.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key.toLowerCase() === "a") {
        if (event.repeat || !boardOwnsSelectAll(active)) return;
        event.preventDefault();
        selection.replace(task ? ids[task.status] : TASK_STATUSES.flatMap((status) => ids[status]));
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const nav = NAV_KEYS[key.length === 1 ? key.toLowerCase() : key];
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
          const to = index + (nav === "next" ? 1 : -1);
          const target = column[to];
          if (!target) return;
          if (event.shiftKey) extendRange(selection, column, index, to);
          focusCard(target);
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

      if (event.repeat) return;
      const act = actionsRef.current;

      const columnKey = event.shiftKey ? undefined : COLUMN_KEYS[key];
      if (columnKey) {
        const first = ids[columnKey][0];
        if (first) {
          event.preventDefault();
          focusCard(first);
        }
        return;
      }

      if (key === "Escape") {
        if (selection.selected.size > 0) {
          event.preventDefault();
          selection.clear();
        } else if (task && active instanceof HTMLElement) {
          event.preventDefault();
          active.blur();
        }
        return;
      }

      const upper = key.toUpperCase();
      if (selection.selected.size > 0 && !event.shiftKey && isBulkKey(upper)) {
        if (upper === "P" && act.pushToMain === null) return;
        event.preventDefault();
        const tasks = [...selection.selected].map((id) => taskById.get(id)).filter((t): t is Task => t !== undefined);
        runBulk(tasks, upper);
        if (task) focusCard(task.id);
        return;
      }

      if (!task) return;
      const quick = quickActionForKey(task, event, { canPush: act.pushToMain !== null });
      if (quick) {
        event.preventDefault();
        void runQuickAction(quick.id, task.id, act);
        focusCard(task.id);
        return;
      }
      switch (key) {
        case "o":
        case "e":
          event.preventDefault();
          act.openCard(task.id);
          return;
        case "x":
          event.preventDefault();
          selection.toggle(task.id);
          return;
        case "Home":
        case "End": {
          event.preventDefault();
          const column = ids[task.status];
          const target = key === "Home" ? column[0] : column[column.length - 1];
          if (target) focusCard(target);
          return;
        }
        case "y":
          event.preventDefault();
          void copyCardLink(act.boardId, task.id);
          return;
        case ".":
          event.preventDefault();
          openCardMenu(task.id);
          return;
        case "d":
          event.preventDefault();
          void act.duplicate(task);
          return;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          act.requestDelete(task);
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
