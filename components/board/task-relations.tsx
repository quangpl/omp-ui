"use client";

import { type ReactNode } from "react";
import { Bot, ListTree } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, type Task } from "@/lib/types";
import { StatusDot } from "@/components/board/board-column";
import { DetailSection } from "@/components/board/detail-section";
import { AgentStateBadge } from "@/components/board/task-card";

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
