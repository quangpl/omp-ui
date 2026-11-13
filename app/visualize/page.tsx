"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArmchairIcon,
  Building2Icon,
  ChevronDownIcon,
  CrownIcon,
  FactoryIcon,
  FlameIcon,
  HardHatIcon,
  LifeBuoyIcon,
  ListChecksIcon,
  LockIcon,
  MedalIcon,
  PlayIcon,
  RefreshCwIcon,
  RocketIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StickyNoteIcon,
  TicketIcon,
  TimerIcon,
  TriangleAlertIcon,
  TrophyIcon,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type AchievementId,
  type Activity,
  achievements,
  crewLevel,
  workerIdentity,
  XP_PER_CARD,
} from "@/components/visualize/game";
import { ACTIVITY_ICON } from "@/components/visualize/activity-icons";
import { type LiveWorker, useLiveFloor } from "@/components/visualize/use-live-floor";
import { WorkerAvatar, type WorkerMood } from "@/components/visualize/worker-avatar";
import { useDocumentTitle } from "@/hooks/use-document-title";
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
  type SubagentStatus,
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
const POP_MS = 2_800;
const MAX_HELPERS_SHOWN = 6;

/**
 * Page grid: on xl the floor (crew, desks, trophies) is the flexible main column and the
 * line / help desk / worksites form a sticky right panel; below xl everything stacks, with the
 * panel between the desks and the trophy wall.
 */
const LAYOUT_GRID =
  "grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] xl:grid-rows-[auto_auto_1fr] xl:gap-x-8";
const ASIDE_CLASS =
  "grid min-w-0 content-start gap-8 lg:grid-cols-2 xl:col-start-2 xl:row-span-3 xl:row-start-1 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)] xl:grid-cols-1 xl:self-start xl:overflow-y-auto xl:overscroll-contain xl:pr-1 xl:pb-2";

const DOT_CLASS: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/50",
  in_progress: "bg-primary",
  done: "bg-success",
};

const HELP_REASON: Record<
  AttentionReason,
  { label: string; mood: WorkerMood; variant: "destructive" | "secondary" }
> = {
  failed: { label: "Broke down", mood: "error", variant: "destructive" },
  stalled: { label: "On a break", mood: "sleeping", variant: "secondary" },
};

const ACHIEVEMENT_ICON: Record<AchievementId, React.ComponentType<{ className?: string }>> = {
  "first-card": StickyNoteIcon,
  "first-run": PlayIcon,
  "first-ship": RocketIcon,
  "ten-shipped": MedalIcon,
  "fifty-shipped": CrownIcon,
  "full-house": FlameIcon,
  "multi-project": Building2Icon,
  "all-clear": ShieldCheckIcon,
};

const HELPER_MOOD: Record<SubagentStatus, WorkerMood> = {
  pending: "waiting",
  running: "working",
  completed: "happy",
  failed: "error",
  aborted: "sleeping",
};

/** Before the first live event of a run arrives. */
const CLOCKING_IN: Activity = { icon: "status", label: "Clocking in" };

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

/** Elapsed ms → "0:42", "12:05", "1:02:05". */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
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
  trailing,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  trailing?: React.ReactNode;
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
      {trailing}
    </div>
  );
}

