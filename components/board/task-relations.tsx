"use client";

import { type ReactNode, useMemo, useState } from "react";
import { Bot, Clock, ListPlus, ListTree, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, TASK_STATUSES, type Task } from "@/lib/types";
import { StatusDot } from "@/components/board/board-column";
import { DetailSection } from "@/components/board/detail-section";
import { AgentStateBadge } from "@/components/board/task-card";

/** Ids of cards that (directly or transitively) wait for `taskId`; picking one would form a cycle. */
function dependentsOf(taskId: string, cards: Task[]): Set<string> {
  const result = new Set<string>();
  const stack = [taskId];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const card of cards) {
      if (!result.has(card.id) && card.blockedBy.includes(id)) {
        result.add(card.id);
        stack.push(card.id);
      }
    }
  }
  return result;
}

/** One related card: tap to open it. */
function CardRow({
  card,
  onOpen,
  action,
}: {
  card: Task;
  onOpen: (taskId: string) => void;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-center">
      <button
        type="button"
        onClick={() => onOpen(card.id)}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none pressable hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:bg-accent/60 md:min-h-9"
      >
        <StatusDot status={card.status} />
        <span className={cn("min-w-0 flex-1 truncate", card.status === "done" && "text-muted-foreground")}>
          {card.title}
        </span>
        <AgentStateBadge state={card.agentState} />
        <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABELS[card.status]}</span>
      </button>
      {action}
    </li>
  );
}

/**
 * "Runs after": cards that must be Done before this card's agent starts (Task.blockedBy),
 * with a picker over the other cards of the board.
 */
export function DependenciesSection({
  task,
  cards,
  onOpenCard,
  onChange,
}: {
  task: Task;
  /** Every card of the board. */
  cards: Task[];
  onOpenCard: (taskId: string) => void;
  /** Persist a new `blockedBy`; resolves true when saved. */
  onChange: (blockedBy: string[]) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const dependents = useMemo(() => dependentsOf(task.id, cards), [task.id, cards]);
  const candidates = useMemo(
    () =>
      cards
        .filter((card) => card.id !== task.id)
        .sort((a, b) => TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status)),
    [cards, task.id],
  );

  // Unknown ids (deleted cards, other boards) are hidden and dropped on the next save.
  const blockers = task.blockedBy.flatMap((id) => {
    const card = byId.get(id);
    return card && card.id !== task.id ? [card] : [];
  });
  const selected = new Set(blockers.map((card) => card.id));
  const waiting = blockers.filter((card) => card.status !== "done");

  const save = async (next: string[]) => {
    setSaving(true);
    await onChange(next);
    setSaving(false);
  };
  const toggle = (taskId: string, on: boolean) => {
    const current = blockers.map((card) => card.id);
    void save(on ? [...current, taskId] : current.filter((id) => id !== taskId));
  };

  return (
    <DetailSection
      icon={Workflow}
      title="Runs after"
      action={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-11 pressable md:h-8" disabled={saving}>
              <ListPlus />
              {blockers.length > 0 ? "Edit" : "Add"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
            <DropdownMenuLabel>Wait for these cards</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {candidates.length === 0 ? (
              <DropdownMenuItem disabled className="max-md:min-h-11">
                No other cards on this board
              </DropdownMenuItem>
            ) : (
              candidates.map((card) => {
                const cycle = dependents.has(card.id);
                return (
                  <DropdownMenuCheckboxItem
                    key={card.id}
                    className="max-md:min-h-11"
                    checked={selected.has(card.id)}
                    disabled={saving || cycle}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) => toggle(card.id, checked === true)}
                  >
                    <StatusDot status={card.status} />
                    <span className="min-w-0 flex-1 truncate">{card.title}</span>
                    {cycle && (
                      <span className="shrink-0 text-xs text-muted-foreground">waits for this</span>
                    )}
                  </DropdownMenuCheckboxItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {blockers.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No dependencies; the agent can start right away. Add cards to wait for.
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y rounded-lg border">
            {blockers.map((card) => (
              <CardRow
                key={card.id}
                card={card}
                onOpen={onOpenCard}
                action={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0 pressable-icon md:size-8"
                    aria-label={`Stop waiting for ${card.title}`}
                    disabled={saving}
                    onClick={() => toggle(card.id, false)}
                  >
                    <X />
                  </Button>
                }
              />
            ))}
          </ul>
          {waiting.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3.5 shrink-0" />
              The agent waits until these cards are Done.
            </p>
          )}
        </>
      )}
    </DetailSection>
  );
}

/** "Created by the agent on <card>" for cards an agent delegated; nothing otherwise. */
export function CreatedByNote({
  task,
  cards,
  onOpenCard,
}: {
  task: Task;
  cards: Task[];
  onOpenCard: (taskId: string) => void;
}) {
  if (!task.createdByTaskId) return null;
  const creator = cards.find((card) => card.id === task.createdByTaskId);
  return (
    <p className="flex flex-wrap items-center gap-x-1 px-1.5 text-xs text-muted-foreground">
      <Bot className="size-3.5 shrink-0 text-primary" />
      {creator ? (
        <>
          Created by the agent on
          <button
            type="button"
            onClick={() => onOpenCard(creator.id)}
            className="relative rounded text-left font-medium break-words text-foreground underline-offset-2 outline-none after:absolute after:-inset-x-1 after:-inset-y-3 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {creator.title}
          </button>
        </>
      ) : (
        "Created by another card's agent"
      )}
    </p>
  );
}

/** Cards this card's agent created (Task.createdByTaskId === task.id); nothing when none. */
export function DelegatedCards({
  task,
  cards,
  onOpenCard,
}: {
  task: Task;
  cards: Task[];
  onOpenCard: (taskId: string) => void;
}) {
  const delegated = cards.filter((card) => card.createdByTaskId === task.id);
  if (delegated.length === 0) return null;
  return (
    <DetailSection icon={ListTree} title="Delegated cards">
      <ul className="flex flex-col divide-y rounded-lg border">
        {delegated.map((card) => (
          <CardRow key={card.id} card={card} onOpen={onOpenCard} />
        ))}
      </ul>
    </DetailSection>
  );
}
