"use client";

import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ChartColumn,
  Container,
  FolderKanban,
  Keyboard,
  LayoutGrid,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  Zap,
} from "lucide-react";
import { StatusDot } from "@/components/board/board-column";
import { openKeyboardHelp } from "@/components/keyboard-help";
import { useNewCard } from "@/components/new-card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { compareTasks, useBoardTasks } from "@/hooks/use-board";
import { api } from "@/lib/api-client";
import { isTypingTarget } from "@/lib/hotkeys";
import { STATUS_LABELS, TASK_STATUSES, type BoardWithCounts } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PaletteEntry {
  id: string;
  group: string;
  label: string;
  /** Muted text on the right (column name, hotkey…). */
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

/** 0 = label prefix, 1 = label substring, 2 = hint/group substring, -1 = no match. */
function matchScore(entry: PaletteEntry, query: string): number {
  const label = entry.label.toLowerCase();
  if (label.startsWith(query)) return 0;
  if (label.includes(query)) return 1;
  return `${entry.hint ?? ""} ${entry.group}`.toLowerCase().includes(query) ? 2 : -1;
}

const PALETTE_EVENT = "omp-ui:command-palette";

/** Ask the global palette (mounted in `Providers`) to open. */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(PALETTE_EVENT));
}

/**
 * Global command palette (`⌘K` / `Ctrl+K`, or `/`): jump to any card of the open board,
 * open another project, or run common actions — all from the keyboard.
 */
export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const openNewCard = useNewCard();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [boards, setBoards] = useState<BoardWithCounts[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const signedOut = pathname === "/login";

  // Cards of the currently open board page (empty elsewhere); no extra fetch needed.
  const boardTasks = useBoardTasks(open);

  useEffect(() => {
    if (signedOut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.defaultPrevented &&
        !event.repeat &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(PALETTE_EVENT, onOpen);
    };
  }, [signedOut]);

  // Fresh state per open; refresh the project list in the background (stale one shows instantly).
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    let cancelled = false;
    api.boards
      .list()
      .then((list) => {
        if (!cancelled) setBoards(list);
      })
      .catch(() => {
        // The palette still works with cards and actions; projects just stay stale.
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const go = (href: string) => () => {
      router.push(href);
    };
    const list: PaletteEntry[] = [];
    const cards = [...boardTasks.values()].sort(
      (a, b) => TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status) || compareTasks(a, b),
    );
    for (const task of cards) {
      list.push({
        id: `card:${task.id}`,
        group: "Cards",
        label: task.title,
        hint: STATUS_LABELS[task.status],
        icon: <StatusDot status={task.status} />,
        run: go(`/b/${encodeURIComponent(task.boardId)}?task=${encodeURIComponent(task.id)}`),
      });
    }
    list.push(
      {
        id: "action:new-card",
        group: "Actions",
        label: "New card",
        hint: "N",
        icon: <Plus className="size-4" />,
        run: () => openNewCard(),
      },
      {
        id: "action:new-card-start",
        group: "Actions",
        label: "New card, start agent now",
        hint: "⇧N",
        icon: <Zap className="size-4" />,
        run: () => openNewCard({ start: true }),
      },
      {
        id: "action:theme",
        group: "Actions",
        label: resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon: resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />,
        run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
      },
      {
        id: "action:help",
        group: "Actions",
        label: "Keyboard shortcuts",
        hint: "?",
        icon: <Keyboard className="size-4" />,
        run: () => openKeyboardHelp(),
      },
      {
        id: "go:projects",
        group: "Go to",
        label: "All projects",
        icon: <LayoutGrid className="size-4" />,
        run: go("/"),
      },
      { id: "go:stats", group: "Go to", label: "Stats", icon: <ChartColumn className="size-4" />, run: go("/stats") },
      {
        id: "go:containers",
        group: "Go to",
        label: "Containers",
        hint: "Docker",
        icon: <Container className="size-4" />,
        run: go("/containers"),
      },
      {
        id: "go:settings",
        group: "Go to",
        label: "Settings",
        icon: <Settings className="size-4" />,
        run: go("/settings"),
      },
    );
    for (const board of boards) {
      list.push({
        id: `board:${board.id}`,
        group: "Projects",
        label: board.name,
        hint: board.workdir,
        icon: <FolderKanban className="size-4" />,
        run: go(`/b/${encodeURIComponent(board.id)}`),
      });
    }
    return list;
  }, [boardTasks, boards, openNewCard, resolvedTheme, setTheme, router]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return entries;
    return entries
      .map((entry) => ({ entry, score: matchScore(entry, q) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => a.score - b.score)
      .map(({ entry }) => entry);
  }, [entries, q]);

  const selected = Math.min(index, Math.max(0, visible.length - 1));

  const run = (entry: PaletteEntry) => {
    setOpen(false);
    entry.run();
  };

  const moveSelection = (delta: number) => {
    if (visible.length === 0) return;
    const next = (selected + delta + visible.length) % visible.length;
    setIndex(next);
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Jump to a card or project, or run an action
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const entry = visible[selected];
                if (entry) run(entry);
              }
            }}
            placeholder="Search cards, projects, actions…"
            aria-label="Search cards, projects, actions"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-[min(420px,60dvh)] overflow-y-auto p-1.5">
          {visible.length === 0 && (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">Nothing matches.</p>
          )}
          {visible.map((entry, i) => (
            <Fragment key={entry.id}>
              {entry.group !== visible[i - 1]?.group && (
                <h3 className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground first:pt-1">
                  {entry.group}
                </h3>
              )}
              <button
                type="button"
                data-index={i}
                onClick={() => run(entry)}
                onPointerMove={() => setIndex(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
                  i === selected && "bg-accent text-accent-foreground",
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  {entry.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.hint && (
                  <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
                    {entry.hint}
                  </span>
                )}
              </button>
            </Fragment>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