function StatChip({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: "primary" | "destructive" | "gold";
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg bg-background/60 px-3 py-2 ring-1 ring-foreground/5">
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4",
          tone === "primary" && "bg-primary/10 text-primary",
          tone === "destructive" && "bg-destructive/10 text-destructive",
          tone === "gold" && "bg-chart-3/15 text-chart-3",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-lg leading-tight font-semibold tabular-nums">{value}</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
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
      className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted"
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

/** Live shift clock of a worker; ticks on its own so the rest of the page doesn't re-render. */
function ShiftClock({ startedAt }: { startedAt: string }) {
  const now = useNow(1_000);
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums" title="Time on this run">
      <TimerIcon className="size-3.5" />
      {formatClock(now - started)}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// HQ: crew level, stats, badges

interface Pop {
  id: number;
  text: string;
}

function HqBanner({ dashboard, pops }: { dashboard: Dashboard; pops: Pop[] }) {
  const { boards, totals, queue } = dashboard;
  const crew = crewLevel(totals.done);
  const badges = achievements(dashboard);
  const unlocked = badges.filter((b) => b.unlocked).length;
  const attention = boards.reduce((sum, b) => sum + b.attentionCount, 0);
  const ring = `conic-gradient(var(--color-primary) ${crew.progress * 360}deg, var(--color-muted) 0deg)`;

  return (
    <section
      aria-label="Crew headquarters"
      className="@container relative overflow-hidden rounded-2xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5"
    >
      {/* soft floor-plan backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,color-mix(in_oklch,var(--color-foreground)_9%,transparent)_1px,transparent_0)] [background-size:18px_18px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
      />

      <div className="relative grid gap-5 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] @3xl:items-center">
        <div className="flex items-center gap-4">
          <div className="relative shrink-0">
            <div
              className="flex size-20 items-center justify-center rounded-full p-1.5 transition-[background] duration-700"
              style={{ background: ring }}
              role="img"
              aria-label={`Level ${crew.level}, ${Math.round(crew.progress * 100)}% to level ${crew.level + 1}`}
            >
              <div className="flex size-full flex-col items-center justify-center rounded-full bg-card">
                <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Level</span>
                <span className="text-2xl leading-none font-bold tabular-nums">{crew.level}</span>
              </div>
            </div>
            <div aria-live="polite" className="pointer-events-none absolute -top-2 left-full ml-2 grid w-max gap-1">
              {pops.map((pop) => (
                <span
                  key={pop.id}
                  className="animate-xp-pop flex max-w-64 items-center gap-1 rounded-full bg-card px-2.5 py-1 text-xs font-semibold text-chart-3 shadow-md ring-1 ring-chart-3/40"
                >
                  <SparklesIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{pop.text}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Your agent crew</p>
              <p className="truncate text-lg font-semibold tracking-tight">{crew.rank}</p>
            </div>
            <div className="space-y-1">
              <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="Experience to next level"
                aria-valuemin={crew.levelStartXp}
                aria-valuemax={crew.nextLevelXp}
                aria-valuenow={crew.xp}
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-700"
                  style={{ width: `${crew.progress * 100}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                <span className="font-medium text-foreground">{crew.xp.toLocaleString()} XP</span> ·{" "}
                {(crew.nextLevelXp - crew.xp).toLocaleString()} to level {crew.level + 1} · {XP_PER_CARD} XP per
                card shipped
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
          <StatChip
            icon={<HardHatIcon />}
            label="On shift"
            value={
              <>
                {queue.running.length}
                <span className="text-sm font-normal text-muted-foreground"> / {queue.limit}</span>
              </>
            }
            tone={queue.running.length > 0 ? "primary" : undefined}
          />
          <StatChip icon={<TicketIcon />} label="In line" value={queue.queued.length} />
          <StatChip icon={<TrophyIcon />} label="Shipped" value={totals.done} tone="gold" />
          <StatChip
            icon={<LifeBuoyIcon />}
            label="Need help"
            value={attention}
            tone={attention > 0 ? "destructive" : undefined}
          />
        </div>
      </div>

      <div className="relative mt-4 flex flex-wrap items-center gap-1.5 border-t pt-3">
        <span className="mr-1 text-xs font-medium text-muted-foreground tabular-nums">
          Badges {unlocked}/{badges.length}
        </span>
        {badges.map((badge) => {
          const Icon = ACHIEVEMENT_ICON[badge.id];
          return (
            <Tooltip key={badge.id}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  aria-label={`${badge.title}: ${badge.description}${badge.unlocked ? " (unlocked)" : " (locked)"}`}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    badge.unlocked
                      ? "bg-chart-3/15 text-chart-3 ring-chart-3/35"
                      : "bg-muted/60 text-muted-foreground/45 ring-foreground/5",
                  )}
                >
                  {badge.unlocked ? <Icon className="size-4" /> : <LockIcon className="size-3.5" />}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-medium">{badge.title}</span> · {badge.description}
                {!badge.unlocked && " (locked)"}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The floor: one desk per agent slot

function SpeechBubble({ activity }: { activity: Activity }) {
  const Icon = ACTIVITY_ICON[activity.icon];
  return (
    <div
      key={`${activity.icon}:${activity.label}:${activity.detail ?? ""}`}
      className={cn(
        "animate-fade-in-soft relative w-full rounded-lg bg-background px-2.5 py-1.5 text-xs shadow-sm ring-1 ring-foreground/10",
        "after:absolute after:-bottom-1 after:left-1/2 after:size-2 after:-translate-x-1/2 after:rotate-45 after:bg-background after:shadow-[1px_1px_0_0_color-mix(in_oklch,var(--color-foreground)_10%,transparent)]",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-1.5 font-medium",
          activity.icon === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{activity.label}</span>
      </p>
      {activity.detail && (
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={activity.detail}>
          {activity.detail}
        </p>
      )}
    </div>
  );
}

function Helpers({ taskId, worker }: { taskId: string; worker: LiveWorker }) {
  const helpers = Object.values(worker.helpers).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (helpers.length === 0) return null;
  const busy = helpers.filter((h) => h.status === "running" || h.status === "pending").length;
  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-1.5">
        {helpers.slice(0, MAX_HELPERS_SHOWN).map((helper) => (
          <span
            key={helper.id}
            title={`${helper.agent}${helper.description ? ` · ${helper.description}` : ""} · ${helper.status}`}
            className="rounded-full bg-card ring-2 ring-card"
          >
            <WorkerAvatar
              hue={workerIdentity(`${taskId}:${helper.id}`).hue}
              mood={HELPER_MOOD[helper.status]}
              className="size-6"
            />
          </span>
        ))}
      </div>
      <span className="truncate text-xs text-muted-foreground">
        {helpers.length > MAX_HELPERS_SHOWN && `+${helpers.length - MAX_HELPERS_SHOWN} · `}
        {busy > 0
          ? `${busy} helper${busy === 1 ? "" : "s"} working`
          : `${helpers.length} helper${helpers.length === 1 ? "" : "s"} done`}
      </span>
    </div>
  );
}

function Desk({ entry, worker, index }: { entry: QueueEntry; worker: LiveWorker; index: number }) {
  const { name, hue } = workerIdentity(entry.taskId);
  return (
    <li className="animate-card-in" style={{ "--stagger": index } as React.CSSProperties}>
      <Link
        href={cardHref(entry.boardId, entry.taskId)}
        aria-label={`${name} is working on ${entry.title} in ${entry.boardName}`}
        className="card-lift group flex h-full flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-primary/25 outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] motion-reduce:active:scale-100"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="relative flex size-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-primary/60 motion-reduce:animate-none" />
              <span className="relative size-2 rounded-full bg-primary" />
            </span>
            Desk {index + 1}
          </span>
          {worker.startedAt && <ShiftClock startedAt={worker.startedAt} />}
        </div>

        <div className="relative rounded-lg bg-muted/50 px-3 pt-3">
          <SpeechBubble activity={worker.activity ?? CLOCKING_IN} />
          <div className="relative mt-2 flex h-20 items-end justify-center">
            <WorkerAvatar hue={hue} mood="working" className="relative z-0 mb-2 size-16" />
            {/* desk + laptop */}
            <div aria-hidden className="absolute inset-x-2 bottom-0 z-10 h-3 rounded-t-md bg-foreground/15" />
            <div
              aria-hidden
              className="absolute bottom-3 left-[calc(50%+1.4rem)] z-10 h-4 w-6 rounded-t-sm bg-foreground/25 after:absolute after:inset-0.5 after:rounded-[1px] after:bg-primary/50 motion-safe:after:animate-pulse"
            />
          </div>
        </div>

        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 shrink-0 rounded-full" style={{ background: `oklch(0.7 0.13 ${hue})` }} />
            <span className="font-semibold text-foreground">{name}</span>
            <span className="truncate">· {entry.boardName}</span>
          </p>
          <p className="line-clamp-2 text-sm font-medium group-hover:underline group-hover:underline-offset-4">
            {entry.title}
          </p>
        </div>
        <Helpers taskId={entry.taskId} worker={worker} />
      </Link>
    </li>
  );
}

function OpenDesk({ index, lineBlocked }: { index: number; lineBlocked: boolean }) {
  return (
    <li
      className="animate-card-in flex items-center gap-3 rounded-xl border border-dashed p-4 @lg:min-h-56 @lg:flex-col @lg:justify-center @lg:gap-2 @lg:text-center"
      style={{ "--stagger": index } as React.CSSProperties}
    >
      <ArmchairIcon className="size-7 shrink-0 text-muted-foreground/50 @lg:size-8" />
      <div className="min-w-0 space-y-0.5 @lg:space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Desk {index + 1} is open</p>
        <p className="text-xs text-muted-foreground">
          {lineBlocked
            ? "Free — queued cards wait on other cards to finish"
            : "Start a card to fill this desk"}
        </p>
      </div>
    </li>
  );
}

function FloorSection({ dashboard, live }: { dashboard: Dashboard; live: Record<string, LiveWorker> }) {
  const { running, queued, limit } = dashboard.queue;
  const openDesks = Math.max(0, limit - running.length);
  return (
    <section aria-labelledby="viz-floor" className="@container min-w-0">
      <SectionTitle
        id="viz-floor"
        icon={<FactoryIcon />}
        title="The floor"
        description={`${running.length} of ${limit} desks busy · one worker per agent`}
      />
      <ul
        className={cn(
          "grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3",
          running.length + openDesks >= 4 && "@6xl:grid-cols-4",
        )}
      >
        {running.map((entry, i) => (
          <Desk key={entry.taskId} entry={entry} worker={live[entry.taskId] ?? { helpers: {} }} index={i} />
        ))}
        {Array.from({ length: openDesks }, (_, i) => (
          <OpenDesk key={`open-${i}`} index={running.length + i} lineBlocked={queued.length > 0} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The line, the help desk, the trophy wall, the worksites

function RowLink({
  href,
  avatar,
  title,
  meta,
  trailing,
}: {
  href: string;
  avatar: React.ReactNode;
  title: React.ReactNode;
  meta: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-12 items-center gap-3 rounded-lg px-2.5 py-2 transition-[background-color,scale] outline-none hover:bg-muted focus-visible:bg-muted active:scale-[0.99] motion-reduce:active:scale-100"
      >
        {avatar}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{meta}</p>
        </div>
        {trailing}
      </Link>
    </li>
  );
}

/** Side-panel section: always open on lg+, collapsible below so phones can skim the stack. */
function PanelSection({
  id,
  icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = `${id}-body`;
  return (
    <section aria-labelledby={id} className="min-w-0">
      <SectionTitle
        id={id}
        icon={icon}
        title={title}
        description={description}
        trailing={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 text-muted-foreground lg:hidden"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDownIcon
              className={cn("transition-transform duration-200 motion-reduce:transition-none", !open && "-rotate-90")}
            />
          </Button>
        }
      />
      <div id={bodyId} className={cn("animate-fade-in-soft", !open && "hidden lg:block")}>
        {children}
      </div>
    </section>
  );
}

function LineSection({ queue }: { queue: Dashboard["queue"] }) {
  const { queued, planning } = queue;
  return (
    <PanelSection
      id="viz-line"
      icon={<TicketIcon />}
      title="The line"
      description={queued.length > 0 ? `${queued.length} waiting for a desk, in start order` : "Nobody waiting"}
    >
      {queued.length === 0 ? (
        <EmptyNote>No one in line — every started card has a desk.</EmptyNote>
      ) : (
        <Card size="sm" className="gap-0 px-1">
          {planning.length > 0 && (
            <p className="mx-2 mb-1 flex items-center gap-1.5 rounded-md bg-primary/5 px-2 py-1.5 text-xs text-primary">
              <ListChecksIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                Smart queue is ordering {planning.map((p) => p.boardName).join(", ")}
              </span>
            </p>
          )}
          <ol>
            {queued.map((entry, i) => {
              const { name, hue } = workerIdentity(entry.taskId);
              const waiting = entry.waitingFor.length;
              return (
                <RowLink
                  key={entry.taskId}
                  href={cardHref(entry.boardId, entry.taskId)}
                  avatar={<WorkerAvatar hue={hue} mood="waiting" className="size-9" />}
                  title={entry.title}
                  meta={
                    <>
                      {name} · {entry.boardName}
                      {waiting > 0 && ` · needs ${waiting} card${waiting === 1 ? "" : "s"} done first`}
                      {entry.planning && " · being planned"}
                    </>
                  }
                  trailing={
                    <span className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                      {waiting > 0 && <LockIcon className="size-3" />}#{i + 1}
                    </span>
                  }
                />
              );
            })}
          </ol>
        </Card>
      )}
    </PanelSection>
  );
}

function HelpDeskSection({ cards, total }: { cards: Dashboard["attention"]; total: number }) {
  return (
    <PanelSection
      id="viz-help"
      icon={<LifeBuoyIcon />}
      title="Need a hand"
      description={
        total > cards.length ? `Showing ${cards.length} of ${total} workers` : "Failed or stalled — open to retry or resume"
      }
    >
      <Card size="sm" className="gap-0 px-1">
        <ul>
          {cards.map((card) => {
            const reason = HELP_REASON[card.reason];
            const { name, hue } = workerIdentity(card.id);
            const error = card.reason === "failed" && card.agentError ? card.agentError.split("\n", 1)[0] : null;
            return (
              <RowLink
                key={card.id}
                href={cardHref(card.boardId, card.id)}
                avatar={<WorkerAvatar hue={hue} mood={reason.mood} className="size-9" />}
                title={card.title}
                meta={
                  <>
                    {name} · {card.boardName}
                    {error && ` · ${error}`}
                  </>
                }
                trailing={<Badge variant={reason.variant}>{reason.label}</Badge>}
              />
            );
          })}
        </ul>
      </Card>
    </PanelSection>
  );
}

function TrophySection({ cards, now }: { cards: DashboardCard[]; now: number }) {
  return (
    <section aria-labelledby="viz-trophies" className="@container min-w-0">
      <SectionTitle
        id="viz-trophies"
        icon={<TrophyIcon />}
        title="Trophy wall"
        description="Latest cards your workers shipped"
      />
      <ul className="grid gap-2 @lg:grid-cols-2 @4xl:grid-cols-3">
        {cards.map((card, i) => {
          const { name, hue } = workerIdentity(card.id);
          return (
            <li key={card.id} className="animate-card-in" style={{ "--stagger": i } as React.CSSProperties}>
              <Link
                href={cardHref(card.boardId, card.id)}
                className="card-lift flex h-full items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] motion-reduce:active:scale-100"
              >
                <span className="relative shrink-0">
                  <WorkerAvatar hue={hue} mood="happy" animated={false} className="size-10" />
                  <TrophyIcon className="absolute -right-1 -bottom-1 size-4 rounded-full bg-card p-0.5 text-chart-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium">{card.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {name} · {card.boardName} · {formatRelative(card.updatedAt, now)}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-semibold text-chart-3 tabular-nums">+{XP_PER_CARD} XP</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Worksite({ board, crew, now }: { board: DashboardBoard; crew: QueueEntry[]; now: number }) {
  const total = TASK_STATUSES.reduce((sum, s) => sum + board.counts[s], 0);
  const pct = total === 0 ? 0 : Math.round((board.counts.done / total) * 100);
  return (
    <li className="grid gap-2.5 px-3 py-3 first:pt-1 last:pb-1">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/b/${board.id}`}
          className="-my-2 min-w-0 flex-1 truncate py-2 font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
        >
          {board.name}
        </Link>
        {board.attentionCount > 0 && (
          <Badge variant="destructive">
            <LifeBuoyIcon />
            {board.attentionCount}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">{formatRelative(board.lastActivityAt, now)}</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <DistributionBar counts={board.counts} label={board.name} />
        </div>
        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          <span className="font-semibold text-foreground">{pct}%</span> shipped
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {TASK_STATUSES.map((s) => (
            <span key={s} className="flex items-center gap-1.5 tabular-nums">
              <span className={cn("size-2 rounded-full", DOT_CLASS[s])} aria-hidden />
              {STATUS_LABELS[s]} <span className="font-medium text-foreground">{board.counts[s]}</span>
            </span>
          ))}
        </div>
        {crew.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-primary">
            <span className="flex -space-x-1.5">
              {crew.map((entry) => (
                <span key={entry.taskId} className="rounded-full bg-card ring-2 ring-card">
                  <WorkerAvatar hue={workerIdentity(entry.taskId).hue} mood="working" className="size-5" />
                </span>
              ))}
            </span>
            {crew.length} on site
          </span>
        )}
      </div>
    </li>
  );
}

function WorksitesSection({ dashboard, now }: { dashboard: Dashboard; now: number }) {
  return (
    <PanelSection
      id="viz-sites"
      icon={<Building2Icon />}
      title="Worksites"
      description="Your projects, most recently active first"
    >
      <Card size="sm" className="gap-0">
        <ul className="divide-y">
          {dashboard.boards.map((board) => (
            <Worksite
              key={board.id}
              board={board}
              crew={dashboard.queue.running.filter((entry) => entry.boardId === board.id)}
              now={now}
            />
          ))}
        </ul>
      </Card>
    </PanelSection>
  );
}

function LoadingSkeleton() {
  return (
    <div className={LAYOUT_GRID} aria-busy="true" aria-label="Loading the floor">
      <Skeleton className="h-60 w-full rounded-2xl md:h-44 xl:col-start-1 xl:row-start-1" />
      <div className="@container grid gap-3 xl:col-start-1 xl:row-start-2">
        <Skeleton className="h-12 w-56 rounded-lg" />
        <div className="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-56 w-full rounded-xl" />
          ))}
        </div>
      </div>
      <div className={ASIDE_CLASS}>
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="grid gap-3">
            <Skeleton className="h-12 w-48 rounded-lg" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  );
}

function NoProjects() {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
      <WorkerAvatar hue={272} mood="sleeping" className="size-20" />
      <div className="space-y-1">
        <p className="font-medium">The floor is empty</p>
        <p className="text-sm text-muted-foreground">
          Create a project and start a card. Its agent shows up here as a worker.
        </p>
      </div>
      <Button asChild className="h-11 md:h-9">
        <Link href="/">
          <Building2Icon />
          Go to projects
        </Link>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export default function VisualizePage() {
  useDocumentTitle("Visualize");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pops, setPops] = useState<Pop[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(CLOCK_TICK_MS);
  const { live, onEvent } = useLiveFloor(dashboard?.queue.running.map((entry) => entry.taskId) ?? []);
  const seen = useRef<{ finished: Set<string>; level: number } | null>(null);
  const popId = useRef(0);

  const load = useCallback(async () => {
    try {
      setDashboard(await api.dashboard());
      setUpdatedAt(Date.now());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : "Couldn't load the overview.");
    }
  }, []);

  // Celebrate cards shipped (and levels gained) while the page is open.
  useEffect(() => {
    if (!dashboard) return;
    const level = crewLevel(dashboard.totals.done).level;
    const previous = seen.current;
    seen.current = { finished: new Set(dashboard.finished.map((card) => card.id)), level };
    if (!previous) return;
    const fresh: Pop[] = dashboard.finished
      .filter((card) => !previous.finished.has(card.id))
      .map((card) => ({ id: ++popId.current, text: `+${XP_PER_CARD} XP · ${card.title}` }));
    if (level > previous.level) fresh.push({ id: ++popId.current, text: `Level up! Level ${level}` });
    if (fresh.length === 0) return;
    setPops((current) => [...current, ...fresh]);
    const ids = new Set(fresh.map((pop) => pop.id));
    window.setTimeout(() => setPops((current) => current.filter((pop) => !ids.has(pop.id))), POP_MS);
  }, [dashboard]);

  useEffect(() => {
    void load();
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeEvents(
      (event) => {
        onEvent(event);
        if (REFRESH_EVENTS[event.type]) refresh();
      },
      { onReconnect: refresh },
    );
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [load, onEvent]);

  const attentionTotal = dashboard?.boards.reduce((sum, b) => sum + b.attentionCount, 0) ?? 0;

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        title="Visualize"
        subtitle="Your agents at work, live"
        actions={
          <div className="flex items-center gap-2">
            {updatedAt !== null && (
              <span className="hidden items-center gap-1.5 text-xs text-muted-foreground tabular-nums sm:flex">
                <span className="relative flex size-2" aria-hidden>
                  <span className="absolute inset-0 animate-ping rounded-full bg-success/60 motion-reduce:animate-none" />
                  <span className="relative size-2 rounded-full bg-success" />
                </span>
                Live · updated {formatRelative(new Date(updatedAt).toISOString(), now)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-11 active:scale-[0.96] md:size-9"
              aria-label="Refresh"
              title="Refresh"
              disabled={refreshing || dashboard === null}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
            </Button>
          </div>
        }
      />
      <main className="px-safe pb-safe mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
        {loadError && dashboard === null ? (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-16 text-center">
            <WorkerAvatar hue={25} mood="error" className="size-16" />
            <div className="space-y-1">
              <p className="font-medium">Couldn't load the floor</p>
              <p className="text-sm text-muted-foreground">{loadError}</p>
            </div>
            <Button variant="outline" onClick={() => void load()} className="h-11 active:scale-[0.98] md:h-9">
              <RefreshCwIcon />
              Try again
            </Button>
          </div>
        ) : dashboard === null ? (
          <LoadingSkeleton />
        ) : dashboard.boards.length === 0 ? (
          <NoProjects />
        ) : (
          <div className="grid gap-6">
            {loadError && (
              <p
                role="alert"
                className="animate-fade-in-soft flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                <TriangleAlertIcon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Couldn't refresh: {loadError}</span>
              </p>
            )}
            <div className={LAYOUT_GRID}>
              <div className="min-w-0 xl:col-start-1 xl:row-start-1">
                <HqBanner dashboard={dashboard} pops={pops} />
              </div>
              <div className="min-w-0 xl:col-start-1 xl:row-start-2">
                <FloorSection dashboard={dashboard} live={live} />
              </div>
              <aside aria-label="Line, help desk and worksites" className={ASIDE_CLASS}>
                {dashboard.attention.length > 0 && (
                  <HelpDeskSection cards={dashboard.attention} total={attentionTotal} />
                )}
                <LineSection queue={dashboard.queue} />
                <WorksitesSection dashboard={dashboard} now={now} />
              </aside>
              {dashboard.finished.length > 0 && (
                <div className="min-w-0 xl:col-start-1 xl:row-start-3">
                  <TrophySection cards={dashboard.finished} now={now} />
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
