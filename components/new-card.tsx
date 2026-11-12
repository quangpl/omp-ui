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
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { NewTaskDialog, type NewTaskInput } from "@/components/board/new-task-form";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createCard } from "@/hooks/use-board";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api-client";
import type { BoardWithCounts } from "@/lib/types";

/** What to prefill in the "New card" form. */
export interface NewCardRequest {
  /** Project to create the card in; defaults to the open board, else the last one used. */
  boardId?: string;
  /** Preset "Start agent now". */
  start?: boolean;
}

type NewCardHandler = (request: NewCardRequest) => void;

interface NewCardContextValue {
  openNewCard: (request?: NewCardRequest) => void;
  register: (boardId: string, handler: NewCardHandler) => () => void;
}

const NewCardContext = createContext<NewCardContextValue | null>(null);

const LAST_BOARD_KEY = "omp-ui:last-board";

/** `N` / `Shift+N` must not fire while the user types or drives a menu/list with the keyboard. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="listbox"], [role="combobox"]',
    ),
  );
}

/** True for the "new card" shortcut: plain `N` (or `Shift+N` to start the agent right away). */
export function isNewCardShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key !== "n" && event.key !== "N") return false;
  return !isTypingTarget(event.target);
}

/**
 * App-wide "New card": the `N` / `Shift+N` hotkey and `openNewCard()` from any context menu.
 * The open board page registers itself and handles requests for its board; everywhere else a
 * dialog with a project picker creates the card.
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

  const signedOut = pathname === "/login";
  useEffect(() => {
    if (signedOut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isNewCardShortcut(event)) return;
      event.preventDefault();
      openNewCard({ start: event.shiftKey });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openNewCard, signedOut]);

  const value = useMemo(() => ({ openNewCard, register }), [openNewCard, register]);

  return (
    <NewCardContext.Provider value={value}>
      {children}
      <GlobalNewCardDialog request={request} onClose={() => setRequest(null)} />
    </NewCardContext.Provider>
  );
}

export function useNewCard(): (request?: NewCardRequest) => void {
  const context = useContext(NewCardContext);
  if (!context) throw new Error("useNewCard must be used inside <NewCardProvider>");
  return context.openNewCard;
}

/** Route "New card" requests for `boardId` (hotkey, menus) to the open board page. */
export function useNewCardTarget(boardId: string, handler: NewCardHandler): void {
  const context = useContext(NewCardContext);
  if (!context) throw new Error("useNewCardTarget must be used inside <NewCardProvider>");
  const { register } = context;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => register(boardId, (request) => handlerRef.current(request)), [register, boardId]);
}

/** "New card" outside a board: same form plus a project picker. */
function GlobalNewCardDialog({
  request,
  onClose,
}: {
  request: NewCardRequest | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [boards, setBoards] = useState<BoardWithCounts[] | null>(null);
  const [boardId, setBoardId] = useState("");
  const open = request !== null;

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setBoards(null);
    api.boards
      .list()
      .then((list) => {
        if (cancelled) return;
        setBoards(list);
        const wanted = request.boardId ?? localStorage.getItem(LAST_BOARD_KEY);
        setBoardId(list.find((b) => b.id === wanted)?.id ?? list[0]?.id ?? "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBoards([]);
        toast.error("Couldn't load projects", {
          description: err instanceof Error ? err.message : undefined,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const create = async (input: NewTaskInput) => {
    const board = boards?.find((b) => b.id === boardId);
    if (!board) {
      toast.error("Pick a project for the card first");
      return false;
    }
    const task = await createCard(board, input);
    if (!task) return false;
    localStorage.setItem(LAST_BOARD_KEY, board.id);
    toast.success(`Card added to “${board.name}”`, {
      action: {
        label: "Open",
        onClick: () => router.push(`/b/${encodeURIComponent(board.id)}?task=${encodeURIComponent(task.id)}`),
      },
    });
    return true;
  };

  const projectField =
    boards === null ? (
      <p className="text-sm text-muted-foreground">Loading projects…</p>
    ) : boards.length === 0 ? (
      <p className="text-sm text-muted-foreground">
        No projects yet.{" "}
        <Link href="/" className="font-medium text-foreground underline underline-offset-4" onClick={onClose}>
          Create a project
        </Link>{" "}
        first.
      </p>
    ) : (
      <div className="flex flex-col gap-2">
        <Label htmlFor="new-card-project">Project</Label>
        <Select value={boardId} onValueChange={setBoardId}>
          <SelectTrigger
            id="new-card-project"
            className="w-full data-[size=default]:h-11 md:data-[size=default]:h-9"
          >
            <SelectValue placeholder="Pick a project" />
          </SelectTrigger>
          <SelectContent>
            {boards.map((board) => (
              <SelectItem key={board.id} value={board.id} className="max-md:min-h-11">
                {board.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );

  return (
    <NewTaskDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      isMobile={isMobile}
      defaultStart={request?.start}
      projectField={projectField}
      onCreate={create}
    />
  );
}
