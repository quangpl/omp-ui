"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ActivityIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  FolderKanbanIcon,
  HourglassIcon,
  ListTodoIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, subscribeEvents } from "@/lib/api-client";
import {
  STATUS_LABELS,
  TASK_STATUSES,
  type AttentionReason,
  type Dashboard,
  type DashboardBoard,
  type DashboardCard,
  type QueueEntry,
  type ServerEvent,
  type TaskStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** Events that change anything the dashboard aggregates; chatty run output is ignored. */
const REFRESH_EVENTS: Partial<Record<ServerEvent["type"], true>> = {
  "task.updated": true,
  "task.deleted": true,
  "board.updated": true,
  "board.deleted": true,
  "queue.updated": true,
  "run.updated": true,
};
const REFRESH_DEBOUNCE_MS = 250;
const CLOCK_TICK_MS = 30_000;

const DOT_CLASS: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/50",
  in_progress: "bg-primary",
  done: "bg-success",
};

const REASON_BADGE: Record<AttentionReason, { label: string; variant: "destructive" | "secondary" }> = {
  failed: { label: "Failed", variant: "destructive" },
  stalled: { label: "Stalled", variant: "secondary" },
};

// ---------------------------------------------------------------------------------------------
// Helpers

/** ISO timestamp → "just now", "5m ago", "3h ago", "2d ago". */
function formatRelative(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function cardHref(boardId: string, taskId: string): string {
  return `/b/${boardId}?task=${encodeURIComponent(taskId)}`;
}

/** Current time, re-read every `intervalMs` so relative labels stay fresh. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------------------------------------
// Building blocks

function SectionTitle({
  id,
  icon,
  title,
  description,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4.5">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: "primary" | "destructive";
}) {
  return (
    <Card size="sm" className="min-w-0 gap-1 px-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground [&_svg]:size-4">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <p
        className={cn(
          "text-2xl font-semibold tabular-nums tracking-tight",
          tone === "primary" && "text-primary",
          tone === "destructive" && "text-destructive",
        )}
      >
        {value}
      </p>
      {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
    </Card>
  );
}

/** Proportional todo / in progress / done bar; a muted track when the project has no cards. */
function DistributionBar({ counts, label }: { counts: Record<TaskStatus, number>; label: string }) {
  const total = TASK_STATUSES.reduce((sum, s) => sum + counts[s], 0);
  return (
    <div
      role="img"
      aria-label={
        total === 0
          ? `${label}: no cards`
          : `${label}: ${TASK_STATUSES.map((s) => `${counts[s]} ${STATUS_LABELS[s]}`).join(", ")}`
      }
      className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted"
    >
      {total > 0 &&
        TASK_STATUSES.map((s) =>
          counts[s] > 0 ? (
            <div
              key={s}
              className={cn("h-full transition-[width] duration-500", DOT_CLASS[s])}
              style={{ width: `${(counts[s] / total) * 100}%` }}
            />
          ) : null,
        )}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{children}</p>
  );
}

/** One linked card row: icon, title, project name, optional trailing content. */
function CardRow({
  href,
  icon,
  title,
  boardName,
  note,
  trailing,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  boardName: string;
  note?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      >
        <span className="flex size-6 shrink-0 items-center justify-center [&_svg]:size-4">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {boardName}
            {note && <> · {note}</>}
          </p>
        </div>
        {trailing}
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Sections

function HeroStats({ dashboard }: { dashboard: Dashboard }) {
  const { boards, totals, queue } = dashboard;
  const attention = boards.reduce((sum, b) => sum + b.attentionCount, 0);
  return (
    <section aria-label="Overview" className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      <StatTile icon={<FolderKanbanIcon />} label="Projects" value={boards.length} />
      {TASK_STATUSES.map((s) => (
        <StatTile
          key={s}
          icon={<span className={cn("size-2.5 rounded-full", DOT_CLASS[s])} aria-hidden />}
          label={STATUS_LABELS[s]}
          value={totals[s]}
          detail="cards"
        />
      ))}
      <StatTile
        icon={<BotIcon />}
        label="Agents running"
        value={
          <>
            {queue.running.length}
            <span className="text-base font-normal text-muted-foreground"> / {queue.limit}</span>
          </>
        }
        tone={queue.running.length > 0 ? "primary" : undefined}
      />
      <StatTile icon={<HourglassIcon />} label="Queued" value={queue.queued.length} />
      <StatTile
        icon={<TriangleAlertIcon />}
        label="Needs attention"
        value={attention}
        tone={attention > 0 ? "destructive" : undefined}
      />
    </section>
  );
}

function ActivitySection({ dashboard }: { dashboard: Dashboard }) {
  const { running, queued, limit } = dashboard.queue;
  const idle = running.length === 0 && queued.length === 0;
  return (
    <section aria-labelledby="viz-activity">
      <SectionTitle
        id="viz-activity"
        icon={<ActivityIcon />}
        title="AI activity"
        description={`${running.length} of ${limit} agent slots busy · ${queued.length} queued`}
      />
      {idle ? (
        <EmptyNote>No agents running</EmptyNote>
      ) : (
        <Card size="sm" className="gap-0 px-1">
          {running.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">No agents running</p>
          ) : (
            <ul>
              {running.map((entry) => (
                <CardRow
                  key={entry.taskId}
                  href={cardHref(entry.boardId, entry.taskId)}
                  icon={<Loader2Icon className="animate-spin text-primary" />}
                  title={entry.title}
                  boardName={entry.boardName}
                  trailing={<Badge>Running</Badge>}
                />
              ))}
            </ul>
          )}
          {queued.length > 0 && (
            <>
              <p className="mt-2 border-t px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                Up next, in start order
              </p>
              <ol>
                {queued.map((entry, i) => (
                  <QueuedRow key={entry.taskId} entry={entry} position={i + 1} />
                ))}
              </ol>
            </>
          )}
        </Card>
      )}
    </section>
  );
}

function QueuedRow({ entry, position }: { entry: QueueEntry; position: number }) {
  const waiting = entry.waitingFor.length;
  return (
    <CardRow
      href={cardHref(entry.boardId, entry.taskId)}
      icon={<HourglassIcon className="text-muted-foreground" />}
      title={`${position}. ${entry.title}`}
      boardName={entry.boardName}
      note={waiting > 0 ? `waiting for ${waiting} card${waiting === 1 ? "" : "s"}` : undefined}
      trailing={<Badge variant="outline">Queued</Badge>}
    />
  );
}

function ProjectRow({ board, now }: { board: DashboardBoard; now: number }) {
  return (
    <Card size="sm" className="gap-2.5 px-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/b/${board.id}`}
          className="min-w-0 flex-1 truncate font-medium underline-offset-4 hover:underline"
        >
          {board.name}
        </Link>
        {board.runningCount > 0 && (
          <Badge>
            <Loader2Icon className="animate-spin" />
            {board.runningCount} running
          </Badge>
        )}
        {board.attentionCount > 0 && (
          <Badge variant="destructive">
            <TriangleAlertIcon />
            {board.attentionCount} need{board.attentionCount === 1 ? "s" : ""} attention
          </Badge>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatRelative(board.lastActivityAt, now)}
        </span>
      </div>
      <DistributionBar counts={board.counts} label={board.name} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {TASK_STATUSES.map((s) => (
          <span key={s} className="flex items-center gap-1.5 tabular-nums">
            <span className={cn("size-2 rounded-full", DOT_CLASS[s])} aria-hidden />
            {STATUS_LABELS[s]} <span className="font-medium text-foreground">{board.counts[s]}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

function ProjectsSection({ boards, now }: { boards: DashboardBoard[]; now: number }) {
  return (
    <section aria-labelledby="viz-projects">
      <SectionTitle
        id="viz-projects"
        icon={<FolderKanbanIcon />}
        title="Projects"
        description="Most recently active first"
      />
      <div className="grid gap-3">
        {boards.map((board) => (
          <ProjectRow key={board.id} board={board} now={now} />
        ))}
      </div>
    </section>
  );
}

function AttentionSection({ cards, total }: { cards: Dashboard["attention"]; total: number }) {
  return (
    <section aria-labelledby="viz-attention">
      <SectionTitle
        id="viz-attention"
        icon={<TriangleAlertIcon />}
        title="Needs attention"
        description={
          total > cards.length ? `Showing ${cards.length} of ${total} cards` : "Failed or stalled cards"
        }
      />
      <Card size="sm" className="gap-0 px-1">
        <ul>
          {cards.map((card) => {
            const reason = REASON_BADGE[card.reason];
            return (
              <CardRow
                key={card.id}
                href={cardHref(card.boardId, card.id)}
                icon={
                  <TriangleAlertIcon
                    className={card.reason === "failed" ? "text-destructive" : "text-muted-foreground"}
                  />
                }
                title={card.title}
                boardName={card.boardName}
                trailing={<Badge variant={reason.variant}>{reason.label}</Badge>}
              />
            );
          })}
        </ul>
      </Card>
    </section>
  );
}

function FinishedSection({ cards, now }: { cards: DashboardCard[]; now: number }) {
  return (
    <section aria-labelledby="viz-finished">
      <SectionTitle
        id="viz-finished"
        icon={<CheckCircle2Icon />}
        title="Recently finished"
        description="Done cards an agent worked on"
      />
      <Card size="sm" className="gap-0 px-1">
        <ul>
          {cards.map((card) => (
            <CardRow
              key={card.id}
              href={cardHref(card.boardId, card.id)}
              icon={<CheckCircle2Icon className="text-success" />}
              title={card.title}
              boardName={card.boardName}
              trailing={
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {formatRelative(card.updatedAt, now)}
                </span>
              }
            />
          ))}
        </ul>
      </Card>
    </section>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-8" aria-busy="true" aria-label="Loading overview">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-7 w-1/3" />
          </div>
        ))}
      </div>
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ))}
    </div>
  );
}

function NoProjects() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <ListTodoIcon className="size-6" />
      </span>
      <div className="space-y-1">
        <p className="font-medium">No projects yet</p>
        <p className="text-sm text-muted-foreground">
          Create a project and add a few cards — this page will show how your agents are doing.
        </p>
      </div>
      <Button asChild className="h-11 md:h-9">
        <Link href="/">
          <CircleDotIcon />
          Go to projects
        </Link>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export default function VisualizePage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const now = useNow(CLOCK_TICK_MS);

  const load = useCallback(async () => {
    try {
      setDashboard(await api.dashboard());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : "Could not load the overview.");
    }
  }, []);

  useEffect(() => {
    void load();
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeEvents(
      (event) => {
        if (REFRESH_EVENTS[event.type]) refresh();
      },
      { onReconnect: refresh },
    );
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load]);

  const attentionTotal = dashboard?.boards.reduce((sum, b) => sum + b.attentionCount, 0) ?? 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Visualize" subtitle="All projects and agents, live" />
      <main className="px-safe pb-safe mx-auto w-full max-w-6xl flex-1">
        <div className="px-4 py-5 sm:px-6 sm:py-8">
          {loadError && dashboard === null ? (
            <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
              <p className="text-sm text-muted-foreground">{loadError}</p>
              <Button variant="outline" onClick={() => void load()} className="h-11 md:h-9">
                <RefreshCwIcon />
                Try again
              </Button>
            </div>
          ) : dashboard === null ? (
            <LoadingSkeleton />
          ) : dashboard.boards.length === 0 ? (
            <NoProjects />
          ) : (
            <div className="grid gap-8">
              <HeroStats dashboard={dashboard} />
              <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-start">
                <div className="grid gap-8">
                  <ActivitySection dashboard={dashboard} />
                  {dashboard.attention.length > 0 && (
                    <AttentionSection cards={dashboard.attention} total={attentionTotal} />
                  )}
                  {dashboard.finished.length > 0 && <FinishedSection cards={dashboard.finished} now={now} />}
                </div>
                <ProjectsSection boards={dashboard.boards} now={now} />
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
