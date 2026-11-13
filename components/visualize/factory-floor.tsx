"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Building2Icon,
  CableIcon,
  CircleDashedIcon,
  CpuIcon,
  CrownIcon,
  DatabaseIcon,
  FactoryIcon,
  FlameIcon,
  GlobeIcon,
  HardDriveIcon,
  HardHatIcon,
  KanbanIcon,
  LifeBuoyIcon,
  LightbulbIcon,
  ListChecksIcon,
  LockIcon,
  MedalIcon,
  PlayIcon,
  PlugZapIcon,
  RocketIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StickyNoteIcon,
  TerminalIcon,
  TicketIcon,
  TimerIcon,
  TrophyIcon,
  UsersIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ACTIVITY_ICON } from "@/components/visualize/activity-icons";
import {
  activitySystem,
  buildLinks,
  type CardLink,
  SYSTEMS,
  type SystemId,
  type SystemLoad,
  systemLoad,
  toolSystem,
} from "@/components/visualize/factory";
import {
  type AchievementId,
  type Activity,
  achievements,
  crewLevel,
  workerIdentity,
  XP_PER_CARD,
} from "@/components/visualize/game";
import type { LiveWorker } from "@/components/visualize/use-live-floor";
import { type Wire, WIRE_STYLE, WireLegend, Wiring } from "@/components/visualize/wiring";
import { WorkerAvatar, type WorkerMood } from "@/components/visualize/worker-avatar";
import {
  STATUS_LABELS,
  TASK_STATUSES,
  type AttentionReason,
  type Dashboard,
  type DashboardBoard,
  type DashboardCard,
  type QueueEntry,
  type QueueSnapshot,
  type SubagentSnapshot,
  type SubagentStatus,
  type TaskStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const MAX_HELPERS_SHOWN = 6;
const MAX_LINKS_SHOWN = 6;

/** Monospace uppercase micro-label of the factory chrome (unit codes, zone names, readouts). */
const MICRO = "font-mono text-[10px] uppercase tracking-[0.12em]";

/** Columns of the production line: intake | assembly | output on xl, output below on lg. */
export const LINE_GRID =
  "grid grid-cols-1 lg:grid-cols-[minmax(14rem,16rem)_minmax(0,1fr)] xl:grid-cols-[minmax(14rem,17rem)_minmax(0,1fr)_minmax(15rem,19rem)]";

/** Opaque tinted fills: machines sit over the wire layer, so their surfaces must hide the wires. */
const PRIMARY_FILL = "bg-[color-mix(in_oklch,var(--color-primary)_5%,var(--color-card))]";
const DESTRUCTIVE_FILL = "bg-[color-mix(in_oklch,var(--color-destructive)_8%,var(--color-card))]";

/** A running card the live feed knows nothing about yet. */
const IDLE_WORKER: LiveWorker = { helpers: {}, contacts: [] };
const NO_LINKS: CardLink[] = [];

/** Before the first live event of a run arrives. */
const CLOCKING_IN: Activity = { icon: "status", label: "Clocking in" };

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

const SYSTEM_ICON: Record<SystemId, React.ComponentType<{ className?: string }>> = {
  model: CpuIcon,
  files: HardDriveIcon,
  shell: TerminalIcon,
  web: GlobeIcon,
  memory: DatabaseIcon,
  board: KanbanIcon,
  advisor: LightbulbIcon,
  helpers: UsersIcon,
};

const SYSTEM_LABEL = Object.fromEntries(SYSTEMS.map((system) => [system.id, system.label])) as Record<
  SystemId,
  string
>;

/** Short chip text of a link seen from either end. */
const LINK_CHIP: Record<CardLink["kind"], { out: string; in: string }> = {
  message: { out: "→ Msg", in: "← Msg from" },
  wait: { out: "⇢ Waits on", in: "⇠ Awaited by" },
  inspect: { out: "→ Read", in: "← Read by" },
  delegate: { out: "→ Delegated", in: "Delegated by" },
  depends: { out: "⇠ Blocks", in: "Needs" },
};

// ---------------------------------------------------------------------------------------------
// Helpers

/** ISO timestamp → "just now", "5m ago", "3h ago", "2d ago". */
export function formatRelative(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Current time, re-read every `intervalMs` so relative labels stay fresh. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
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

/** 0 → "01". */
function unitNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function hueColor(hue: number): string {
  return `oklch(0.7 0.13 ${hue})`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function isBusy(helper: SubagentSnapshot): boolean {
  return helper.status === "running" || helper.status === "pending";
}

function sortedHelpers(worker: LiveWorker): SubagentSnapshot[] {
  return Object.values(worker.helpers).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function helperNode(taskId: string, helperId: string): string {
  return `helper:${taskId}:${helperId}`;
}

/** "Bolt messaged Cog": one link as a sentence, for wire tooltips and screen readers. */
function linkSentence(link: CardLink): string {
  const from = workerIdentity(link.from).name;
  const to = workerIdentity(link.to).name;
  switch (link.kind) {
    case "message":
      return `${from} messaged ${to}`;
    case "wait":
      return `${from} is waiting on ${to}`;
    case "inspect":
      return `${from} read ${to}'s card`;
    case "delegate":
      return `${from} created ${to}'s card`;
    case "depends":
      return `${to} needs ${from} done first`;
  }
}

/**
 * Every wire on the schematic: each station and busy subagent plugged into the system it uses,
 * stations to their subagent modules, and agent-to-agent links between stations / intake crates.
 */
function buildWires(queue: QueueSnapshot, live: Record<string, LiveWorker>, links: CardLink[]): Wire[] {
  const wires: Wire[] = [];
  for (const entry of queue.running) {
    const worker = live[entry.taskId] ?? IDLE_WORKER;
    const { name, hue } = workerIdentity(entry.taskId);
    const station = `station:${entry.taskId}`;
    const system = activitySystem(worker.activity);
    if (system) {
      wires.push({
        from: station,
        to: `system:${system}`,
        kind: "uses",
        hue,
        active: true,
        label: `${name} uses the ${SYSTEM_LABEL[system]}`,
      });
    }
    for (const helper of sortedHelpers(worker).slice(0, MAX_HELPERS_SHOWN)) {
      const node = helperNode(entry.taskId, helper.id);
      const busy = isBusy(helper);
      wires.push({ from: station, to: node, kind: "subagent", active: busy, label: `${name}'s ${helper.agent} subagent` });
      const helperSystem = busy && helper.currentTool ? toolSystem(helper.currentTool) : null;
      if (helperSystem) {
        wires.push({
          from: node,
          to: `system:${helperSystem}`,
          kind: "uses",
          hue: workerIdentity(`${entry.taskId}:${helper.id}`).hue,
          active: true,
          label: `${name}'s ${helper.agent} subagent uses the ${SYSTEM_LABEL[helperSystem]}`,
        });
      }
    }
  }

  const running = new Set(queue.running.map((entry) => entry.taskId));
  const queued = new Set(queue.queued.map((entry) => entry.taskId));
  const nodeOf = (taskId: string) =>
    running.has(taskId) ? `station:${taskId}` : queued.has(taskId) ? `intake:${taskId}` : null;
  for (const link of links) {
    const from = nodeOf(link.from);
    const to = nodeOf(link.to);
    if (!from || !to) continue;
    wires.push({
      from,
      to,
      kind: link.kind,
      active: link.kind === "message" || link.kind === "wait" || link.kind === "inspect",
      label: linkSentence(link),
    });
  }
  return wires;
}

// ---------------------------------------------------------------------------------------------
// Building blocks

/** Header strip of a factory zone: unit code, icon, heading (the section's label) and a note. */
function ZoneHeader({
  id,
  code,
  icon,
  title,
  description,
  className,
}: {
  id: string;
  code: string;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative flex items-start gap-2.5 border-b border-dashed bg-card/75 px-3 py-2.5", className)}>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center border bg-background text-muted-foreground [&_svg]:size-3.5">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn(MICRO, "text-muted-foreground")}>{code}</p>
        <h2 id={id} className="text-sm leading-tight font-semibold tracking-tight">
          {title}
        </h2>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="border border-dashed bg-background p-4 text-center text-sm text-muted-foreground">{children}</p>
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
      className="flex h-2.5 w-full gap-px overflow-hidden border bg-muted"
    >
      {total > 0 &&
        TASK_STATUSES.map((s) =>
          counts[s] > 0 ? (
            <div
              key={s}
              className={cn("h-full transition-[width] duration-500 motion-reduce:transition-none", DOT_CLASS[s])}
              style={{ width: `${(counts[s] / total) * 100}%` }}
            />
          ) : null,
        )}
    </div>
  );
}

/** Live shift clock of a worker; ticks on its own so the rest of the page doesn't re-render. */
function ShiftClock({ startedAt }: { startedAt: string }) {
  const now = useNow(1_000);
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return (
    <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums" title="Time on this run">
      <TimerIcon className="size-3" />
      {formatClock(now - started)}
    </span>
  );
}

/** A card's links to other workers as text chips (the wires are decorative and aria-hidden). */
function LinkChips({ taskId, links }: { taskId: string; links: CardLink[] }) {
  if (links.length === 0) return null;
  const shown = links.slice(0, MAX_LINKS_SHOWN);
  return (
    <ul aria-label="Links to other workers" className="flex flex-wrap gap-1">
      {shown.map((link) => {
        const outgoing = link.from === taskId;
        const other = workerIdentity(outgoing ? link.to : link.from);
        const sentence = linkSentence(link);
        return (
          <li
            key={`${link.kind}:${link.from}:${link.to}`}
            title={sentence}
            className={cn(MICRO, "flex max-w-full items-center gap-1 border bg-background px-1.5 py-0.5 tracking-[0.08em]")}
          >
            <span aria-hidden className="size-1.5 shrink-0" style={{ background: WIRE_STYLE[link.kind].color }} />
            <span aria-hidden className="truncate text-muted-foreground">
              {LINK_CHIP[link.kind][outgoing ? "out" : "in"]}{" "}
              <span className="font-semibold text-foreground">{other.name}</span>
            </span>
            <span className="sr-only">{sentence}</span>
          </li>
        );
      })}
      {links.length > shown.length && (
        <li className={cn(MICRO, "flex items-center px-1 text-muted-foreground")}>+{links.length - shown.length}</li>
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Control room: crew level, stats, badges

/** A floating "+100 XP" / "Level up!" notice next to the level gauge. */
export interface Pop {
  id: number;
  text: string;
}

function Readout({
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
    <div className="flex min-w-0 items-start justify-between gap-2 bg-card p-3">
      <div className="min-w-0">
        <p className={cn(MICRO, "truncate text-muted-foreground")}>{label}</p>
        <p className="mt-1.5 font-mono text-2xl leading-none font-semibold tabular-nums">{value}</p>
      </div>
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center border text-muted-foreground [&_svg]:size-3.5",
          tone === "primary" && "border-primary/40 bg-primary/10 text-primary",
          tone === "destructive" && "border-destructive/40 bg-destructive/10 text-destructive",
          tone === "gold" && "border-chart-3/40 bg-chart-3/15 text-chart-3",
        )}
      >
        {icon}
      </span>
    </div>
  );
}

/** Crew HQ: level gauge with XP pops, stats and badges, in the factory's control-room chrome. */
export function ControlRoom({ dashboard, pops }: { dashboard: Dashboard; pops: Pop[] }) {
  const { boards, totals, queue } = dashboard;
  const crew = crewLevel(totals.done);
  const badges = achievements(dashboard);
  const unlocked = badges.filter((b) => b.unlocked).length;
  const attention = boards.reduce((sum, b) => sum + b.attentionCount, 0);
  const ring = `conic-gradient(var(--color-primary) ${crew.progress * 360}deg, var(--color-muted) 0deg)`;

  return (
    <section aria-label="Crew headquarters" className="@container relative border bg-card">
      <div aria-hidden className="bg-blueprint pointer-events-none absolute inset-0" />

      <div className="relative flex items-center justify-between gap-3 border-b px-3 py-1.5">
        <p className={cn(MICRO, "flex items-center gap-1.5 font-semibold")}>
          <HardHatIcon className="size-3.5" />
          Control room
        </p>
        <p className={cn(MICRO, "text-muted-foreground tabular-nums")}>
          {XP_PER_CARD} XP / card shipped
        </p>
      </div>

      <div className="relative grid @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="flex items-center gap-4 p-4">
          <div className="relative shrink-0">
            <div
              className="flex size-20 items-center justify-center rounded-full p-1.5 transition-[background] duration-700 motion-reduce:transition-none"
              style={{ background: ring }}
              role="img"
              aria-label={`Level ${crew.level}, ${Math.round(crew.progress * 100)}% to level ${crew.level + 1}`}
            >
              <div className="flex size-full flex-col items-center justify-center rounded-full bg-card">
                <span className={cn(MICRO, "text-[9px] text-muted-foreground")}>Level</span>
                <span className="font-mono text-2xl leading-none font-bold tabular-nums">{crew.level}</span>
              </div>
            </div>
            <div aria-live="polite" className="pointer-events-none absolute -top-2 left-full z-20 ml-2 grid w-max gap-1">
              {pops.map((pop) => (
                <span
                  key={pop.id}
                  className="animate-xp-pop flex max-w-64 items-center gap-1 border border-chart-3/50 bg-card px-2.5 py-1 font-mono text-xs font-semibold text-chart-3"
                >
                  <SparklesIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{pop.text}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <p className={cn(MICRO, "text-muted-foreground")}>Your agent crew</p>
              <p className="truncate text-lg font-semibold tracking-tight">{crew.rank}</p>
            </div>
            <div className="space-y-1">
              <div
                className="h-2.5 overflow-hidden border bg-muted"
                role="progressbar"
                aria-label="Experience to next level"
                aria-valuemin={crew.levelStartXp}
                aria-valuemax={crew.nextLevelXp}
                aria-valuenow={crew.xp}
              >
                <div
                  className="h-full bg-primary transition-[width] duration-700 motion-reduce:transition-none"
                  style={{ width: `${crew.progress * 100}%` }}
                />
              </div>
              <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
                <span className="font-semibold text-foreground">{crew.xp.toLocaleString()} XP</span> ·{" "}
                {(crew.nextLevelXp - crew.xp).toLocaleString()} to level {crew.level + 1}
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px border-t bg-border @lg:grid-cols-4 @3xl:border-t-0 @3xl:border-l">
          <Readout
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
          <Readout icon={<TicketIcon />} label="In line" value={queue.queued.length} />
          <Readout icon={<TrophyIcon />} label="Shipped" value={totals.done} tone="gold" />
          <Readout
            icon={<LifeBuoyIcon />}
            label="Need help"
            value={attention}
            tone={attention > 0 ? "destructive" : undefined}
          />
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-1.5 border-t px-3 py-2">
        <span className={cn(MICRO, "mr-1 text-muted-foreground tabular-nums")}>
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
                    "flex size-8 items-center justify-center border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    badge.unlocked
                      ? "border-chart-3/45 bg-chart-3/15 text-chart-3"
                      : "border-dashed bg-muted/60 text-muted-foreground/45",
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
// Intake conveyor: the line

function Crate({ entry, position, links }: { entry: QueueEntry; position: number; links: CardLink[] }) {
  const { name, hue } = workerIdentity(entry.taskId);
  const waiting = entry.waitingFor.length;
  const needs = waiting > 0 ? `needs ${plural(waiting, "card")} done first` : null;
  return (
    <li
      data-node={`intake:${entry.taskId}`}
      className="animate-card-in relative min-w-0 border bg-card"
      style={{ "--stagger": position - 1 } as React.CSSProperties}
    >
      <Link
        href={cardHref(entry.boardId, entry.taskId)}
        aria-label={`${name} is waiting in line, #${position}, for ${entry.title} in ${entry.boardName}${needs ? `; ${needs}` : ""}${entry.planning ? "; being planned" : ""}`}
        className="group block min-h-11 p-2.5 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="flex items-start gap-2.5">
          <WorkerAvatar hue={hue} mood="waiting" className="size-9" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="line-clamp-2 text-sm leading-snug font-medium group-hover:underline group-hover:underline-offset-4">
              {entry.title}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {name} · {entry.boardName}
            </p>
          </div>
          <span className={cn(MICRO, "shrink-0 border bg-background px-1 py-0.5 tabular-nums")}>#{position}</span>
        </div>
        {(needs || entry.planning || entry.planNote) && (
          <div className="mt-1.5 min-w-0 space-y-0.5">
            {needs && (
              <p className={cn(MICRO, "flex items-center gap-1 text-muted-foreground")}>
                <LockIcon className="size-3 shrink-0" />
                <span className="min-w-0">{needs}</span>
              </p>
            )}
            {entry.planning && <p className={cn(MICRO, "text-primary")}>Being planned</p>}
            {entry.planNote && (
              <p className="line-clamp-2 text-[11px] text-muted-foreground italic" title={entry.planNote}>
                {entry.planNote}
              </p>
            )}
          </div>
        )}
      </Link>
      {links.length > 0 && (
        <div className="border-t border-dashed px-2.5 py-1.5">
          <LinkChips taskId={entry.taskId} links={links} />
        </div>
      )}
    </li>
  );
}

function IntakeZone({
  queue,
  linksByTask,
  className,
}: {
  queue: QueueSnapshot;
  linksByTask: Map<string, CardLink[]>;
  className?: string;
}) {
  const { queued, planning } = queue;
  return (
    <section aria-labelledby="viz-line" className={cn("min-w-0", className)}>
      <ZoneHeader
        id="viz-line"
        code="Zone A · Intake"
        icon={<TicketIcon />}
        title="The line"
        description={queued.length > 0 ? `${queued.length} waiting for a station, in start order` : "Nobody waiting"}
      />
      <div className="space-y-2 p-3">
        {planning.length > 0 && (
          <p className={cn("flex items-center gap-1.5 border border-primary/30 px-2 py-1.5 text-xs text-primary", PRIMARY_FILL)}>
            <ListChecksIcon className="size-3.5 shrink-0" />
            <span className="truncate">Smart queue is ordering {planning.map((p) => p.boardName).join(", ")}</span>
          </p>
        )}
        {queued.length === 0 ? (
          <EmptyNote>No one in line — every started card has a station.</EmptyNote>
        ) : (
          <div className="relative lg:pl-4">
            <div aria-hidden className="animate-belt mb-2 h-2.5 border-y lg:hidden" />
            <div aria-hidden className="animate-belt-y absolute inset-y-0 left-0 hidden w-2.5 border-x lg:block" />
            <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
              {queued.map((entry, i) => (
                <Crate
                  key={entry.taskId}
                  entry={entry}
                  position={i + 1}
                  links={linksByTask.get(entry.taskId) ?? NO_LINKS}
                />
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Assembly: one station per agent slot

function HelperModules({ taskId, helpers }: { taskId: string; helpers: SubagentSnapshot[] }) {
  if (helpers.length === 0) return null;
  const busy = helpers.filter(isBusy).length;
  const hidden = helpers.length - MAX_HELPERS_SHOWN;
  return (
    <div className="space-y-1">
      <p className={cn(MICRO, "text-muted-foreground")}>
        {busy > 0 ? `${plural(busy, "helper")} working` : `${plural(helpers.length, "helper")} done`}
      </p>
      <ul aria-label="Subagents" className="flex flex-wrap gap-1.5">
        {helpers.slice(0, MAX_HELPERS_SHOWN).map((helper) => {
          const text = [helper.agent, helper.description, helper.status, helper.currentTool].filter(Boolean).join(" · ");
          return (
            <li
              key={helper.id}
              data-node={helperNode(taskId, helper.id)}
              title={text}
              className={cn(
                "relative flex size-9 items-center justify-center border bg-background",
                isBusy(helper) && "border-primary/50",
              )}
            >
              <WorkerAvatar
                hue={workerIdentity(`${taskId}:${helper.id}`).hue}
                mood={HELPER_MOOD[helper.status]}
                className="size-6"
              />
              {isBusy(helper) && (
                <span aria-hidden className="absolute -top-px -right-px size-1.5 bg-primary motion-safe:animate-pulse" />
              )}
              <span className="sr-only">{text}</span>
            </li>
          );
        })}
        {hidden > 0 && (
          <li className={cn(MICRO, "flex h-9 items-center px-1 text-muted-foreground")}>+{hidden}</li>
        )}
      </ul>
    </div>
  );
}

function Station({
  entry,
  worker,
  index,
  links,
}: {
  entry: QueueEntry;
  worker: LiveWorker;
  index: number;
  links: CardLink[];
}) {
  const { name, hue } = workerIdentity(entry.taskId);
  const activity = worker.activity ?? CLOCKING_IN;
  const Icon = ACTIVITY_ICON[activity.icon];
  const system = activitySystem(worker.activity);
  return (
    <li
      data-node={`station:${entry.taskId}`}
      className="animate-card-in flex min-w-0 flex-col border border-primary/40 bg-card"
      style={{ "--stagger": index } as React.CSSProperties}
    >
      <div aria-hidden className="h-1" style={{ background: hueColor(hue) }} />
      <Link
        href={cardHref(entry.boardId, entry.taskId)}
        aria-label={`${name} is working on ${entry.title} in ${entry.boardName}`}
        className="group flex flex-col transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="flex min-h-8 items-center justify-between gap-2 border-b px-2.5 py-1">
          <span className={cn(MICRO, "flex items-center gap-1.5 font-semibold")}>
            <span className="relative flex size-2" aria-hidden>
              <span className="absolute inset-0 animate-ping bg-primary/60 motion-reduce:animate-none" />
              <span className="relative size-2 bg-primary" />
            </span>
            ST-{unitNumber(index)}
          </span>
          {worker.startedAt && <ShiftClock startedAt={worker.startedAt} />}
        </div>
        <div
          key={`${activity.icon}:${activity.label}:${activity.detail ?? ""}`}
          className="animate-fade-in-soft min-h-[3.25rem] border-b bg-muted/40 px-2.5 py-1.5 font-mono text-xs"
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
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={activity.detail}>
              {activity.detail}
            </p>
          )}
        </div>
        <div className="flex items-start gap-3 p-2.5">
          <WorkerAvatar hue={hue} mood="working" className="size-14" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden className="size-2 shrink-0" style={{ background: hueColor(hue) }} />
              <span className="font-semibold text-foreground">{name}</span>
              <span className="truncate">· {entry.boardName}</span>
            </p>
            <p className="line-clamp-2 text-sm font-medium group-hover:underline group-hover:underline-offset-4">
              {entry.title}
            </p>
          </div>
        </div>
      </Link>
      <div className="mt-auto space-y-2 border-t border-dashed px-2.5 py-2">
        <p className={cn(MICRO, "flex items-center gap-1.5", system ? "text-primary" : "text-muted-foreground")}>
          <PlugZapIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{system ? `Port → ${SYSTEM_LABEL[system]}` : "Port · standby"}</span>
        </p>
        <HelperModules taskId={entry.taskId} helpers={sortedHelpers(worker)} />
        <LinkChips taskId={entry.taskId} links={links} />
      </div>
    </li>
  );
}

/** A free station slot: a compact strip pinned to the top of its grid cell, never stretched. */
function OpenBay({ index, lineBlocked }: { index: number; lineBlocked: boolean }) {
  return (
    <li
      className="animate-card-in flex min-w-0 items-center gap-2.5 self-start border border-dashed bg-background/60 px-2.5 py-2"
      style={{ "--stagger": index } as React.CSSProperties}
    >
      <CircleDashedIcon className="size-5 shrink-0 text-muted-foreground/50" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn(MICRO, "text-muted-foreground")}>ST-{unitNumber(index)} · open bay</span>
          <span className="text-sm font-medium text-muted-foreground">Station {index + 1} is open</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {lineBlocked ? "Free — queued cards wait on other cards to finish" : "Start a card to fill this station"}
        </p>
      </div>
    </li>
  );
}

function AssemblyZone({
  queue,
  live,
  linksByTask,
  className,
}: {
  queue: QueueSnapshot;
  live: Record<string, LiveWorker>;
  linksByTask: Map<string, CardLink[]>;
  className?: string;
}) {
  const { running, queued, limit } = queue;
  const openBays = Math.max(0, limit - running.length);
  return (
    <section aria-labelledby="viz-floor" className={cn("@container min-w-0", className)}>
      <ZoneHeader
        id="viz-floor"
        code="Zone B · Assembly"
        icon={<FactoryIcon />}
        title="The floor"
        description={`${running.length} of ${limit} stations busy · one worker per agent`}
      />
      <ul
        className={cn(
          "grid grid-cols-1 gap-4 p-3 @lg:grid-cols-2 @4xl:grid-cols-3",
          running.length + openBays >= 4 && "@7xl:grid-cols-4",
        )}
      >
        {running.map((entry, i) => (
          <Station
            key={entry.taskId}
            entry={entry}
            worker={live[entry.taskId] ?? IDLE_WORKER}
            index={i}
            links={linksByTask.get(entry.taskId) ?? NO_LINKS}
          />
        ))}
        {Array.from({ length: openBays }, (_, i) => (
          <OpenBay key={`open-${i}`} index={running.length + i} lineBlocked={queued.length > 0} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Output: rework bay and shipping dock

function ReworkBay({ cards, total, className }: { cards: Dashboard["attention"]; total: number; className?: string }) {
  return (
    <section aria-labelledby="viz-help" data-node="bay:rework" className={cn("relative min-w-0", className)}>
      <div aria-hidden className="bg-hazard pointer-events-none absolute inset-0" />
      <ZoneHeader
        id="viz-help"
        code="Zone C · Rework bay"
        icon={<LifeBuoyIcon />}
        title="Need a hand"
        description={
          total > cards.length ? `Showing ${cards.length} of ${total} workers` : "Failed or stalled — open to retry or resume"
        }
        className={cn("border-destructive/40", DESTRUCTIVE_FILL)}
      />
      <ul className="relative grid grid-cols-1 gap-2 p-3">
        {cards.map((card) => {
          const reason = HELP_REASON[card.reason];
          const { name, hue } = workerIdentity(card.id);
          const error = card.reason === "failed" && card.agentError ? card.agentError.split("\n", 1)[0] : null;
          return (
            <li key={card.id} className="min-w-0">
              <Link
                href={cardHref(card.boardId, card.id)}
                className="group flex min-h-11 min-w-0 items-start gap-2.5 overflow-hidden border border-destructive/30 bg-card p-2 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <WorkerAvatar hue={hue} mood={reason.mood} className="size-9" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
                    <p className="line-clamp-2 min-w-0 flex-1 basis-32 text-sm leading-snug font-medium group-hover:underline group-hover:underline-offset-4">
                      {card.title}
                    </p>
                    <Badge variant={reason.variant} className="shrink-0 rounded-none">
                      {reason.label}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {name} · {card.boardName}
                  </p>
                  {error && (
                    <p className="truncate font-mono text-[11px] text-destructive" title={error}>
                      {error}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ShippingDock({ cards, now, className }: { cards: DashboardCard[]; now: number; className?: string }) {
  return (
    <section aria-labelledby="viz-trophies" data-node="dock:shipped" className={cn("@container min-w-0", className)}>
      <ZoneHeader
        id="viz-trophies"
        code="Zone D · Shipping dock"
        icon={<TrophyIcon />}
        title="Trophy wall"
        description="Latest cards your workers shipped"
      />
      <div className="p-3">
        {cards.length === 0 ? (
          <EmptyNote>Nothing shipped yet — finished cards land here.</EmptyNote>
        ) : (
          <ul className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
            {cards.map((card, i) => {
              const { name, hue } = workerIdentity(card.id);
              return (
                <li key={card.id} className="animate-card-in min-w-0" style={{ "--stagger": i } as React.CSSProperties}>
                  <Link
                    href={cardHref(card.boardId, card.id)}
                    className="group flex h-full min-h-11 items-center gap-2.5 border bg-card p-2 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="relative shrink-0">
                      <WorkerAvatar hue={hue} mood="happy" animated={false} className="size-9" />
                      <TrophyIcon className="absolute -right-1 -bottom-1 size-4 bg-card p-0.5 text-chart-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm leading-snug font-medium group-hover:underline group-hover:underline-offset-4">
                        {card.title}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {name} · {card.boardName} · {formatRelative(card.updatedAt, now)}
                      </p>
                    </div>
                    <span className="shrink-0 font-mono text-xs font-semibold text-chart-3 tabular-nums">
                      +{XP_PER_CARD} XP
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

// ---------------------------------------------------------------------------------------------
// Systems bus

function SystemModule({
  id,
  label,
  description,
  index,
  load,
}: {
  id: SystemId;
  label: string;
  description: string;
  index: number;
  load: SystemLoad;
}) {
  const Icon = SYSTEM_ICON[id];
  const stations = load.taskIds.length;
  const inUse = stations > 0 || load.helpers > 0;
  const users = load.taskIds.map((taskId) => workerIdentity(taskId));
  return (
    <li
      data-node={`system:${id}`}
      title={description}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 border bg-card p-2.5 transition-colors motion-reduce:transition-none",
        inUse && cn("border-primary/60", PRIMARY_FILL),
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn(MICRO, "text-muted-foreground tabular-nums")}>BUS/{unitNumber(index)}</span>
        <span
          aria-hidden
          className={cn("size-2", inUse ? "bg-primary motion-safe:animate-pulse" : "bg-muted-foreground/30")}
        />
      </div>
      <p className="flex items-center gap-1.5 text-sm leading-tight font-semibold">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </p>
      <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{description}</p>
      <div className="mt-auto flex items-center justify-between gap-2 pt-0.5">
        <span className={cn(MICRO, "truncate tabular-nums", inUse ? "text-primary" : "text-muted-foreground")}>
          {inUse ? [stations > 0 && `${stations} st`, load.helpers > 0 && `${load.helpers} sub`].filter(Boolean).join(" · ") : "Idle"}
        </span>
        {users.length > 0 && (
          <span aria-hidden className="flex shrink-0 gap-0.5">
            {users.slice(0, 6).map((user, i) => (
              <span
                key={load.taskIds[i]}
                title={user.name}
                className="size-2"
                style={{ background: hueColor(user.hue) }}
              />
            ))}
          </span>
        )}
      </div>
      {inUse && (
        <span className="sr-only">
          In use by {users.map((user) => user.name).join(", ")}
          {load.helpers > 0 && ` and ${plural(load.helpers, "subagent")}`}
        </span>
      )}
    </li>
  );
}

function SystemsBus({ load, className }: { load: Record<SystemId, SystemLoad>; className?: string }) {
  const busy = SYSTEMS.filter((system) => load[system.id].taskIds.length > 0 || load[system.id].helpers > 0).length;
  return (
    <section aria-labelledby="viz-bus" className={cn("min-w-0", className)}>
      <ZoneHeader
        id="viz-bus"
        code="Utility bus"
        icon={<CableIcon />}
        title="Systems"
        description={`Shared components the workers plug into · ${busy} of ${SYSTEMS.length} in use`}
      />
      <ul className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4 xl:grid-cols-8">
        {SYSTEMS.map((system, i) => (
          <SystemModule
            key={system.id}
            id={system.id}
            label={system.label}
            description={system.description}
            index={i}
            load={load[system.id]}
          />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The production line

/**
 * The factory schematic: intake conveyor → assembly stations (with subagent modules) → rework bay
 * and shipping dock, the systems bus underneath, and wires for who uses what and who talks to whom.
 * The wires only show from lg up where the zones sit side by side; every relation is also a chip.
 */
export function ProductionLine({
  dashboard,
  live,
  now,
  attentionTotal,
}: {
  dashboard: Dashboard;
  live: Record<string, LiveWorker>;
  now: number;
  attentionTotal: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { queue } = dashboard;
  const links = useMemo(() => buildLinks(queue, live, now), [queue, live, now]);
  const load = useMemo(() => systemLoad(queue, live), [queue, live]);
  const wires = useMemo(() => buildWires(queue, live, links), [queue, live, links]);
  const linksByTask = useMemo(() => {
    const map = new Map<string, CardLink[]>();
    for (const link of links) {
      for (const taskId of [link.from, link.to]) {
        const list = map.get(taskId);
        if (list) list.push(link);
        else map.set(taskId, [link]);
      }
    }
    return map;
  }, [links]);
  const hasAttention = dashboard.attention.length > 0;

  return (
    <section aria-label="Production line" className="relative border bg-card/40">
      <div aria-hidden className="bg-blueprint pointer-events-none absolute inset-0" />
      <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-3 py-2">
        <p className={cn(MICRO, "flex items-center gap-1.5 font-semibold")}>
          <FactoryIcon className="size-3.5" />
          Production line
        </p>
        <p className={cn(MICRO, "text-muted-foreground tabular-nums")}>
          {queue.running.length}/{queue.limit} stations · {queue.queued.length} in intake · {plural(links.length, "link")}
        </p>
        <div className="ml-auto hidden lg:block">
          <WireLegend />
        </div>
      </div>
      <div ref={containerRef} className="relative isolate">
        <Wiring containerRef={containerRef} wires={wires} className="z-0 hidden lg:block" />
        <div className={cn(LINE_GRID, "relative z-10")}>
          <IntakeZone queue={queue} linksByTask={linksByTask} className="border-b lg:border-r" />
          <AssemblyZone queue={queue} live={live} linksByTask={linksByTask} className="border-b xl:border-r" />
          <div
            className={cn(
              "grid min-w-0 grid-cols-1 content-start border-b lg:col-span-2 xl:col-span-1",
              hasAttention && "lg:grid-cols-2 xl:grid-cols-1",
            )}
          >
            {hasAttention && (
              <ReworkBay
                cards={dashboard.attention}
                total={attentionTotal}
                className="border-b lg:border-r lg:border-b-0 xl:border-r-0 xl:border-b"
              />
            )}
            <ShippingDock cards={dashboard.finished} now={now} />
          </div>
          <SystemsBus load={load} className="lg:col-span-full" />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Worksites

function Worksite({
  board,
  crew,
  index,
  now,
}: {
  board: DashboardBoard;
  crew: QueueEntry[];
  index: number;
  now: number;
}) {
  const total = TASK_STATUSES.reduce((sum, s) => sum + board.counts[s], 0);
  const pct = total === 0 ? 0 : Math.round((board.counts.done / total) * 100);
  return (
    <li className="grid content-start gap-2.5 border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(MICRO, "text-muted-foreground tabular-nums")}>Site/{unitNumber(index)}</span>
        <Link
          href={`/b/${board.id}`}
          className="-my-2 min-w-0 flex-1 truncate py-2 font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
        >
          {board.name}
        </Link>
        {board.attentionCount > 0 && (
          <Badge variant="destructive" className="rounded-none">
            <LifeBuoyIcon />
            {board.attentionCount}
          </Badge>
        )}
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatRelative(board.lastActivityAt, now)}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <DistributionBar counts={board.counts} label={board.name} />
        </div>
        <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          <span className="font-mono font-semibold text-foreground">{pct}%</span> shipped
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {TASK_STATUSES.map((s) => (
            <span key={s} className="flex items-center gap-1.5 tabular-nums">
              <span className={cn("size-2", DOT_CLASS[s])} aria-hidden />
              {STATUS_LABELS[s]} <span className="font-mono font-medium text-foreground">{board.counts[s]}</span>
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

/** Every project with its card distribution, crew on site and attention count. */
export function WorksitesSection({ dashboard, now }: { dashboard: Dashboard; now: number }) {
  return (
    <section aria-labelledby="viz-sites" className="@container relative min-w-0 border bg-card/40">
      <ZoneHeader
        id="viz-sites"
        code="Site map"
        icon={<Building2Icon />}
        title="Worksites"
        description="Your projects, most recently active first"
        className="border-solid"
      />
      <ul className="grid gap-3 p-3 @3xl:grid-cols-2 @6xl:grid-cols-3">
        {dashboard.boards.map((board, i) => (
          <Worksite
            key={board.id}
            board={board}
            crew={dashboard.queue.running.filter((entry) => entry.boardId === board.id)}
            index={i}
            now={now}
          />
        ))}
      </ul>
    </section>
  );
}
