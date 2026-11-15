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
import { DEFAULT_PUSH_BRANCH } from "@/lib/push-branch";
import type { DashboardBoard, NeedsYouCard, NeedsYouReason } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmptyState, FOCUS_RING, Panel, SectionTitle, cardHref, plural, useEntrance } from "./shared";

/** Rows shown before "Show all". */
const COLLAPSED_ROWS = 6;

/** Per reason: label, icon, icon-bubble tone and the row's left-edge urgency accent. */
const REASON: Record<NeedsYouReason, { label: string; icon: ReactNode; tone: string; accent: string }> = {
  question: {
    label: "Asked you a question",
    icon: <MessageCircleQuestionIcon />,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    accent: "border-l-amber-500/60",
  },
  failed: {
    label: "Agent failed",
    icon: <TriangleAlertIcon />,
    tone: "bg-destructive/10 text-destructive",
    accent: "border-l-destructive/60",
  },
  retrying: {
    label: "Failed, retry scheduled",
    icon: <TimerIcon />,
    tone: "bg-muted text-muted-foreground",
    accent: "border-l-transparent",
  },
  feedback: {
    label: "Open feedback",
    icon: <MessageSquareIcon />,
    tone: "bg-primary/10 text-primary",
    accent: "border-l-primary/40",
  },
  stalled: {
    label: "In progress, no agent working",
    icon: <PauseCircleIcon />,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    accent: "border-l-amber-500/40",
  },
  unpushed: {
    label: "Done, not pushed yet",
    icon: <UploadIcon />,
    tone: "bg-success/10 text-success",
    accent: "border-l-success/50",
  },
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
      return "Finished. Review the summary and push it";
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
  const reason = card.reasons[0];
  const top = REASON[reason];
  // A retry waiting out a quota or usage limit reads as such.
  const labels = card.reasons.map((r) =>
    r === "retrying" && isQuotaError(card.agentError) ? "Waiting for quota" : REASON[r].label,
  );
  const extra = labels.slice(1);
  const pushTarget = shipLabels(board?.git ?? [], board?.pushBranch ?? DEFAULT_PUSH_BRANCH).pushTarget;
  const enter = useEntrance()(index);

  return (
    <li
      data-needs-you-item={card.id}
      style={enter.style}
      className={cn(
        enter.className,
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-l-2 py-2.5 pr-3 pl-2.5 transition-colors focus-within:bg-muted/50 hover:bg-muted/40 has-[a:active]:bg-muted/60",
        top.accent,
        reason === "failed" && "bg-destructive/[0.03]",
      )}
    >
      {/* Text block: icon + two lines. Its flex-basis forces the action cluster onto its own line in narrow rows. */}
      <div className="flex min-w-0 flex-[1_1_15rem] items-center gap-3">
        <span
          aria-hidden="true"
          className={cn("flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-4", top.tone)}
        >
          {top.icon}
        </span>
        <Link
          href={cardHref(card)}
          data-needs-you-link=""
          aria-keyshortcuts="Enter J K"
          className={cn("flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md md:min-h-9", FOCUS_RING)}
        >
          <span className="truncate text-sm leading-5 font-medium" title={card.title}>
            {card.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
            <span className="max-w-56 min-w-0 truncate font-medium text-foreground/70">{card.boardName}</span>
            <span aria-hidden="true">·</span>
            <span
              className={cn(
                "min-w-0 flex-[1_1_6rem] truncate",
                reason === "failed" && "text-destructive",
                reason === "question" && "text-foreground/80",
              )}
              title={reason === "question" ? (card.question ?? undefined) : (card.agentError ?? undefined)}
            >
              {detailFor(card, now)}
            </span>
            {extra.length > 0 && (
              <>
                <span className="hidden shrink-0 gap-1 @3xl/home:flex">
                  {extra.map((label) => (
                    <span key={label} className="rounded-md bg-muted px-1.5 leading-4 whitespace-nowrap">
                      {label}
                    </span>
                  ))}
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 rounded-md bg-muted px-1 font-mono leading-4 tabular-nums @3xl/home:hidden"
                  title={extra.join(", ")}
                >
                  +{extra.length}
                </span>
              </>
            )}
            <span
              className="ml-auto shrink-0 pl-1 font-mono tabular-nums"
              title={formatDateTime(card.updatedAt)}
            >
              {formatRelative(card.updatedAt, now)}
            </span>
          </span>
          <span className="sr-only">. {labels.join(", ")}</span>
        </Link>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {reason === "question" && (
          <Button size="sm" variant="default" className="h-11 min-w-11 md:h-7 md:min-w-0" asChild>
            <Link href={cardHref(card)} tabIndex={-1} aria-label={`Reply to “${card.title}”`}>
              <CornerDownLeftIcon />
              <span className="hidden md:inline">Reply</span>
            </Link>
          </Button>
        )}
        {actions.map((action, i) => {
          const Icon = action.icon;
          const label = action.id === "push" ? "Push" : action.label;
          const primary = i === 0 && reason !== "question";
          return (
            <Button
              key={action.id}
              size="sm"
              variant={primary ? "default" : "ghost"}
              className={cn("h-11 min-w-11 md:h-7 md:min-w-0", !primary && "text-muted-foreground hover:text-foreground")}
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
        const board = boardById.get(card.boardId);
        await shipTask("push", card.id, shipLabels(board?.git ?? [], board?.pushBranch ?? DEFAULT_PUSH_BRANCH));
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
        <div className="animate-fade-in-soft">
          <EmptyState
            tone="success"
            icon={<CircleCheckIcon />}
            title="Nothing needs you"
            hint="Agent questions, failures, open feedback and unpushed work land here."
          />
        </div>
      ) : (
        <Panel className="shadow-diffuse overflow-hidden">
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
            <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground md:min-h-9">
              {cards.length > COLLAPSED_ROWS && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  aria-expanded={expanded}
                  className={cn(
                    "pressable inline-flex min-h-11 items-center gap-1 rounded-md text-xs font-medium text-foreground hover:underline md:min-h-0",
                    FOCUS_RING,
                  )}
                >
                  {expanded ? (
                    "Show fewer"
                  ) : (
                    <>
                      View all <span className="font-mono tabular-nums">{cards.length}</span>
                    </>
                  )}
                  <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
                </button>
              )}
              {total > cards.length && (
                <span className="ml-auto text-right">
                  <span className="font-mono font-medium text-foreground/80 tabular-nums">
                    {cards.length}/{total}
                  </span>{" "}
                  most urgent · the rest are on their boards
                </span>
              )}
            </div>
          )}
        </Panel>
      )}
    </section>
  );
}
