"use client";

import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  Brain,
  ChartColumn,
  Container,
  Copy,
  FolderKanban,
  Keyboard,
  LayoutGrid,
  Link2,
  Moon,
  PanelRight,
  Play,
  Plus,
  RadarIcon,
  Search,
  Settings,
  Square,
  Sun,
} from "lucide-react";
import { StatusDot } from "@/components/board/board-column";
import { errorMessage } from "@/components/board/format";
import { quickActionsFor, type QuickAction, type QuickActionId } from "@/components/board/quick-actions";
import { canShip, shipLabels, shipTask } from "@/components/board/ship-actions";
import { openKeyboardHelp } from "@/components/keyboard-help";
import { useNewCard } from "@/components/new-card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { compareTasks, POSITION_GAP, useBoardTasks } from "@/hooks/use-board";
import { api } from "@/lib/api-client";
import { isTypingTarget, modKeyLabel } from "@/lib/hotkeys";
import { STATUS_LABELS, TASK_STATUSES, type BoardWithCounts, type Task } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PaletteEntry {
  id: string;
  group: string;
  label: string;
  /** Muted text on the right (column name, path…). */
  hint?: string;
  /** Shortcut keys shown on the right; several keys read as a sequence ("G", "P"). */
  keys?: string[];
  icon: ReactNode;
  run: () => void;
  /** Card URL: ⌘/Ctrl+Enter opens it in a new tab. */
  href?: string;
  /** Only listed once the user types (per-card actions of every card). */
  searchOnly?: boolean;
  /** Belongs to the context card group, pinned above everything on an empty query. */
  pinned?: boolean;
  /** Id remembered in Recent when it differs from `id` (same command reachable from two groups). */
  recentId?: string;
  /** Label in the Recent group when `label` needs its group for context ("Stop" → "Stop · title"). */
  recentLabel?: string;
}

/** Letters (any script) and digits; anything else separates words. */
function isWordChar(char: string): boolean {
  return char.toLowerCase() !== char.toUpperCase() || (char >= "0" && char <= "9");
}

/**
 * Tiered match of one lowercase query token in lowercase `text`: prefix (4) > word start (~3) >
 * contiguous substring (~2) > subsequence (<1, only when `fuzzy`); 0 = no match. The fraction
 * favours earlier matches, and subsequences with fewer gaps and more word-start hits.
 */
function tokenScore(text: string, token: string, fuzzy: boolean): number {
  if (text.startsWith(token)) return 4;
  const first = text.indexOf(token);
  if (first >= 0) {
    const position = first / (text.length + 1) / 2;
    for (let at = first; at >= 0; at = text.indexOf(token, at + 1)) {
      if (!isWordChar(text[at - 1])) return 3 - at / (text.length + 1) / 2;
    }
    return 2 - position;
  }
  if (!fuzzy) return 0;
  let from = 0;
  let last = -1;
  let gaps = 0;
  let starts = 0;
  for (const char of token) {
    const found = text.indexOf(char, from);
    if (found < 0) return 0;
    if (last >= 0 && found > last + 1) gaps++;
    if (found === 0 || !isWordChar(text[found - 1])) starts++;
    last = found;
    from = found + 1;
  }
  return 0.5 + (starts / token.length) * 0.4 - Math.min(gaps, 10) * 0.01;
}

