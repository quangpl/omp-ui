"use client";

import { type CSSProperties, type ReactNode, useState } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleDotIcon,
  CommandIcon,
  FolderPlusIcon,
  KeyboardIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PauseCircleIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { toast } from "sonner";
import { errorMessage, formatDateTime, formatRelative } from "@/components/board/format";
import { openCommandPalette } from "@/components/command-palette";
import { openKeyboardHelp } from "@/components/keyboard-help";
import { useNewCard } from "@/components/new-card";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { api } from "@/lib/api-client";
import type { Dashboard, DashboardCard } from "@/lib/types";
import { cn } from "@/lib/utils";

const cardHref = (card: { boardId: string; id: string }) =>
  `/b/${encodeURIComponent(card.boardId)}?task=${encodeURIComponent(card.id)}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function SectionTitle({
  id,
  title,
  count,
  action,
}: {
  id: string;
  title: string;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex min-h-8 items-center gap-2">
      <h2 id={id} className="text-sm font-semibold tracking-tight">
        {title}
      </h2>
      {count !== undefined && (
        <span className="rounded-md bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview: greeting, one-line status and the headline numbers

function greeting(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function StatTile({
  label,
  value,
  detail,
  icon,
  tone,
  href,
  style,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  icon: ReactNode;
  tone?: "attention" | "active";
  href?: string;
  style?: CSSProperties;
}) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        {label}
        <span
          aria-hidden="true"
          className={cn(
            "flex size-6 items-center justify-center rounded-md bg-muted [&_svg]:size-3.5",
            tone === "attention" && "bg-destructive/10 text-destructive",
            tone === "active" && "bg-primary/10 text-primary",
          )}
        >
          {icon}
        </span>
      </span>
      <span
        className={cn(
          "mt-1.5 block text-2xl leading-none font-semibold tracking-tight tabular-nums",
          tone === "attention" && "text-destructive",
        )}
      >
        {value}
      </span>
      <span className="mt-1.5 block truncate text-xs text-muted-foreground">{detail}</span>
    </>
  );
  const className = cn(
    "animate-card-in block min-w-0 rounded-xl border bg-card p-3.5 text-card-foreground",
    tone === "attention" && "border-destructive/30",
  );
  return href ? (
    <a
      href={href}
      style={style}
      className={cn(className, "card-lift outline-none focus-visible:ring-3 focus-visible:ring-ring/50")}
    >
      {body}
    </a>
  ) : (
    <div style={style} className={className}>
      {body}
    </div>
  );
}

export function Overview({ dashboard, now }: { dashboard: Dashboard; now: number }) {
  const { totals, queue, boards } = dashboard;
  const attention = boards.reduce((sum, b) => sum + b.attentionCount, 0);
  const failed = dashboard.attention.filter((c) => c.reason === "failed").length;
  const running = queue.running.length;
  const queued = queue.queued.length;
  const open = totals.todo + totals.in_progress;

  const status: string[] = [];
  if (attention > 0) status.push(`${plural(attention, "card")} need${attention === 1 ? "s" : ""} you`);
  if (running > 0) status.push(`${plural(running, "agent")} working`);
  if (queued > 0) status.push(`${queued} queued`);
  if (status.length === 0) {
    status.push(totals.todo > 0 ? `${plural(totals.todo, "card")} ready to start` : "All quiet — nothing waiting on you");
  }

  return (
    <section aria-labelledby="home-overview" className="flex flex-col gap-4">
      <div className="animate-fade-in-soft min-w-0">
        <h2 id="home-overview" className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">
          {greeting(new Date(now).getHours())}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{status.join(" · ")}</p>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatTile
          label="Needs you"
          value={attention}
          detail={
            attention === 0
              ? "No failed or stalled cards"
              : [failed > 0 && `${failed} failed`, attention - failed > 0 && `${attention - failed} stalled`]
                  .filter(Boolean)
                  .join(" · ")
          }
          icon={<TriangleAlertIcon />}
          tone={attention > 0 ? "attention" : undefined}
          href={attention > 0 ? "#home-attention" : undefined}
          style={{ "--stagger": 0 } as CSSProperties}
        />
        <StatTile
          label="Agents"
          value={
            <>
              {running}
              <span className="text-base font-medium text-muted-foreground">/{queue.limit}</span>
            </>
          }
          detail={queued > 0 ? `${queued} waiting for a slot` : running > 0 ? "Working now" : "All slots free"}
          icon={<BotIcon />}
          tone={running > 0 ? "active" : undefined}
          style={{ "--stagger": 1 } as CSSProperties}
        />
        <StatTile
          label="Open cards"
          value={open}
          detail={`${totals.todo} to do · ${totals.in_progress} in progress`}
          icon={<ListTodoIcon />}
          style={{ "--stagger": 2 } as CSSProperties}
        />
        <StatTile
          label="Done"
          value={totals.done}
          detail={`across ${plural(boards.length, "project")}`}
          icon={<CheckCircle2Icon />}
          style={{ "--stagger": 3 } as CSSProperties}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Quick actions

function QuickAction({
  icon,
  label,
  hint,
  shortcut,
  onClick,
  primary,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  shortcut?: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "card-lift group flex min-h-14 min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px",
        primary && "border-primary/30 bg-primary/[0.04]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:text-foreground [&_svg]:size-4",
          primary && "bg-primary text-primary-foreground group-hover:text-primary-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      {shortcut && <Kbd className="hidden md:inline-flex">{shortcut}</Kbd>}
    </button>
  );
}

export function QuickActions({ onCreateProject }: { onCreateProject: () => void }) {
  const openNewCard = useNewCard();
  return (
    <section aria-labelledby="home-quick-actions">
      <SectionTitle id="home-quick-actions" title="Quick actions" />
      <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2 lg:grid-cols-5">
        <QuickAction
          primary
          icon={<PlusIcon />}
          label="New card"
          hint="Brief an agent in any project"
          shortcut="N"
          onClick={() => openNewCard()}
        />
        <QuickAction
          icon={<ZapIcon />}
          label="Card & start agent"
          hint="Skip To do, run right away"
          shortcut="⇧N"
          onClick={() => openNewCard({ start: true })}
        />
        <QuickAction
          icon={<FolderPlusIcon />}
          label="Add project"
          hint="Server folder or Git repo"
          onClick={onCreateProject}
        />
        <QuickAction
          icon={<CommandIcon />}
          label="Jump to…"
          hint="Projects, cards and commands"
          shortcut="⌘K"
          onClick={openCommandPalette}
        />
        <QuickAction
          icon={<KeyboardIcon />}
          label="Shortcuts"
          hint="Every key in one place"
          shortcut="?"
          onClick={openKeyboardHelp}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Getting started

const SETUP_DISMISSED_KEY = "omp-ui:setup-dismissed";

export function useSetupDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(SETUP_DISMISSED_KEY) === "1",
  );
  return [
    dismissed,
    () => {
      localStorage.setItem(SETUP_DISMISSED_KEY, "1");
      setDismissed(true);
    },
  ];
}

export function GettingStarted({
  setup,
  firstBoardId,
  onDismiss,
}: {
  setup: Dashboard["setup"];
  firstBoardId: string | undefined;
  onDismiss: () => void;
}) {
  const openNewCard = useNewCard();
  const steps: { title: string; body: string; done: boolean; action?: ReactNode }[] = [
    { title: "Create a project", body: "A folder on the server or a cloned Git repository.", done: true },
    {
      title: "Write your first card",
      body: "One card per task. Brief it like a teammate: goal, constraints, what “done” means.",
      done: setup.hasCard,
      action: (
        <Button size="sm" onClick={() => openNewCard()}>
          <PlusIcon />
          New card
        </Button>
      ),
    },
    {
      title: "Let an agent work on it",
      body: "Press Start on a card (hover it, right-click it, or press R) — boards with auto-run start on their own.",
      done: setup.hasRun,
      action: (
        <Button size="sm" variant="outline" onClick={() => openNewCard({ start: true })}>
          <ZapIcon />
          Card &amp; start
        </Button>
      ),
    },
    {
      title: "Review and ship",
      body: "Read the agent's summary on the Done card. Comment to ask for changes, or Push / Create PR.",
      done: setup.hasDone,
      action: firstBoardId ? (
        <Button size="sm" variant="outline" asChild>
          <Link href={`/b/${encodeURIComponent(firstBoardId)}`}>
            Open board
            <ArrowRightIcon />
          </Link>
        </Button>
      ) : undefined,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const next = steps.findIndex((s) => !s.done);

  return (
    <section aria-labelledby="home-setup" className="animate-fade-in-soft rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="home-setup" className="text-sm font-semibold tracking-tight">
            Getting started
          </h2>
          <p className="text-xs text-muted-foreground">
            {doneCount} of {steps.length} steps done
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="-mt-1.5 -mr-1.5 size-11 text-muted-foreground md:size-8"
          onClick={onDismiss}
          aria-label="Hide getting started"
        >
          <XIcon />
        </Button>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${(doneCount / steps.length) * 100}%` }}
        />
      </div>
      <ol className="mt-3 flex flex-col">
        {steps.map((step, i) => {
          const current = i === next;
          return (
            <li key={step.title} className="flex items-start gap-3 py-2">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
                  step.done && "border-transparent bg-success/15 text-success",
                  current && "border-primary text-primary",
                )}
              >
                {step.done ? <CheckIcon className="size-3.5" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    step.done && "text-muted-foreground line-through decoration-muted-foreground/40",
                  )}
                >
                  {step.title}
                  <span className="sr-only">{step.done ? " (done)" : current ? " (next)" : ""}</span>
                </p>
                {!step.done && <p className="text-xs text-pretty text-muted-foreground">{step.body}</p>}
                {current && step.action && <div className="mt-2">{step.action}</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Cards that need the user

function AttentionRow({ card, now }: { card: Dashboard["attention"][number]; now: number }) {
  const [busy, setBusy] = useState(false);
  const failed = card.reason === "failed";

  const run = async () => {
    setBusy(true);
    try {
      await api.tasks.run(card.id);
      toast.success(failed ? "Retrying the agent" : "Agent started", { description: card.title });
    } catch (err) {
      toast.error("Couldn't start the agent", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          failed ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        )}
      >
        {failed ? <TriangleAlertIcon className="size-4" /> : <PauseCircleIcon className="size-4" />}
      </span>
      <Link
        href={cardHref(card)}
        className="min-w-0 flex-1 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="block truncate text-sm font-medium" title={card.title}>
          {card.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="max-w-[40%] shrink-0 truncate">{card.boardName}</span>
          <span aria-hidden="true">·</span>
          <span
            className={cn("truncate", failed && "text-destructive")}
            title={card.agentError ?? undefined}
          >
            {failed ? card.agentError || "Agent failed" : "In progress, no agent working"}
          </span>
          {card.openCommentCount > 0 && (
            <span className="inline-flex shrink-0 items-center gap-0.5">
              <MessageSquareIcon className="size-3" aria-hidden="true" />
              {card.openCommentCount}
            </span>
          )}
          <span className="ml-auto hidden shrink-0 sm:inline" title={formatDateTime(card.updatedAt)}>
            {formatRelative(card.updatedAt, now)}
          </span>
        </span>
      </Link>
      <Button
        size="sm"
        variant={failed ? "outline" : "default"}
        className="h-11 shrink-0 md:h-7"
        disabled={busy}
        onClick={() => void run()}
        aria-label={`${failed ? "Retry" : "Start agent on"} “${card.title}”`}
      >
        {busy ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : failed ? (
          <RotateCcwIcon />
        ) : (
          <PlayIcon />
        )}
        {failed ? "Retry" : "Start"}
      </Button>
    </li>
  );
}

export function AttentionList({
  cards,
  total,
  now,
}: {
  cards: Dashboard["attention"];
  total: number;
  now: number;
}) {
  return (
    <section aria-labelledby="home-attention" className="scroll-mt-20">
      <SectionTitle
        id="home-attention"
        title="Needs you"
        count={total}
        action={
          total > cards.length ? (
            <span className="text-xs text-muted-foreground">Showing {cards.length}</span>
          ) : undefined
        }
      />
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {cards.map((card) => (
          <AttentionRow key={card.id} card={card} now={now} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Live agents and recent results (sidebar)

export function AgentsNow({ queue }: { queue: Dashboard["queue"] }) {
  const openNewCard = useNewCard();
  const { running, queued, limit } = queue;
  const busy = Math.min(running.length, limit);

  return (
    <section aria-labelledby="home-agents">
      <SectionTitle
        id="home-agents"
        title="Agents now"
        action={
          <span className="text-xs text-muted-foreground tabular-nums">
            {busy} of {limit} slots busy
          </span>
        }
      />
      <div className="rounded-xl border bg-card p-3">
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: limit }, (_, i) => (
            <span
              key={i}
              className={cn("h-1.5 flex-1 rounded-full bg-muted", i < busy && "bg-primary")}
            />
          ))}
        </div>
        {running.length === 0 && queued.length === 0 ? (
          <div className="pt-3 text-sm text-muted-foreground">
            <p>No agents working.</p>
            <button
              type="button"
              onClick={() => openNewCard({ start: true })}
              className="mt-1 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline md:min-h-0"
            >
              Start one with a new card
              <ArrowRightIcon className="size-3.5" />
            </button>
          </div>
        ) : (
          <ul className="mt-2 flex flex-col">
            {[...running, ...queued].map((entry, i) => {
              const isRunning = entry.state === "running";
              return (
                <li key={entry.taskId}>
                  <Link
                    href={cardHref({ boardId: entry.boardId, id: entry.taskId })}
                    className="-mx-1.5 flex min-h-11 items-center gap-2.5 rounded-lg px-1.5 py-1.5 outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-0"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium tabular-nums",
                        isRunning ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {isRunning ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : i - running.length + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" title={entry.title}>
                        {entry.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {entry.boardName} · {isRunning ? "working" : entry.waitingFor.length > 0 ? `waiting for ${plural(entry.waitingFor.length, "card")}` : "queued"}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function FinishedRow({ card, now }: { card: DashboardCard; now: number }) {
  return (
    <li>
      <Link
        href={cardHref(card)}
        className="-mx-1.5 flex min-h-11 items-center gap-2.5 rounded-lg px-1.5 py-1.5 outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-0"
      >
        <CircleDotIcon className="size-4 shrink-0 text-success" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={card.title}>
            {card.title}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{card.boardName}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0" title={formatDateTime(card.updatedAt)}>
              {formatRelative(card.updatedAt, now)}
            </span>
            {card.commentCount > 0 && (
              <span className="ml-auto inline-flex shrink-0 items-center gap-0.5">
                <MessageSquareIcon className="size-3" aria-hidden="true" />
                {card.commentCount}
              </span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function RecentResults({ cards, now }: { cards: DashboardCard[]; now: number }) {
  return (
    <section aria-labelledby="home-finished">
      <SectionTitle id="home-finished" title="Ready for review" />
      <div className="rounded-xl border bg-card p-3">
        {cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Cards an agent finishes land here, so you can read the summary and ship or send feedback.
          </p>
        ) : (
          <ul className="flex flex-col">
            {cards.map((card) => (
              <FinishedRow key={card.id} card={card} now={now} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
