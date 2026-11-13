"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { toastCardAdded } from "@/components/board/card-added-toast";
import { NewTaskDialog } from "@/components/board/new-task-form";
import { ProjectField } from "@/components/board/project-field";
import { createCardFromText } from "@/hooks/use-board";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api-client";
import { isTypingTarget } from "@/lib/hotkeys";
import { LAST_BOARD_KEY, newCardHref } from "@/lib/new-card-route";
import type { BoardWithCounts } from "@/lib/types";

/** What to prefill in the "New task" form. */
export interface NewCardRequest {
  /** Project to create the card in; defaults to the open board, else the last one used. */
  boardId?: string;
}

type NewCardHandler = (request: NewCardRequest) => void;

interface NewCardContextValue {
  openNewCard: (request?: NewCardRequest) => void;
  register: (boardId: string, handler: NewCardHandler) => () => void;
}

const NewCardContext = createContext<NewCardContextValue | null>(null);

/** True for the "new card" shortcut: `N` or `C`. */
export function isNewCardShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!["n", "N", "c", "C"].includes(event.key)) return false;
  return !isTypingTarget(event.target);
}

/**
 * App-wide "New task": the `N` hotkey and `openNewCard()` from any context menu.
 * The open board page registers itself and handles requests for its board; everywhere else a
 * dialog with a project picker creates the card (on phones: the project's "New task" page).
 */
export function NewCardProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const target = useRef<{ boardId: string; handler: NewCardHandler } | null>(null);
  const [request, setRequest] = useState<NewCardRequest | null>(null);

  const openNewCard = useCallback((next: NewCardRequest = {}) => {
    const current = target.current;
    if (current && (!next.boardId || next.boardId === current.boardId)) current.handler(next);
    else setRequest(next);
  }, []);

  const register = useCallback((boardId: string, handler: NewCardHandler) => {
    const entry = { boardId, handler };
    target.current = entry;
    return () => {
      if (target.current === entry) target.current = null;
    };
  }, []);

  const closeRequest = useCallback(() => setRequest(null), []);

  const signedOut = pathname === "/login";
  useEffect(() => {
    if (signedOut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isNewCardShortcut(event)) return;
      event.preventDefault();
      openNewCard();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openNewCard, signedOut]);

  const value = useMemo(() => ({ openNewCard, register }), [openNewCard, register]);

  return (
    <NewCardContext.Provider value={value}>
      {children}
      <GlobalNewCardDialog request={request} onClose={closeRequest} />
    </NewCardContext.Provider>
  );
}

export function useNewCard(): (request?: NewCardRequest) => void {
  const context = useContext(NewCardContext);
  if (!context) throw new Error("useNewCard must be used inside <NewCardProvider>");
  return context.openNewCard;
}

/** Route "New task" requests for `boardId` (hotkey, menus) to the open board page. */
export function useNewCardTarget(boardId: string, handler: NewCardHandler): void {
  const context = useContext(NewCardContext);
  if (!context) throw new Error("useNewCardTarget must be used inside <NewCardProvider>");
  const { register } = context;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => register(boardId, (request) => handlerRef.current(request)), [register, boardId]);
}

/**
 * "New task" outside a board: same form plus a project picker. Phones skip the dialog and go to
 * the target project's "New task" page, which carries its own picker.
 */
function GlobalNewCardDialog({
  request,
  onClose,
}: {
  request: NewCardRequest | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const isMobile = useIsMobile();
  // Read at request time: a resize mid-load must not flip an open dialog into a navigation.
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const [boards, setBoards] = useState<BoardWithCounts[] | null>(null);
  const [boardId, setBoardId] = useState("");
  const open = request !== null;

  useEffect(() => {
    if (!request) return;
    const navigate = isMobileRef.current;
    let cancelled = false;
    setBoards(null);
    api.boards
      .list()
      .then((list) => {
        if (cancelled) return;
        const wanted = request.boardId ?? localStorage.getItem(LAST_BOARD_KEY);
        const targetId = list.find((b) => b.id === wanted)?.id ?? list[0]?.id ?? "";
        if (navigate) {
          onClose();
          if (targetId) {
            router.push(newCardHref(targetId));
          } else {
            toast.error("Create a project first");
            router.push("/");
          }
          return;
        }
        setBoards(list);
        setBoardId(targetId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (navigate) onClose();
        else setBoards([]);
        toast.error("Couldn't load projects", {
          description: err instanceof Error ? err.message : undefined,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [request, onClose, router]);

  const board = boards?.find((b) => b.id === boardId);

  const create = async (text: string) => {
    if (!board) {
      toast.error("Pick a project first");
      return false;
    }
    const task = await createCardFromText(board.id, text);
    if (!task) return false;
    localStorage.setItem(LAST_BOARD_KEY, board.id);
    toastCardAdded(task, {
      boardName: board.name,
      onOpen: () => router.push(`/b/${encodeURIComponent(board.id)}?task=${encodeURIComponent(task.id)}`),
    });
    return true;
  };

  return (
    <NewTaskDialog
      // Never on phones: the request becomes a navigation once projects load.
      open={open && !isMobile}
      onOpenChange={(next) => !next && onClose()}
      projectField={
        <ProjectField boards={boards} value={boardId} onValueChange={setBoardId} onLeave={onClose} />
      }
      onCreate={create}
      boardId={boardId || null}
    />
  );
}