/** Sum of per-token scores; every token must match the label (fuzzy) or the hint/group (no fuzzy). */
function matchScore(entry: PaletteEntry, tokens: string[]): number {
  const label = entry.label.toLowerCase();
  const secondary = `${entry.hint ?? ""} ${entry.group}`.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    const score = Math.max(tokenScore(label, token, true), tokenScore(secondary, token, false) / 2);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

const RECENT_KEY = "omp-ui:palette-recent";
const RECENT_LIMIT = 5;
/** Rows skipped by PageUp/PageDown. */
const PAGE_SIZE = 8;

function loadRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function rememberRecent(id: string): void {
  try {
    const next = [id, ...loadRecent().filter((other) => other !== id)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota: the palette just has no Recent group.
  }
}

/** The card the palette acts on: the focused board card, else the card open in the side panel. */
function contextTaskId(): string | null {
  const active = document.activeElement;
  const focused =
    active instanceof HTMLElement ? active.closest<HTMLElement>("[data-task-id]")?.dataset.taskId : undefined;
  return focused ?? new URLSearchParams(window.location.search).get("task");
}

function cardHref(task: Task): string {
  return `/b/${encodeURIComponent(task.boardId)}?task=${encodeURIComponent(task.id)}`;
}

function isAgentActive(task: Task): boolean {
  return task.agentState === "running" || task.agentState === "queued";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const QUICK_ACTION_DONE: Record<Exclude<QuickActionId, "push">, string> = {
  start: "Agent started",
  resume: "Agent resumed",
  retry: "Retrying the agent",
  stop: "Agent stopped",
  revert: "Moved back to To do",
};

const QUICK_ACTION_FAILED: Record<Exclude<QuickActionId, "push">, string> = {
  start: "Couldn't start the agent",
  resume: "Couldn't resume the agent",
  retry: "Couldn't retry the agent",
  stop: "Couldn't stop the agent",
  revert: "Couldn't revert card",
};

function QuickActionIcon({ action }: { action: QuickAction }) {
  const Icon = action.icon;
  return <Icon className={cn("size-4", action.filled && "fill-current")} />;
}

/** Runs `call` for every id in parallel and sums the outcome up in one toast. */
async function runBulk(
  ids: string[],
  call: (id: string) => Promise<unknown>,
  copy: { done: string; failed: string; noun: string },
): Promise<void> {
  const results = await Promise.allSettled(ids.map(call));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const succeeded = ids.length - failures.length;
  if (failures.length === 0) {
    toast.success(`${copy.done} ${plural(succeeded, copy.noun)}`);
  } else if (succeeded === 0) {
    toast.error(`${copy.failed} ${plural(ids.length, copy.noun)}`, {
      description: errorMessage(failures[0].reason),
    });
  } else {
    toast.warning(`${copy.done} ${succeeded} of ${plural(ids.length, copy.noun)}`, {
      description: `${failures.length} failed: ${errorMessage(failures[0].reason)}`,
    });
  }
}

const PALETTE_EVENT = "omp-ui:command-palette";

/** Ask the global palette (mounted in `Providers`) to open. */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(PALETTE_EVENT));
}

/**
 * Global command palette (`⌘K` / `Ctrl+K`, or `/`): run the focused card's quick actions, jump to
 * any card of the open board, act on every card at once, open another project, or run common
 * actions — all from the keyboard. Fuzzy matching; recent picks come first.
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
  const [contextId, setContextId] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  /** Push to main labels for the open board, or null when it can't ship (no repo with a remote). */
  const [ship, setShip] = useState<{ boardId: string; prNoun: string; pushTarget: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const signedOut = pathname === "/login";
  const boardMatch = /^\/b\/([^/]+)/.exec(pathname);
  const boardId = boardMatch ? decodeURIComponent(boardMatch[1]) : null;

  // Cards of the currently open board page (empty elsewhere); no extra fetch needed.
  const boardTasks = useBoardTasks(open);
  const tasksRef = useRef(boardTasks);
  tasksRef.current = boardTasks;
  const shipLabelsForBoard = ship && ship.boardId === boardId ? ship : null;

  useEffect(() => {
    if (signedOut) return;
    // Capture the context card before the dialog takes focus away from it.
    const openPalette = () => {
      setContextId(contextTaskId());
      setOpen(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setContextId(contextTaskId());
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
        openPalette();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(PALETTE_EVENT, openPalette);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(PALETTE_EVENT, openPalette);
    };
  }, [signedOut]);

  // Fresh state per open; refresh the project list in the background (stale one shows instantly).
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setRecent(loadRecent());
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

  // Push to main needs a repo with a remote; ask git in the background (the entry appears once known).
  useEffect(() => {
    if (!open || !boardId) return;
    let cancelled = false;
    api.git
      .status(boardId)
      .then((statuses) => {
        if (!cancelled) setShip(canShip(statuses) ? { boardId, ...shipLabels(statuses) } : null);
      })
      .catch(() => {
        if (!cancelled) setShip(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, boardId]);

  const entries = useMemo<PaletteEntry[]>(() => {
    if (!open) return [];
    const go = (href: string) => () => {
      router.push(href);
    };
    const canPush = shipLabelsForBoard !== null;

    /** Re-checks the action against the card's current state (it may have changed since the palette opened). */
    const runCardAction = async (taskId: string, action: QuickAction) => {
      const tasks = tasksRef.current;
      const task = tasks.get(taskId);
      if (!task) {
        toast.error("This card isn't on the board anymore");
        return;
      }
      if (!quickActionsFor(task, { canPush }).some((available) => available.id === action.id)) {
        toast(`${action.label} isn't available for this card anymore`, { description: task.title });
        return;
      }
      if (action.id === "push") {
        if (shipLabelsForBoard) await shipTask("push", taskId, shipLabelsForBoard);
        return;
      }
      try {
        if (action.id === "stop") {
          await api.tasks.stop(taskId);
        } else if (action.id === "revert") {
          // Bottom of To do, like the board's own revert (see useBoard's endPosition).
          let last: number | null = null;
          for (const other of tasks.values()) {
            if (other.status !== "todo" || other.id === taskId) continue;
            if (last === null || other.position > last) last = other.position;
          }
          await api.tasks.update(taskId, { status: "todo", position: (last ?? 0) + POSITION_GAP });
        } else {
          await api.tasks.run(taskId);
        }
        toast.success(QUICK_ACTION_DONE[action.id], { description: task.title });
      } catch (err) {
        toast.error(QUICK_ACTION_FAILED[action.id], { description: errorMessage(err) });
      }
    };

    const copy = (text: string, done: string) => () => {
      navigator.clipboard.writeText(text).then(
        () => toast.success(done),
        (err: unknown) => toast.error("Couldn't copy", { description: errorMessage(err) }),
      );
    };

    const list: PaletteEntry[] = [];
    const cards = [...boardTasks.values()].sort(
      (a, b) => TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status) || compareTasks(a, b),
    );

    const contextTask = contextId ? boardTasks.get(contextId) : undefined;
    if (contextTask) {
      const group = `Card · ${contextTask.title}`;
      const href = cardHref(contextTask);
      for (const action of quickActionsFor(contextTask, { canPush })) {
        list.push({
          id: `quick:${contextTask.id}:${action.id}`,
          group,
          label: action.label,
          recentLabel: `${action.label} · ${contextTask.title}`,
          keys: [action.shortcut],
          icon: <QuickActionIcon action={action} />,
          run: () => void runCardAction(contextTask.id, action),
          pinned: true,
        });
      }
      list.push(
        {
          id: `open:${contextTask.id}`,
          group,
          label: "Open card",
          recentId: `card:${contextTask.id}`,
          recentLabel: contextTask.title,
          keys: ["↵"],
          icon: <PanelRight className="size-4" />,
          href,
          run: go(href),
          pinned: true,
        },
        {
          id: `copy-link:${contextTask.id}`,
          group,
          label: "Copy link",
          recentLabel: `Copy link · ${contextTask.title}`,
          keys: ["Y"],
          icon: <Link2 className="size-4" />,
          run: copy(new URL(href, window.location.origin).toString(), "Link copied"),
          pinned: true,
        },
        {
          id: `copy-title:${contextTask.id}`,
          group,
          label: "Copy title",
          recentLabel: `Copy title · ${contextTask.title}`,
          icon: <Copy className="size-4" />,
          run: copy(contextTask.title, "Title copied"),
          pinned: true,
        },
      );
    }

    for (const task of cards) {
      list.push({
        id: `card:${task.id}`,
        group: "Cards",
        label: task.title,
        hint: STATUS_LABELS[task.status],
        icon: <StatusDot status={task.status} />,
        href: cardHref(task),
        run: go(cardHref(task)),
      });
    }

    if (boardId && cards.length > 0) {
      const active = cards.filter(isAgentActive);
      const todo = cards.filter((task) => task.status === "todo" && !isAgentActive(task));
      if (active.length > 0) {
        list.push({
          id: "bulk:stop-all",
          group: "Board",
          label: `Stop all running agents (${active.length})`,
          icon: <Square className="size-4 fill-current" />,
          run: () =>
            void runBulk(
              active.map((task) => task.id),
              (id) => api.tasks.stop(id),
              { done: "Stopped", failed: "Couldn't stop", noun: "agent" },
            ),
        });
      }
      if (todo.length > 0) {
        list.push({
          id: "bulk:start-todo",
          group: "Board",
          label: `Start all To do cards (${todo.length})`,
          icon: <Play className="size-4 fill-current" />,
          run: () =>
            void runBulk(
              todo.map((task) => task.id),
              (id) => api.tasks.run(id),
              { done: "Started", failed: "Couldn't start", noun: "card" },
            ),
        });
      }
    }

    list.push(
      {
        id: "action:new-card",
        group: "Actions",
        label: "New card",
        keys: ["N"],
        icon: <Plus className="size-4" />,
        run: () => openNewCard(),
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
        keys: ["?"],
        icon: <Keyboard className="size-4" />,
        run: () => openKeyboardHelp(),
      },
      {
        id: "go:projects",
        group: "Go to",
        label: "All projects",
        keys: ["G", "P"],
        icon: <LayoutGrid className="size-4" />,
        run: go("/"),
      },
      {
        id: "go:visualize",
        group: "Go to",
        label: "Visualize",
        keys: ["G", "V"],
        icon: <RadarIcon className="size-4" />,
        run: go("/visualize"),
      },
      {
        id: "go:containers",
        group: "Go to",
        label: "Containers",
        hint: "Docker",
        keys: ["G", "D"],
        icon: <Container className="size-4" />,
        run: go("/containers"),
      },
      {
        id: "go:stats",
        group: "Go to",
        label: "Stats",
        keys: ["G", "T"],
        icon: <ChartColumn className="size-4" />,
        run: go("/stats"),
      },
      {
        id: "go:memory",
        group: "Go to",
        label: "Memory",
        hint: "agentmemory",
        keys: ["G", "M"],
        icon: <Brain className="size-4" />,
        run: go("/memory"),
      },
      {
        id: "go:settings",
        group: "Go to",
        label: "Settings",
        keys: ["G", "S"],
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

    // Typing "stop log" finds "Stop · Fix login redirect" without scrolling to the card first.
    for (const task of cards) {
      if (task.id === contextTask?.id) continue;
      for (const action of quickActionsFor(task, { canPush })) {
        list.push({
          id: `quick:${task.id}:${action.id}`,
          group: "Card actions",
          label: `${action.label} · ${task.title}`,
          hint: STATUS_LABELS[task.status],
          icon: <QuickActionIcon action={action} />,
          run: () => void runCardAction(task.id, action),
          searchOnly: true,
        });
      }
    }
    return list;
  }, [
    open,
    boardTasks,
    boards,
    boardId,
    contextId,
    shipLabelsForBoard,
    openNewCard,
    resolvedTheme,
    setTheme,
    router,
  ]);

  const tokensKey = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const tokens = tokensKey.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      const byId = new Map(entries.map((entry) => [entry.recentId ?? entry.id, entry]));
      const recents: PaletteEntry[] = [];
      for (const id of recent) {
        const entry = byId.get(id);
        if (!entry) continue;
        recents.push({
          ...entry,
          id: `recent:${id}`,
          group: "Recent",
          label: entry.recentLabel ?? entry.label,
          recentId: id,
          pinned: false,
        });
      }
      const pinned = entries.filter((entry) => entry.pinned);
      const rest = entries.filter((entry) => !entry.pinned && !entry.searchOnly);
      return [...pinned, ...recents, ...rest];
    }
    const scored = entries
      .map((entry) => ({ entry, score: matchScore(entry, tokens) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);
    // Keep each group together, groups ordered by their best match.
    const groups = new Map<string, PaletteEntry[]>();
    for (const { entry } of scored) {
      const members = groups.get(entry.group);
      if (members) members.push(entry);
      else groups.set(entry.group, [entry]);
    }
    return [...groups.values()].flat();
  }, [entries, tokensKey, recent]);

  const selected = Math.min(index, Math.max(0, visible.length - 1));
  const selectedEntry = visible[selected];

  const run = (entry: PaletteEntry) => {
    setOpen(false);
    rememberRecent(entry.recentId ?? entry.id);
    entry.run();
  };

  const openInNewTab = (entry: PaletteEntry & { href: string }) => {
    setOpen(false);
    rememberRecent(entry.recentId ?? entry.id);
    window.open(entry.href, "_blank", "noopener");
  };

  const select = (next: number) => {
    setIndex(next);
    requestAnimationFrame(() => {
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const count = visible.length;
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const key = event.key;
    let next: number | null = null;
    if (key === "ArrowDown" || (ctrlOnly && key.toLowerCase() === "n") || (key === "Tab" && !event.shiftKey)) {
      next = count ? (selected + 1) % count : 0;
    } else if (key === "ArrowUp" || (ctrlOnly && key.toLowerCase() === "p") || (key === "Tab" && event.shiftKey)) {
      next = count ? (selected - 1 + count) % count : 0;
    } else if (plain && key === "Home") {
      next = 0;
    } else if (plain && key === "End") {
      next = Math.max(0, count - 1);
    } else if (key === "PageDown") {
      next = Math.min(Math.max(0, count - 1), selected + PAGE_SIZE);
    } else if (key === "PageUp") {
      next = Math.max(0, selected - PAGE_SIZE);
    } else if (key === "Enter") {
      event.preventDefault();
      if (!selectedEntry) return;
      if ((event.metaKey || event.ctrlKey) && selectedEntry.href) {
        openInNewTab({ ...selectedEntry, href: selectedEntry.href });
      } else {
        run(selectedEntry);
      }
      return;
    }
    if (next === null) return;
    event.preventDefault();
    if (count > 0) select(next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Run a card action, jump to a card or project, or run an action
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Search cards, projects, actions…"
            aria-label="Search cards, projects, actions"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-list"
            aria-activedescendant={selectedEntry ? `command-palette-option-${selected}` : undefined}
            className="h-12 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="Results"
          className="max-h-[min(420px,60dvh)] overflow-y-auto p-1.5"
        >
          {visible.length === 0 && (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">Nothing matches.</p>
          )}
          {visible.map((entry, i) => (
            <Fragment key={entry.id}>
              {entry.group !== visible[i - 1]?.group && (
                <h3 className="truncate px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground first:pt-1">
                  {entry.group}
                </h3>
              )}
              <button
                type="button"
                id={`command-palette-option-${i}`}
                role="option"
                aria-selected={i === selected}
                tabIndex={-1}
                data-index={i}
                onClick={(event) => {
                  if ((event.metaKey || event.ctrlKey) && entry.href) openInNewTab({ ...entry, href: entry.href });
                  else run(entry);
                }}
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
                  <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">{entry.hint}</span>
                )}
                {entry.keys && (
                  <KbdGroup className="hidden shrink-0 sm:inline-flex">
                    {entry.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </KbdGroup>
                )}
              </button>
            </Fragment>
          ))}
        </div>
        <div className="hidden items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground sm:flex">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            navigate
          </span>
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd>
            run
          </span>
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd>
            close
          </span>
          {selectedEntry?.href && (
            <span className="ml-auto flex items-center gap-1">
              <KbdGroup>
                <Kbd>{modKeyLabel()}</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>
              new tab
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
