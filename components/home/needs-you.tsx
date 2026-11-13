"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CornerDownLeftIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  PauseCircleIcon,
  TimerIcon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { errorMessage, formatDateTime, formatRelative } from "@/components/board/format";
import { quickActionForKey, quickActionsFor, type QuickAction } from "@/components/board/quick-actions";
import { canShip, shipLabels, shipTask } from "@/components/board/ship-actions";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { api } from "@/lib/api-client";
import { isQuotaError } from "@/lib/quota";
import { isModalOpen, isTypingTarget } from "@/lib/hotkeys";
import type { DashboardBoard, NeedsYouCard, NeedsYouReason } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, Panel, SectionTitle, cardHref, plural, useEntrance } from "./shared";

/** Rows shown before "Show all". */
const COLLAPSED_ROWS = 6;

const REASON: Record<NeedsYouReason, { label: string; icon: ReactNode; tone: string }> = {
  question: {
    label: "Asked you a question",
    icon: <MessageCircleQuestionIcon />,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  failed: { label: "Agent failed", icon: <TriangleAlertIcon />, tone: "bg-destructive/10 text-destructive" },
  retrying: { label: "Failed, retry scheduled", icon: <TimerIcon />, tone: "bg-muted text-muted-foreground" },
  feedback: { label: "Open feedback", icon: <MessageSquareIcon />, tone: "bg-primary/10 text-primary" },
  stalled: {
    label: "In progress, no agent working",
    icon: <PauseCircleIcon />,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  unpushed: { label: "Done, not pushed yet", icon: <UploadIcon />, tone: "bg-success/10 text-success" },
};

/** Second line of a row: what exactly waits on the user. */
function detailFor(card: NeedsYouCard, now: number): string {
  switch (card.reasons[0]) {
    case "question":
      return card.question ?? REASON.question.label;
    case "failed":
      return card.agentError?.split("\n", 1)[0] || REASON.failed.label;
    case "retrying":
      if (isQuotaError(card.agentError)) return `Quota limit · retrying ${card.retryAt ? formatRelative(card.retryAt, now) : "soon"}`;
      return `Retrying ${card.retryAt ? formatRelative(card.retryAt, now) : "soon"}${card.agentError ? ` · ${card.agentError.split("\n", 1)[0]}` : ""}`;
    case "feedback":
      return `${plural(card.openCommentCount, "open comment")} waiting for the agent`;
    case "stalled":
      return "In progress, but no agent is working on it";
    case "unpushed":
      return "Finished — review the summary and push it";
  }
}

function NeedsYouRow({
  card,
  board,
  now,
  index,
  busy,
  onAction,
}: {
  card: NeedsYouCard;
  board: DashboardBoard | undefined;
  now: number;
  index: number;
  busy: boolean;
  onAction: (card: NeedsYouCard, action: QuickAction) => void;
}) {
  const canPush = canShip(board?.git ?? null);
  // Revert needs the board's column positions, so it stays on the board.
  const actions = quickActionsFor(card, { canPush })
    .filter((action) => action.id !== "revert")
    .slice(0, 2);
  const top = REASON[card.reasons[0]];
  // A retry waiting out a quota or usage limit reads as such.
  const labels = card.reasons.map((reason) =>
    reason === "retrying" && isQuotaError(card.agentError) ? "Waiting for quota" : REASON[reason].label,
  );
  const pushTarget = shipLabels(board?.git ?? []).pushTarget;
  const enter = useEntrance()(index);

  return (
    <li
      data-needs-you-item={card.id}
      style={enter.style}
      className={cn(
        enter.className,
        "flex items-center gap-2.5 px-3 py-2 transition-colors focus-within:bg-muted/50 hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5", top.tone)}
      >
        {top.icon}
      </span>
      <Link
        href={cardHref(card)}
        data-needs-you-link=""
        aria-keyshortcuts="Enter J K"
        className={cn("flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md md:min-h-9", FOCUS_RING)}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium" title={card.title}>
            {card.title}
          </span>
          <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline" title={formatDateTime(card.updatedAt)}>
            {formatRelative(card.updatedAt, now)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="max-w-[40%] shrink-0 truncate font-medium text-foreground/70">{card.boardName}</span>
          <span aria-hidden="true">·</span>
          <span
            className={cn("truncate", card.reasons[0] === "failed" && "text-destructive")}
            title={card.reasons[0] === "question" ? (card.question ?? undefined) : (card.agentError ?? undefined)}
          >
            {detailFor(card, now)}
          </span>
          {card.reasons.length > 1 && (
            <span className="ml-auto hidden shrink-0 gap-1 md:flex">
              {card.reasons.slice(1).map((reason, i) => (
                <span key={reason} className="rounded border px-1 text-[11px] leading-4 whitespace-nowrap">
                  {labels[i + 1]}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="sr-only">. {labels.join(", ")}</span>
      </Link>
      <div className="flex shrink-0 items-center gap-1 self-center">
        {card.reasons[0] === "question" && (
          <Button size="sm" variant="outline" className="hidden h-11 sm:inline-flex md:h-7" asChild>
            <Link href={cardHref(card)} tabIndex={-1}>
              <CornerDownLeftIcon />
              Reply
            </Link>
          </Button>
        )}
        {actions.map((action, i) => {
          const Icon = action.icon;
          const label = action.id === "push" ? "Push" : action.label;
          return (
            <Button
              key={action.id}
              size="sm"
              variant={i === 0 && card.reasons[0] !== "question" ? "default" : "outline"}
              className={cn("h-11 min-w-11 md:h-7 md:min-w-0", i > 0 && "hidden sm:inline-flex")}
              disabled={busy}
              onClick={() => onAction(card, action)}
              title={`${action.id === "push" ? `Push to ${pushTarget}` : action.hint} (${action.shortcut})`}
              aria-label={`${label} “${card.title}”`}
              aria-keyshortcuts={action.shortcut}
            >
              {busy ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <Icon className={cn(action.filled && "fill-current")} />
              )}
              <span className="hidden md:inline">{label}</span>
            </Button>
          );
        })}
      </div>
    </li>
  );
}

export function NeedsYouList({
  cards,
  total,
  boards,
  now,
}: {
  cards: NeedsYouCard[];
  total: number;
  boards: DashboardBoard[];
  now: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const boardById = useMemo(() => new Map(boards.map((board) => [board.id, board])), [boards]);
  const shown = expanded ? cards : cards.slice(0, COLLAPSED_ROWS);

  const runAction = async (card: NeedsYouCard, action: QuickAction) => {
    setBusy((prev) => new Set(prev).add(card.id));
    try {
      if (action.id === "push") {
        await shipTask("push", card.id, shipLabels(boardById.get(card.boardId)?.git ?? []));
      } else if (action.id === "stop") {
        await api.tasks.stop(card.id);
        toast("Agent stopped", { description: card.title });
      } else {
        await api.tasks.run(card.id);
        toast.success(action.id === "retry" ? "Retrying the agent" : "Agent started", { description: card.title });
      }
    } catch (err) {
      toast.error(action.id === "stop" ? "Couldn't stop the agent" : "Couldn't start the agent", {
        description: errorMessage(err),
      });
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(card.id);
        return next;
      });
    }
  };
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;

  // J/K (and ↑/↓ inside the list) move between rows; R/S/P run the focused row's quick action.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target) || isModalOpen()) return;
      const list = listRef.current;
      if (!list) return;
      const links = [...list.querySelectorAll<HTMLElement>("[data-needs-you-link]")];
      if (links.length === 0) return;
      const active = document.activeElement;
      const item = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-needs-you-item]") : null;
      const index = item && list.contains(item) ? links.findIndex((link) => item.contains(link)) : -1;
      const idle = active === null || active === document.body;
      const key = event.key;

      const down = (!event.shiftKey && key.toLowerCase() === "j") || (index >= 0 && key === "ArrowDown");
      const up = (!event.shiftKey && key.toLowerCase() === "k") || (index >= 0 && key === "ArrowUp");
      if (down || up) {
        if (index < 0 && !idle) return;
        const next = index < 0 ? (down ? 0 : links.length - 1) : Math.min(links.length - 1, Math.max(0, index + (down ? 1 : -1)));
        event.preventDefault();
        links[next].focus();
        links[next].scrollIntoView({ block: "nearest" });
        return;
      }
      if (index < 0) return;
      const card = cards.find((c) => c.id === item?.dataset.needsYouItem);
      if (!card) return;
      const action = quickActionForKey(card, event, { canPush: canShip(boardById.get(card.boardId)?.git ?? null) });
      if (!action || action.id === "revert") return;
      event.preventDefault();
      void runActionRef.current(card, action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cards, boardById]);

  return (
    <section aria-labelledby="home-needs-you" className="scroll-mt-20">
      <SectionTitle
        id="home-needs-you"
        title="Needs you"
        count={total}
        hint={
          cards.length > 0 ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd> to move, <Kbd>↵</Kbd> to open, <Kbd>R</Kbd>
              <Kbd>S</Kbd>
              <Kbd>P</Kbd> to act
            </span>
          ) : undefined
        }
      />
      {cards.length === 0 ? (
        <Panel className="animate-fade-in-soft flex items-center gap-3 px-4 py-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
            <CircleCheckIcon className="size-4.5" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">Nothing is waiting on you</span>
            <span className="block text-xs text-pretty text-muted-foreground">
              Agent questions, failures, open feedback and unpushed work land here.
            </span>
          </span>
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <ul ref={listRef} className="divide-y" aria-label="Cards that need you">
            {shown.map((card, i) => (
              <NeedsYouRow
                key={card.id}
                card={card}
                board={boardById.get(card.boardId)}
                now={now}
                index={i}
                busy={busy.has(card.id)}
                onAction={(c, action) => void runAction(c, action)}
              />
            ))}
          </ul>
          {(cards.length > COLLAPSED_ROWS || total > cards.length) && (
            <div className="flex min-h-11 items-center gap-2 border-t px-3 text-xs text-muted-foreground md:min-h-9">
              {cards.length > COLLAPSED_ROWS && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  aria-expanded={expanded}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-1 rounded-md font-medium text-foreground hover:underline md:min-h-0",
                    FOCUS_RING,
                  )}
                >
                  {expanded ? "Show fewer" : `View all ${cards.length}`}
                  <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
                </button>
              )}
              {total > cards.length && (
                <span className="ml-auto">
                  {cards.length} most urgent of {total} · the rest are on their boards
                </span>
              )}
            </div>
          )}
        </Panel>
      )}
    </section>
  );
}
