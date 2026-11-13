"use client";

import { useMemo, useRef } from "react";
import Link from "next/link";
import {
  CpuIcon,
  DatabaseIcon,
  GlobeIcon,
  HardDriveIcon,
  KanbanIcon,
  LightbulbIcon,
  LockIcon,
  TerminalIcon,
  UsersIcon,
} from "lucide-react";
import { formatDuration, formatRelative, useNow } from "@/components/board/format";
import { FOCUS_RING, PRESSABLE, cardHref, plural } from "@/components/home/shared";
import { ACTIVITY_ICON } from "@/components/visualize/activity-icons";
import type { Activity } from "@/components/visualize/activity";
import {
  activitySystem,
  buildLinks,
  type CardLink,
  SYSTEMS,
  type SystemId,
  type SystemLoad,
  systemLoad,
  toolSystem,
} from "@/components/visualize/agent-map";
import { XP_PER_CARD, workerIdentity } from "@/components/visualize/game";
import type { LiveAgent } from "@/components/visualize/use-live-agents";
import { type Wire, WIRE_STYLE, WireLegend, Wiring } from "@/components/visualize/wiring";
import { WorkerAvatar, type WorkerMood, WorkerOutline } from "@/components/visualize/worker-avatar";
import type {
  AttentionReason,
  Dashboard,
  QueueEntry,
  QueueSnapshot,
  SubagentSnapshot,
  SubagentStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const MAX_SUBAGENTS_SHOWN = 6;
const MAX_LINKS_SHOWN = 6;
/** Open stations drawn one by one; the rest fold into a single "+N open" bay. */
const MAX_OPEN_BAYS = 3;
/** Shipped cards younger than this get their "+100 XP" stamped in. */
const FRESH_SHIP_MS = 2 * 60_000;
/** Entry stagger stops growing after this many items. */
const MAX_STAGGER = 8;

/** Columns of the floor: intake | stations | rework + shipping on xl; the last column wraps below on lg. */
export const MAP_GRID =
  "grid grid-cols-1 lg:grid-cols-[minmax(14rem,16rem)_minmax(0,1fr)] xl:grid-cols-[minmax(14rem,17rem)_minmax(0,1fr)_minmax(16rem,20rem)]";

/** Painted lane line between zones of the floor. */
const LANE = "border-dashed border-floor-paint";

/** A structural plate on the floor (ticket, station, receipt): lifts a pixel on hover. */
const PLATE =
  "rounded-[3px] border bg-card transition-[translate,border-color] duration-150 hover:-translate-y-px hover:border-foreground/20 motion-reduce:hover:translate-y-0";

/** A running card the live feed knows nothing about yet. */
const IDLE: LiveAgent = { helpers: {}, contacts: [] };
const NO_LINKS: CardLink[] = [];

/** Before the first live event of a run arrives. */
const STARTING: Activity = { icon: "status", label: "Starting" };

const REWORK: Record<AttentionReason, { label: string; mood: WorkerMood; chip: string }> = {
  failed: { label: "Failed", mood: "error", chip: "bg-destructive/10 text-destructive" },
  stalled: { label: "Stalled", mood: "sleeping", chip: "bg-muted text-muted-foreground" },
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

/** Chip prefix of a link seen from either end. */
const LINK_CHIP: Record<CardLink["kind"], { out: string; in: string }> = {
  message: { out: "Messaged", in: "Message from" },
  wait: { out: "Waiting on", in: "Awaited by" },
  inspect: { out: "Read", in: "Read by" },
  delegate: { out: "Created", in: "Created by" },
  depends: { out: "Blocks", in: "Needs" },
};

/** Card id → title, for links that name other cards. */
type TitleOf = (taskId: string) => string;

// ---------------------------------------------------------------------------------------------
// Helpers

function isBusy(subagent: SubagentSnapshot): boolean {
  return subagent.status === "running" || subagent.status === "pending";
}

function sortedSubagents(agent: LiveAgent): SubagentSnapshot[] {
  return Object.values(agent.helpers).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function subagentNode(taskId: string, subagentId: string): string {
  return `subagent:${taskId}:${subagentId}`;
}

/** Entry stagger for the `index`-th plate of a zone. */
function stagger(index: number): React.CSSProperties {
  return { "--i": Math.min(index, MAX_STAGGER) } as React.CSSProperties;
}

/** One link as a sentence, for wire tooltips and screen readers. */
function linkSentence(link: CardLink, titleOf: TitleOf): string {
  const from = `"${titleOf(link.from)}"`;
  const to = `"${titleOf(link.to)}"`;
  switch (link.kind) {
    case "message":
      return `${from} messaged ${to}`;
    case "wait":
      return `${from} is waiting on ${to}`;
    case "inspect":
      return `${from} read ${to}`;
    case "delegate":
      return `${from} created ${to}`;
    case "depends":
      return `${to} needs ${from} done first`;
  }
}

/**
 * Every wire on the floor: each running card and busy subagent to the system it uses, running
 * cards to their subagents, and agent-to-agent links between running and queued cards.
 */
function buildWires(
  queue: QueueSnapshot,
  live: Record<string, LiveAgent>,
  links: CardLink[],
  titleOf: TitleOf,
): Wire[] {
  const wires: Wire[] = [];
  for (const entry of queue.running) {
    const agent = live[entry.taskId] ?? IDLE;
    const node = `running:${entry.taskId}`;
    const system = activitySystem(agent.activity);
    if (system) {
      wires.push({
        from: node,
        to: `system:${system}`,
        kind: "uses",
        active: true,
        label: `"${entry.title}" uses ${SYSTEM_LABEL[system]}`,
      });
    }
    for (const subagent of sortedSubagents(agent).slice(0, MAX_SUBAGENTS_SHOWN)) {
      const sub = subagentNode(entry.taskId, subagent.id);
      const busy = isBusy(subagent);
      wires.push({ from: node, to: sub, kind: "subagent", active: busy, label: `Subagent ${subagent.agent}` });
      const subSystem = busy && subagent.currentTool ? toolSystem(subagent.currentTool) : null;
      if (subSystem) {
        wires.push({
          from: sub,
          to: `system:${subSystem}`,
          kind: "uses",
          active: true,
          label: `Subagent ${subagent.agent} uses ${SYSTEM_LABEL[subSystem]}`,
        });
      }
    }
  }

  const running = new Set(queue.running.map((entry) => entry.taskId));
  const queued = new Set(queue.queued.map((entry) => entry.taskId));
  const nodeOf = (taskId: string) =>
    running.has(taskId) ? `running:${taskId}` : queued.has(taskId) ? `queued:${taskId}` : null;
  for (const link of links) {
    const from = nodeOf(link.from);
    const to = nodeOf(link.to);
    if (!from || !to) continue;
    wires.push({
      from,
      to,
      kind: link.kind,
      active: link.kind === "message" || link.kind === "wait" || link.kind === "inspect",
      label: linkSentence(link, titleOf),
    });
  }
  return wires;
}

// ---------------------------------------------------------------------------------------------
// Building blocks

/** A status lamp: a solid dot, with a breathing ring while `live`. */
function Lamp({
  tone = "signal",
  live = true,
  className,
}: {
  tone?: "signal" | "error";
  live?: boolean;
  className?: string;
}) {
  const color = tone === "error" ? "bg-destructive" : "bg-signal";
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0", className)}>
      {live && <span className={cn("absolute inset-0 animate-lamp rounded-full", color)} />}
      <span className={cn("relative size-full rounded-full", color)} />
    </span>
  );
}

/** Head of a floor zone: an oversized figure that rolls in when it changes, title and a mono readout. */
function ZoneHead({
  id,
  figure,
  suffix,
  title,
  note,
  large = false,
  tone,
}: {
  id: string;
  figure: number;
  suffix?: React.ReactNode;
  title: string;
  note?: React.ReactNode;
  large?: boolean;
  tone?: string;
}) {
  return (
    <div className="flex min-w-0 items-end gap-3">
      <span
        className={cn(
          "shrink-0 leading-none font-semibold tracking-[-0.05em] tabular-nums",
          large ? "text-6xl sm:text-7xl" : "text-5xl",
          tone,
        )}
      >
        <span key={figure} className="animate-digit-roll">
          {figure}
        </span>
        {suffix}
      </span>
      <div className="min-w-0 pb-0.5">
        <h3 id={id} className="text-sm font-semibold tracking-tight">
          {title}
        </h3>
        {note && <p className="truncate font-mono text-xs text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs text-muted-foreground">{children}</p>;
}

/** Time on the current run; ticks on its own so the rest of the page doesn't re-render. */
function Elapsed({ startedAt, className }: { startedAt: string; className?: string }) {
  const now = useNow(1_000);
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return (
    <span className={cn("font-mono text-xs text-muted-foreground tabular-nums", className)} title="Time on this run">
      {formatDuration(now - started)}
    </span>
  );
}

/** A card's links to other cards as text chips (the wires are aria-hidden and lg-only). */
function LinkChips({ taskId, links, titleOf }: { taskId: string; links: CardLink[]; titleOf: TitleOf }) {
  if (links.length === 0) return null;
  const shown = links.slice(0, MAX_LINKS_SHOWN);
  return (
    <ul aria-label="Links to other cards" className="flex flex-wrap gap-1">
      {shown.map((link) => {
        const outgoing = link.from === taskId;
        const sentence = linkSentence(link, titleOf);
        return (
          <li
            key={`${link.kind}:${link.from}:${link.to}`}
            title={sentence}
            className="flex max-w-full items-center gap-1.5 rounded-[3px] border bg-background px-1.5 py-0.5 text-xs"
          >
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: WIRE_STYLE[link.kind].color }}
            />
            <span aria-hidden className="truncate text-muted-foreground">
              {LINK_CHIP[link.kind][outgoing ? "out" : "in"]}{" "}
              <span className="text-foreground">{titleOf(outgoing ? link.to : link.from)}</span>
            </span>
            <span className="sr-only">{sentence}</span>
          </li>
        );
      })}
      {links.length > shown.length && (
        <li className="flex items-center px-1 font-mono text-xs text-muted-foreground">+{links.length - shown.length}</li>
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Intake lane

function Ticket({
  entry,
  position,
  links,
  titleOf,
}: {
  entry: QueueEntry;
  position: number;
  links: CardLink[];
  titleOf: TitleOf;
}) {
  const worker = workerIdentity(entry.taskId);
  const waiting = entry.waitingFor.length;
  const needs = waiting > 0 ? `Waits on ${plural(waiting, "card")}` : null;
  return (
    <li
      data-node={`queued:${entry.taskId}`}
      style={stagger(position - 1)}
      className={cn("min-w-0 animate-floor-in", PLATE)}
    >
      <Link
        href={cardHref({ boardId: entry.boardId, id: entry.taskId })}
        aria-label={`Queued #${position}: ${entry.title} in ${entry.boardName}${needs ? `; ${needs.toLowerCase()}` : ""}${entry.planning ? "; being planned" : ""}${entry.drafting ? "; being written" : ""}`}
        className={cn("group grid min-h-11 grid-cols-[auto_minmax(0,1fr)] rounded-[3px]", PRESSABLE, FOCUS_RING)}
      >
        <div className="flex flex-col items-center gap-1.5 border-r border-dashed px-2.5 py-2.5">
          <span className="font-mono text-base leading-none font-semibold tabular-nums">
            {String(position).padStart(2, "0")}
          </span>
          <WorkerAvatar hue={worker.hue} mood="waiting" animated={false} className="size-7" />
        </div>
        <div className="min-w-0 space-y-0.5 p-2.5">
          <p className="truncate font-mono text-[11px] text-muted-foreground">{worker.name}</p>
          <p className="line-clamp-2 text-sm leading-snug font-medium group-hover:underline group-hover:underline-offset-4">
            {entry.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">{entry.boardName}</p>
          {(needs || entry.planning || entry.drafting || entry.planNote) && (
            <div className="min-w-0 space-y-0.5 pt-1 text-xs">
              {needs && (
                <p className="flex items-center gap-1 text-muted-foreground">
                  <LockIcon className="size-3 shrink-0" />
                  <span className="min-w-0">{needs}</span>
                </p>
              )}
              {entry.planning && (
                <p className="flex items-center gap-1.5 text-signal-ink">
                  <Lamp />
                  Being planned
                </p>
              )}
              {entry.drafting && (
                <p className="flex items-center gap-1.5 text-signal-ink">
                  <Lamp />
                  Being written
                </p>
              )}
              {entry.planNote && (
                <p className="line-clamp-2 text-muted-foreground" title={entry.planNote}>
                  {entry.planNote}
                </p>
              )}
            </div>
          )}
        </div>
      </Link>
      {links.length > 0 && (
        <div className="border-t border-dashed px-2.5 py-1.5">
          <LinkChips taskId={entry.taskId} links={links} titleOf={titleOf} />
        </div>
      )}
    </li>
  );
}

function IntakeLane({
  queue,
  linksByTask,
  titleOf,
  className,
}: {
  queue: QueueSnapshot;
  linksByTask: Map<string, CardLink[]>;
  titleOf: TitleOf;
  className?: string;
}) {
  const { queued, planning } = queue;
  return (
    <section aria-labelledby="viz-queue" className={cn("min-w-0 space-y-4 p-4 sm:p-5", className)}>
      <ZoneHead id="viz-queue" figure={queued.length} title="In line" note={queued.length > 0 ? "start order" : undefined} />
      {queued.length > 0 && <div aria-hidden className="h-1.5 animate-belt rounded-[3px] border border-floor-paint" />}
      {planning.length > 0 && (
        <p className="flex items-center gap-2 font-mono text-xs text-signal-ink">
          <Lamp />
          <span className="min-w-0">Ordering the line for {planning.map((p) => p.boardName).join(", ")}</span>
        </p>
      )}
      {queued.length === 0 ? (
        <EmptyLine>Nothing in line.</EmptyLine>
      ) : (
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
          {queued.map((entry, i) => (
            <Ticket
              key={entry.taskId}
              entry={entry}
              position={i + 1}
              links={linksByTask.get(entry.taskId) ?? NO_LINKS}
              titleOf={titleOf}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Stations

function Helpers({ taskId, subagents }: { taskId: string; subagents: SubagentSnapshot[] }) {
  if (subagents.length === 0) return null;
  const busy = subagents.filter(isBusy).length;
  const hidden = subagents.length - MAX_SUBAGENTS_SHOWN;
  return (
    <div className="space-y-1.5">
      <p className="font-mono text-xs text-muted-foreground">
        {busy > 0 ? `${plural(busy, "subagent")} working` : `${plural(subagents.length, "subagent")} finished`}
      </p>
      <ul aria-label="Subagents" className="flex flex-wrap gap-1.5">
        {subagents.slice(0, MAX_SUBAGENTS_SHOWN).map((subagent) => {
          const text = [subagent.agent, subagent.description, subagent.status, subagent.currentTool]
            .filter(Boolean)
            .join(" · ");
          const running = subagent.status === "running";
          return (
            <li
              key={subagent.id}
              data-node={subagentNode(taskId, subagent.id)}
              title={text}
              className={cn(
                "relative flex size-9 items-center justify-center rounded-[3px] border bg-background",
                isBusy(subagent) && "border-signal",
              )}
            >
              <WorkerAvatar
                hue={workerIdentity(`${taskId}:${subagent.id}`).hue}
                mood={HELPER_MOOD[subagent.status]}
                animated={running}
                className={cn("size-6", !isBusy(subagent) && "opacity-60")}
              />
              {isBusy(subagent) && <Lamp live={running} className="absolute -top-1 -right-1 size-1.5" />}
              <span className="sr-only">{text}</span>
            </li>
          );
        })}
        {hidden > 0 && <li className="flex h-9 items-center px-1 font-mono text-xs text-muted-foreground">+{hidden}</li>}
      </ul>
    </div>
  );
}

function Station({
  entry,
  agent,
  index,
  links,
  titleOf,
}: {
  entry: QueueEntry;
  agent: LiveAgent;
  index: number;
  links: CardLink[];
  titleOf: TitleOf;
}) {
  const worker = workerIdentity(entry.taskId);
  const activity = agent.activity ?? STARTING;
  const Icon = ACTIVITY_ICON[activity.icon];
  const broken = activity.icon === "error";
  const system = activitySystem(agent.activity);
  const subagents = sortedSubagents(agent);
  return (
    <li
      data-node={`running:${entry.taskId}`}
      style={stagger(index)}
      className={cn("flex min-w-0 animate-floor-in flex-col", PLATE)}
    >
      <Link
        href={cardHref({ boardId: entry.boardId, id: entry.taskId })}
        aria-label={`Running: ${entry.title} in ${entry.boardName}`}
        className={cn("group flex gap-3 rounded-[3px] p-3", PRESSABLE, FOCUS_RING)}
      >
        <div className="flex size-16 shrink-0 items-end justify-center rounded-[3px] border-2 border-dashed border-floor-paint pb-0.5">
          <WorkerAvatar hue={worker.hue} mood={broken ? "error" : "working"} className="size-12" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Lamp tone={broken ? "error" : "signal"} live={!broken} />
            <span className="truncate font-mono text-xs font-medium">{worker.name}</span>
            {agent.startedAt && <Elapsed startedAt={agent.startedAt} className="ml-auto shrink-0" />}
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-snug font-medium group-hover:underline group-hover:underline-offset-4">
            {entry.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">{entry.boardName}</p>
        </div>
      </Link>
      <div className="mx-3 mb-3 rounded-[3px] bg-muted/70 px-2 py-1.5 font-mono text-xs">
        <p className={cn("flex items-center gap-1.5", broken ? "text-destructive" : "text-foreground")}>
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{activity.label}</span>
          {system && (
            <span className="ml-auto shrink-0 pl-2 text-muted-foreground" title={`Drawing on ${SYSTEM_LABEL[system]}`}>
              on {SYSTEM_LABEL[system]}
            </span>
          )}
        </p>
        {activity.detail && (
          <p className="mt-0.5 truncate pl-5 text-[11px] text-muted-foreground" title={activity.detail}>
            {activity.detail}
          </p>
        )}
      </div>
      {(subagents.length > 0 || links.length > 0) && (
        <div className="mt-auto space-y-2.5 border-t border-dashed px-3 py-2.5">
          <Helpers taskId={entry.taskId} subagents={subagents} />
          <LinkChips taskId={entry.taskId} links={links} titleOf={titleOf} />
        </div>
      )}
    </li>
  );
}

/** An open station: a compact painted bay pinned to the top of its grid cell, never stretched. */
function OpenBay({ count, lineBlocked }: { count: number; lineBlocked: boolean }) {
  return (
    <li className={cn("flex min-w-0 items-center gap-3 self-start rounded-[3px] border-2 px-3 py-2.5", LANE)}>
      <WorkerOutline className="size-8 text-muted-foreground/40" />
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{count > 1 ? `${count} open stations` : "Open station"}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {lineBlocked ? "Line waits on other cards" : "Start a card to fill it"}
        </p>
      </div>
    </li>
  );
}

function Stations({
  queue,
  live,
  linksByTask,
  titleOf,
  className,
}: {
  queue: QueueSnapshot;
  live: Record<string, LiveAgent>;
  linksByTask: Map<string, CardLink[]>;
  titleOf: TitleOf;
  className?: string;
}) {
  const { running, queued, limit } = queue;
  const free = Math.max(0, limit - running.length);
  const singles = free > MAX_OPEN_BAYS ? MAX_OPEN_BAYS - 1 : free;
  return (
    <section aria-labelledby="viz-running" className={cn("@container min-w-0 space-y-4 p-4 sm:p-5", className)}>
      <ZoneHead
        id="viz-running"
        large
        figure={running.length}
        suffix={<span className="text-3xl text-muted-foreground/60 sm:text-4xl">/{limit}</span>}
        title="At the stations"
        note={free > 0 ? `${free} open` : "every station busy"}
      />
      <ul
        className={cn(
          "grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3",
          running.length >= 4 && "@7xl:grid-cols-4",
        )}
      >
        {running.map((entry, i) => (
          <Station
            key={entry.taskId}
            entry={entry}
            agent={live[entry.taskId] ?? IDLE}
            index={i}
            links={linksByTask.get(entry.taskId) ?? NO_LINKS}
            titleOf={titleOf}
          />
        ))}
        {Array.from({ length: singles }, (_, i) => (
          <OpenBay key={`open-${i}`} count={1} lineBlocked={queued.length > 0} />
        ))}
        {free > singles && <OpenBay count={free - singles} lineBlocked={queued.length > 0} />}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Rework bay and shipping dock

function ReworkBay({
  cards,
  total,
  className,
}: {
  cards: Dashboard["attention"];
  total: number;
  className?: string;
}) {
  return (
    <section aria-labelledby="viz-attention" className={cn("min-w-0", className)}>
      {cards.length > 0 && <div aria-hidden className="h-1.5 bg-hazard" />}
      <div className="space-y-4 p-4 sm:p-5">
        <ZoneHead
          id="viz-attention"
          figure={total}
          tone={total > 0 ? "text-destructive" : "text-muted-foreground/60"}
          title="Needs a hand"
          note={total > cards.length ? `showing ${cards.length}` : total === 0 ? "rework bay is clear" : "rework bay"}
        />
        {cards.length > 0 && (
          <ul className="grid grid-cols-1 gap-2">
            {cards.map((card, i) => {
              const worker = workerIdentity(card.id);
              const reason = REWORK[card.reason];
              const error = card.reason === "failed" && card.agentError ? card.agentError.split("\n", 1)[0] : null;
              return (
                <li key={card.id} style={stagger(i)} className={cn("min-w-0 animate-floor-in", PLATE)}>
                  <Link
                    href={cardHref(card)}
                    className={cn("group flex min-h-11 min-w-0 gap-2.5 rounded-[3px] p-2.5", PRESSABLE, FOCUS_RING)}
                  >
                    <WorkerAvatar hue={worker.hue} mood={reason.mood} animated={false} className="size-9" />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-start gap-2">
                        <p className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium group-hover:underline group-hover:underline-offset-4">
                          {card.title}
                        </p>
                        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", reason.chip)}>
                          {reason.label}
                        </span>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        <span className="font-mono">{worker.name}</span> · {card.boardName}
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
        )}
      </div>
    </section>
  );
}

function ShippingDock({
  cards,
  shipped,
  now,
  className,
}: {
  cards: Dashboard["finished"];
  shipped: number;
  now: number;
  className?: string;
}) {
  return (
    <section aria-labelledby="viz-done" className={cn("@container min-w-0 space-y-4 p-4 sm:p-5", className)}>
      <ZoneHead id="viz-done" figure={shipped} title="Shipped" note={`+${XP_PER_CARD} XP each`} />
      {cards.length === 0 ? (
        <EmptyLine>Nothing shipped yet.</EmptyLine>
      ) : (
        <ul className="grid grid-cols-1 gap-2 @xl:grid-cols-2">
          {cards.map((card, i) => {
            const worker = workerIdentity(card.id);
            const fresh = now - Date.parse(card.updatedAt) < FRESH_SHIP_MS;
            return (
              <li key={card.id} style={stagger(i)} className={cn("min-w-0 animate-floor-in", PLATE)}>
                <Link
                  href={cardHref(card)}
                  className={cn("group flex h-full min-h-11 items-center gap-2.5 rounded-[3px] p-2.5", PRESSABLE, FOCUS_RING)}
                >
                  <WorkerAvatar hue={worker.hue} mood="happy" animated={false} className="size-8" />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="line-clamp-2 text-sm leading-snug font-medium group-hover:underline group-hover:underline-offset-4">
                      {card.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{worker.name}</span> · {card.boardName} ·{" "}
                      {formatRelative(card.updatedAt, now)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-[3px] border border-signal px-1.5 py-0.5 font-mono text-[11px] font-semibold text-signal-ink tabular-nums [transform:rotate(-8deg)]",
                      fresh && "animate-stamp",
                    )}
                  >
                    +{XP_PER_CARD} XP
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Power bus

function Socket({
  id,
  label,
  description,
  load,
  titleOf,
}: {
  id: SystemId;
  label: string;
  description: string;
  load: SystemLoad;
  titleOf: TitleOf;
}) {
  const Icon = SYSTEM_ICON[id];
  const inUse = load.taskIds.length > 0 || load.helpers > 0;
  const workers = load.taskIds.map((taskId) => workerIdentity(taskId).name).join(", ");
  const users = load.taskIds.map((taskId) => `${workerIdentity(taskId).name}: ${titleOf(taskId)}`).join("\n");
  return (
    <li
      data-node={`system:${id}`}
      title={inUse ? `${description}\nIn use by\n${users}` : description}
      className={cn(
        "relative flex min-w-0 flex-col gap-1 rounded-[3px] border p-2.5 transition-colors",
        inUse ? "border-signal bg-signal-soft" : "bg-card",
      )}
    >
      <span
        aria-hidden
        className={cn("absolute -top-2.5 left-1/2 h-2.5 w-0.5 -translate-x-1/2", inUse ? "bg-signal" : "bg-border")}
      />
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className={cn("size-3.5 shrink-0", inUse ? "text-signal-ink" : "text-muted-foreground")} />
        <span className="truncate">{label}</span>
        {inUse && <Lamp className="ml-auto" />}
      </p>
      <p className={cn("truncate font-mono text-xs", inUse ? "text-foreground" : "text-muted-foreground")}>
        {inUse ? workers : "Idle"}
      </p>
      {load.helpers > 0 && (
        <p className="truncate font-mono text-[11px] text-muted-foreground">+{plural(load.helpers, "subagent")}</p>
      )}
      {inUse && <span className="sr-only">In use by {load.taskIds.map(titleOf).join(", ")}</span>}
    </li>
  );
}

function PowerBus({
  load,
  titleOf,
  className,
}: {
  load: Record<SystemId, SystemLoad>;
  titleOf: TitleOf;
  className?: string;
}) {
  const busy = SYSTEMS.filter((system) => load[system.id].taskIds.length > 0 || load[system.id].helpers > 0).length;
  return (
    <section aria-labelledby="viz-systems" className={cn("min-w-0 space-y-3 p-4 sm:p-5", className)}>
      <div className="flex items-baseline gap-3">
        <h3 id="viz-systems" className="text-sm font-semibold tracking-tight">
          Power bus
        </h3>
        <p className="font-mono text-xs text-muted-foreground">
          {busy} of {SYSTEMS.length} in use
        </p>
      </div>
      <div className="scrollbar-subtle -mx-4 overflow-x-auto px-4 pb-1 sm:-mx-5 sm:px-5">
        <div className="relative min-w-[56rem]">
          <div aria-hidden className="absolute inset-x-0 top-0 h-1 bg-foreground/15" />
          <ul className="grid grid-cols-8 gap-2 pt-3.5">
            {SYSTEMS.map((system) => (
              <Socket
                key={system.id}
                id={system.id}
                label={system.label}
                description={system.description}
                load={load[system.id]}
                titleOf={titleOf}
              />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The floor

/**
 * The shop floor: intake lane → stations (with subagents) → rework bay / shipping dock, the power
 * bus underneath, and wires for which system each worker draws on and how workers relate. The
 * wires only show from lg up where the zones sit side by side; every link is also listed as a chip.
 */
export function AgentMap({
  dashboard,
  live,
  now,
  attentionTotal,
}: {
  dashboard: Dashboard;
  live: Record<string, LiveAgent>;
  now: number;
  attentionTotal: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { queue, attention, finished, totals } = dashboard;
  const titleOf = useMemo<TitleOf>(() => {
    const titles = new Map<string, string>();
    for (const card of [...finished, ...attention]) titles.set(card.id, card.title);
    for (const entry of [...queue.queued, ...queue.running]) titles.set(entry.taskId, entry.title);
    return (taskId) => titles.get(taskId) ?? "another card";
  }, [queue, attention, finished]);
  const links = useMemo(() => buildLinks(queue, live, now), [queue, live, now]);
  const load = useMemo(() => systemLoad(queue, live), [queue, live]);
  const wires = useMemo(() => buildWires(queue, live, links, titleOf), [queue, live, links, titleOf]);
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

  return (
    <section aria-labelledby="viz-agents" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 id="viz-agents" className="text-lg font-semibold tracking-tight">
            Shop floor
          </h2>
          <p className="font-mono text-xs text-muted-foreground">
            {queue.running.length} at work · {queue.queued.length} in line · {plural(links.length, "link")}
          </p>
        </div>
        <WireLegend className="hidden max-w-2xl justify-end lg:flex" />
      </div>
      <div ref={containerRef} className="relative isolate rounded-[3px] border bg-muted/40">
        <Wiring containerRef={containerRef} wires={wires} className="z-0 hidden lg:block" />
        <div className={cn(MAP_GRID, "relative z-10")}>
          <IntakeLane
            queue={queue}
            linksByTask={linksByTask}
            titleOf={titleOf}
            className={cn(LANE, "border-b-2 lg:border-r-2 lg:border-b-0")}
          />
          <Stations
            queue={queue}
            live={live}
            linksByTask={linksByTask}
            titleOf={titleOf}
            className={cn(LANE, "border-b-2 xl:border-r-2")}
          />
          <div
            className={cn(
              LANE,
              "grid min-w-0 grid-cols-1 content-start border-b-2 lg:col-span-2 lg:grid-cols-2 xl:col-span-1 xl:grid-cols-1",
            )}
          >
            <ReworkBay
              cards={attention}
              total={attentionTotal}
              className={cn(LANE, "border-b-2 lg:border-r-2 lg:border-b-0 xl:border-r-0 xl:border-b-2")}
            />
            <ShippingDock cards={finished} shipped={totals.done} now={now} />
          </div>
          <PowerBus load={load} titleOf={titleOf} className="lg:col-span-full" />
        </div>
      </div>
    </section>
  );
}
