"use client";

import {
  createContext,
  type ComponentType,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import Link from "next/link";
import {
  BrainIcon,
  CodeIcon,
  DatabaseIcon,
  GlobeIcon,
  InboxIcon,
  LightbulbIcon,
  MessagesSquareIcon,
  PackageCheckIcon,
  ServerIcon,
  TerminalIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import { formatDuration, formatRelative } from "@/components/board/format";
import { FOCUS_RING, cardHref, plural } from "@/components/home/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Activity } from "@/components/visualize/activity";
import {
  buildLinks,
  type CardLink,
  type DepartmentId,
  type FloorWorker,
  floorPlan,
  SYSTEMS,
  type SystemId,
} from "@/components/visualize/agent-map";
import { workerIdentity } from "@/components/visualize/game";
import { agentVitals, moodTone, subagentVitals } from "@/components/visualize/mood";
import { type AgentRole, modelLabel, ROLE_INFO, roleOf, subagentName } from "@/components/visualize/roles";
import type { LiveAgent } from "@/components/visualize/use-live-agents";
import { ManaBar, MOOD_LABEL, RoleTag, WorkerAvatar, type WorkerMood } from "@/components/visualize/worker-avatar";
import type { ContextUsage, Dashboard } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Workers drawn per room; the rest fold into "+N". */
const MAX_IN_ROOM = 8;
/** Walking pace: ms per pixel of distance, clamped so short hops and long treks both read. */
const WALK_MS_PER_PX = 2.2;
const WALK_MIN_MS = 650;
const WALK_MAX_MS = 2400;
/** One waddle cycle (left foot, right foot) while walking. */
const STEP_MS = 520;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Before the first live event of a run arrives. */
const STARTING: Activity = { icon: "status", label: "Starting" };

/** Hue of the robots in the legend: one colour, so only the silhouette and face differ. */
const LEGEND_HUE = 235;

/** Card agents are always leads. */
const LEAD = ROLE_INFO.lead.label;

/**
 * Floor plan. Phones: 2 columns, rooms stacked. md: intake and rework side by side, the eight
 * departments 4 × 2, the dock below. xl: intake over rework on the left, departments in the
 * middle, the dock down the right.
 */
export const FLOOR_GRID =
  "grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-[minmax(12rem,15rem)_repeat(4,minmax(0,1fr))_minmax(12rem,15rem)]";

interface Room {
  name: string;
  /** What happens in the room, one line. */
  role: string;
  icon: ComponentType<{ className?: string }>;
  /** Shown when nobody is in the room. */
  empty: string;
  place?: string;
}

const ROOMS: Record<DepartmentId, Room> = {
  intake: {
    name: "Receiving",
    role: "Cards waiting for a free station",
    icon: InboxIcon,
    empty: "Nobody waiting",
    place: "col-span-2 xl:col-span-1 xl:col-start-1 xl:row-start-1",
  },
  model: { name: "Design office", role: "Thinking, planning, writing", icon: BrainIcon, empty: "Idle" },
  files: { name: "Code shop", role: "Reading and editing files", icon: CodeIcon, empty: "Idle" },
  shell: { name: "Build & test", role: "Running commands and tests", icon: TerminalIcon, empty: "Idle" },
  web: { name: "Research lab", role: "Searching and browsing the web", icon: GlobeIcon, empty: "Idle" },
  memory: { name: "Archive", role: "Recalling and saving memories", icon: DatabaseIcon, empty: "Idle" },
  board: { name: "Dispatch", role: "Talking to other cards", icon: MessagesSquareIcon, empty: "Idle" },
  advisor: { name: "Advisor's office", role: "Getting a second opinion", icon: LightbulbIcon, empty: "Idle" },
  helpers: { name: "Team room", role: "Briefing and waiting on subagents", icon: UsersIcon, empty: "Idle" },
  rework: {
    name: "Rework bay",
    role: "Failed or stalled, needs you",
    icon: TriangleAlertIcon,
    empty: "All clear",
    place: "col-span-2 xl:col-span-1 xl:col-start-1 xl:row-start-2",
  },
  shipping: {
    name: "Shipping dock",
    role: "Recently finished cards",
    icon: PackageCheckIcon,
    empty: "Nothing shipped yet",
    place: "col-span-2 md:col-span-4 xl:col-span-1 xl:col-start-6 xl:row-start-1 xl:row-span-2",
  },
};

/** Room order in the DOM (and on phones): explicit xl placements above let the departments auto-flow. */
const ORDER: DepartmentId[] = ["intake", "rework", ...SYSTEMS.map((system) => system.id), "shipping"];

/** Card id → title, for links that name other cards. */
type TitleOf = (taskId: string) => string;

/** One link as a sentence, for tooltips and screen readers. */
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
  }
}

// ---------------------------------------------------------------------------------------------
// Walking

/** Where each worker last stood, relative to the floor; a resize bumps `generation` to forget it. */
interface FloorState {
  root: RefObject<HTMLDivElement | null>;
  spots: Map<string, { x: number; y: number; generation: number }>;
  generation: number;
  /** False during the first paint, so the page opens without everyone walking in. */
  ready: boolean;
}

const FloorContext = createContext<FloorState | null>(null);

/**
 * Makes a worker walk (FLIP) from where it last stood, under any room, to where it stands now.
 * `outer` keeps the layout box and is measured; `inner` carries the animation so a walk in
 * progress never skews the next measurement. A worker seen for the first time steps out of
 * `origin` (a subagent leaving its agent) or, failing that, fades in where it stands.
 */
function useWalk(id: string, origin?: string) {
  const floor = useContext(FloorContext);
  const outer = useRef<HTMLLIElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  // No deps: every render may have moved the worker to another room or slot.
  useLayoutEffect(() => {
    const root = floor?.root.current;
    const box = outer.current;
    const body = inner.current;
    if (!floor || !root || !box || !body) return;
    const rootRect = root.getBoundingClientRect();
    const rect = box.getBoundingClientRect();
    const spot = { x: rect.left - rootRect.left, y: rect.top - rootRect.top, generation: floor.generation };
    const own = floor.spots.get(id);
    floor.spots.set(id, spot);
    if (!floor.ready || window.matchMedia(REDUCED_MOTION).matches) return;

    const from = own ?? (origin ? floor.spots.get(origin) : undefined);
    if (!from) {
      body.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], {
        duration: 420,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
      return;
    }
    if (from.generation !== floor.generation) return;
    const dx = from.x - spot.x;
    const dy = from.y - spot.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 3) return;

    const duration = Math.min(WALK_MAX_MS, Math.max(WALK_MIN_MS, distance * WALK_MS_PER_PX));
    body.style.zIndex = "30";
    body.dataset.walking = "";
    const walk = body.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration,
      easing: "cubic-bezier(0.45, 0, 0.25, 1)",
    });
    body.querySelector<HTMLElement>("[data-waddle]")?.animate(
      [
        { transform: "translateY(0) rotate(-6deg)" },
        { transform: "translateY(-3px) rotate(0deg)" },
        { transform: "translateY(0) rotate(6deg)" },
        { transform: "translateY(-3px) rotate(0deg)" },
        { transform: "translateY(0) rotate(-6deg)" },
      ],
      { duration: STEP_MS, iterations: Math.max(1, Math.round(duration / STEP_MS)) },
    );
    walk.finished
      .then(() => {
        body.style.zIndex = "";
        delete body.dataset.walking;
      })
      .catch(() => {});
  });

  return { outer, inner };
}

// ---------------------------------------------------------------------------------------------
// Workers

interface TokenView {
  href: string;
  /** Who the worker is: the card's robot name, or the name its lead gave a subagent. */
  name: string;
  caption: ReactNode;
  mood: WorkerMood;
  role: AgentRole;
  /** The role's human label, drawn as a tag under the name. */
  roleLabel: string;
  /** Model the agent runs on, drawn as a muted chip under the role tag; undefined draws none. */
  model?: string;
  /** Cluster node the agent runs on, drawn as a muted chip under the model; undefined draws none. */
  node?: string;
  /** Draws the "!" help bubble: the worker needs the user. */
  help?: boolean;
  /** Context window left (0..1, null unknown); undefined draws no mana bar. */
  mana?: number | null;
  hue: number;
  /** Accessible name of the link. */
  label: string;
  details: ReactNode;
  small?: boolean;
  tone?: "error" | "strain";
}

/** A worker standing in a room: robot, name, role tag, model and what it is doing; hover for the details. */
function Token({ id, origin, view }: { id: string; origin?: string; view: TokenView }) {
  const { outer, inner } = useWalk(id, origin);
  return (
    <li ref={outer} className="w-20 min-w-0">
      <div ref={inner} className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={view.href}
              aria-label={view.label}
              className={cn(
                "group flex flex-col items-center gap-0.5 rounded-[3px] px-1 py-1.5 text-center transition-colors hover:bg-muted",
                FOCUS_RING,
              )}
            >
              <span data-waddle className="block origin-bottom">
                <WorkerAvatar
                  hue={view.hue}
                  mood={view.mood}
                  role={view.role}
                  help={view.help}
                  className={view.small ? "size-8" : "size-11"}
                />
              </span>
              {view.mana !== undefined && <ManaBar value={view.mana} className={view.small ? "w-7" : "w-9"} />}
              <span className="max-w-full truncate font-mono text-[11px] leading-tight font-medium">{view.name}</span>
              <RoleTag hue={view.hue}>{view.roleLabel}</RoleTag>
              {/* Full id is in the hover card's details; a native title would stack a second tooltip on it. */}
              {view.model && (
                <span className="max-w-full truncate font-mono text-[11px] leading-tight text-muted-foreground">
                  {modelLabel(view.model)}
                </span>
              )}
              {view.node && (
                <span className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-[3px] border border-border px-1 font-mono text-[10px] leading-[14px] text-muted-foreground">
                  <ServerIcon className="size-2.5 shrink-0" aria-hidden />
                  <span className="truncate">{view.node}</span>
                </span>
              )}
              <span
                className={cn(
                  "max-w-full truncate text-[10px] leading-tight",
                  view.tone === "error"
                    ? "text-destructive"
                    : view.tone === "strain"
                      ? "text-signal-ink"
                      : "text-muted-foreground",
                )}
              >
                {view.caption}
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-72">
            {view.details}
          </TooltipContent>
        </Tooltip>
      </div>
    </li>
  );
}

function Details({ title, lines }: { title: string; lines: (ReactNode | null | false | undefined)[] }) {
  return (
    <div className="space-y-0.5 text-left">
      <p className="font-medium">{title}</p>
      {lines.filter(Boolean).map((line, i) => (
        <p key={i} className="opacity-80">
          {line}
        </p>
      ))}
    </div>
  );
}

/** Everything a token needs to draw one floor worker. */
function viewOf(
  worker: FloorWorker,
  live: Record<string, LiveAgent>,
  contexts: ReadonlyMap<string, ContextUsage | null>,
  models: ReadonlyMap<string, string | null>,
  links: Map<string, CardLink[]>,
  titleOf: TitleOf,
  now: number,
): TokenView {
  switch (worker.kind) {
    case "running": {
      const { entry } = worker;
      const agent = live[entry.taskId];
      const activity = agent?.activity ?? STARTING;
      const { name, hue } = workerIdentity(entry.taskId);
      const started = agent?.startedAt ? Date.parse(agent.startedAt) : Number.NaN;
      const busy = Object.values(agent?.helpers ?? {}).filter(
        (s) => s.status === "running" || s.status === "pending",
      ).length;
      const vitals = agentVitals(agent, now, contexts.get(entry.taskId));
      const model = models.get(entry.taskId) ?? undefined;
      return {
        href: cardHref({ boardId: entry.boardId, id: entry.taskId }),
        name,
        caption: activity.label,
        mood: vitals.mood,
        role: "lead",
        roleLabel: LEAD,
        model,
        node: entry.node?.name,
        help: vitals.help !== null,
        mana: vitals.mana,
        hue,
        tone: moodTone(vitals.mood),
        label: `${name} (${LEAD}), ${MOOD_LABEL[vitals.mood].toLowerCase()}: ${activity.label}, on ${entry.title} in ${entry.boardName}${model ? `, model ${modelLabel(model)}` : ""}${entry.node ? `, on node ${entry.node.name}` : ""}`,
        details: (
          <Details
            title={entry.title}
            lines={[
              `${name} · ${LEAD} · ${entry.boardName}${Number.isNaN(started) ? "" : ` · ${formatDuration(now - started)} on this run`}`,
              `${activity.label}${activity.detail ? `: ${activity.detail}` : ""}`,
              model && `Model: ${model}`,
              entry.node && `Running on cluster node ${entry.node.name}`,
              vitals.feeling,
              ...vitals.notes,
              vitals.help && `Needs help: ${vitals.help.text}`,
              busy > 0 && `${plural(busy, "subagent")} working`,
              ...(links.get(entry.taskId) ?? []).map((link) => linkSentence(link, titleOf)),
            ]}
          />
        ),
      };
    }
    case "subagent": {
      const { entry, subagent } = worker;
      const parent = workerIdentity(entry.taskId).name;
      const name = subagentName(subagent.id, subagent.agent);
      const task = subagent.description ?? subagent.agent;
      const parentWindow = contexts.get(entry.taskId)?.contextWindow || live[entry.taskId]?.context?.contextWindow;
      const vitals = subagentVitals(subagent, now, parentWindow);
      const role = roleOf(subagent.agent);
      const info = ROLE_INFO[role];
      return {
        href: cardHref({ boardId: entry.boardId, id: entry.taskId }),
        name,
        caption: `for ${parent}`,
        mood: vitals.mood,
        role,
        roleLabel: info.label,
        model: subagent.model,
        help: vitals.help !== null,
        mana: vitals.mana,
        hue: workerIdentity(`${entry.taskId}:${subagent.id}`).hue,
        small: true,
        tone: moodTone(vitals.mood),
        label: `${name}, ${parent}'s ${info.label.toLowerCase()} (${subagent.agent} agent), ${MOOD_LABEL[vitals.mood].toLowerCase()}${subagent.currentTool ? `, using ${subagent.currentTool}` : ""}${subagent.model ? `, model ${modelLabel(subagent.model)}` : ""}`,
        details: (
          <Details
            title={name}
            lines={[
              `${info.label} · ${subagent.agent} agent · working for ${parent}`,
              info.description,
              subagent.model && `Model: ${subagent.model}`,
              task !== subagent.agent && task,
              subagent.currentTool && `Using ${subagent.currentTool}`,
              vitals.feeling,
              ...vitals.notes,
              vitals.help && `Needs help: ${vitals.help.text}`,
              entry.title,
            ]}
          />
        ),
      };
    }
    case "queued": {
      const { entry, position } = worker;
      const { name, hue } = workerIdentity(entry.taskId);
      return {
        href: cardHref({ boardId: entry.boardId, id: entry.taskId }),
        name,
        caption: entry.planning ? `#${position} planning` : `#${position} in line`,
        mood: "waiting",
        role: "lead",
        roleLabel: LEAD,
        hue,
        label: `${name}, #${position} in line: ${entry.title} in ${entry.boardName}`,
        details: (
          <Details
            title={entry.title}
            lines={[
              `${name} · ${LEAD} · ${entry.boardName} · #${position} in line`,
              entry.planning && "Being planned",
              entry.planNote,
              ...(links.get(entry.taskId) ?? []).map((link) => linkSentence(link, titleOf)),
            ]}
          />
        ),
      };
    }
    case "rework": {
      const { card } = worker;
      const { name, hue } = workerIdentity(card.id);
      const failed = card.reason === "failed";
      const error = failed && card.agentError ? card.agentError.split("\n", 1)[0] : null;
      return {
        href: cardHref(card),
        name,
        caption: failed ? "Failed" : "Stalled",
        mood: failed ? "error" : "sleeping",
        role: "lead",
        roleLabel: LEAD,
        // Failed and stalled cards both wait on the user.
        help: true,
        hue,
        tone: failed ? "error" : undefined,
        label: `${name}, ${failed ? "failed" : "stalled"}, needs help: ${card.title} in ${card.boardName}`,
        details: <Details title={card.title} lines={[`${name} · ${LEAD} · ${card.boardName}`, error]} />,
      };
    }
    case "shipped": {
      const { card } = worker;
      const { name, hue } = workerIdentity(card.id);
      const when = formatRelative(card.updatedAt, now);
      return {
        href: cardHref(card),
        name,
        caption: when,
        mood: "happy",
        role: "lead",
        roleLabel: LEAD,
        hue,
        label: `${name} finished ${card.title} in ${card.boardName}, ${when}`,
        details: <Details title={card.title} lines={[`${name} · ${LEAD} · ${card.boardName}`, `Finished ${when}`]} />,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Rooms

function RoomView({
  id,
  workers,
  render,
}: {
  id: DepartmentId;
  workers: FloorWorker[];
  render: (worker: FloorWorker) => ReactNode;
}) {
  const room = ROOMS[id];
  const Icon = room.icon;
  const occupied = workers.length > 0;
  const alarm = id === "rework" && occupied;
  const production = id !== "intake" && id !== "rework" && id !== "shipping";
  const hidden = workers.length - MAX_IN_ROOM;
  return (
    <section
      aria-labelledby={`room-${id}`}
      className={cn(
        "flex min-w-0 flex-col rounded-[3px] border bg-card transition-colors duration-500",
        production && occupied && "border-signal",
        alarm && "border-destructive/50",
        room.place,
      )}
    >
      {alarm && <div aria-hidden className="h-1.5 rounded-t-[2px] bg-hazard" />}
      <header className="flex items-start gap-2 px-3 pt-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-500",
            production && occupied ? "border-signal bg-signal-soft text-signal-ink" : "text-muted-foreground",
            alarm && "border-destructive/40 text-destructive",
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`room-${id}`} className="truncate text-sm leading-tight font-semibold tracking-tight">
            {room.name}
          </h3>
          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{room.role}</p>
        </div>
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            occupied ? "text-foreground" : "text-muted-foreground/60",
          )}
          aria-label={plural(workers.length, "worker")}
        >
          {workers.length}
        </span>
      </header>
      {occupied ? (
        <ul className="flex min-h-24 flex-1 flex-wrap content-start gap-1 p-2">
          {workers.slice(0, MAX_IN_ROOM).map(render)}
          {hidden > 0 && (
            <li className="flex h-14 items-center px-1 font-mono text-xs text-muted-foreground">+{hidden}</li>
          )}
        </ul>
      ) : (
        <p className="flex min-h-12 flex-1 items-center justify-center p-2 font-mono text-xs text-muted-foreground/70 md:min-h-24">
          {room.empty}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The floor

/**
 * The factory floor: one room per department. Every card with an agent is a robot worker that
 * stands in the room of whatever its agent is doing right now (thinking in the design office,
 * editing in the code shop, running tests in build & test, ...) and walks to the next room when
 * the activity changes. Busy subagents step out of their agent and walk to their own room; queued
 * cards wait in receiving, failed or stalled ones go to rework, finished ones to the shipping dock.
 */
export function FactoryFloor({
  dashboard,
  live,
  now,
}: {
  dashboard: Dashboard;
  live: Record<string, LiveAgent>;
  now: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const floor = useRef<FloorState>({ root, spots: new Map(), generation: 0, ready: false }).current;
  const previous = useRef<ReadonlyMap<string, SystemId>>(new Map());
  const { queue, attention, finished } = dashboard;

  const plan = useMemo(
    () => floorPlan({ queue, attention, finished }, live, previous.current),
    [queue, attention, finished, live],
  );
  const titleOf = useMemo<TitleOf>(() => {
    const titles = new Map<string, string>();
    for (const card of [...finished, ...attention]) titles.set(card.id, card.title);
    for (const entry of [...queue.queued, ...queue.running]) titles.set(entry.taskId, entry.title);
    return (taskId) => titles.get(taskId) ?? "another card";
  }, [queue, attention, finished]);
  const linksByTask = useMemo(() => {
    const map = new Map<string, CardLink[]>();
    for (const link of buildLinks(queue, live, now)) {
      for (const taskId of [link.from, link.to]) map.set(taskId, [...(map.get(taskId) ?? []), link]);
    }
    return map;
  }, [queue, live, now]);
  const contexts = useMemo(
    () => new Map(dashboard.live.map((agent) => [agent.taskId, agent.context])),
    [dashboard.live],
  );
  const models = useMemo(
    () => new Map(dashboard.live.map((agent) => [agent.taskId, agent.model])),
    [dashboard.live],
  );

  // Runs after every token's layout effect: the first paint has been measured, walks may start.
  useLayoutEffect(() => {
    previous.current = plan.placed;
    floor.ready = true;
  });

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      floor.generation++;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [floor]);

  const free = Math.max(0, queue.limit - queue.running.length);
  const helpers = plan.placed.size - queue.running.length;

  return (
    <section aria-labelledby="viz-floor" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <h2 id="viz-floor" className="text-lg font-semibold tracking-tight">
          Factory floor
        </h2>
        <p className="font-mono text-xs text-muted-foreground">
          {queue.running.length}/{queue.limit} stations busy
          {free > 0 && ` · ${free} free`} · {plural(helpers, "subagent")} · {queue.queued.length} in line
        </p>
      </div>
      <FloorContext.Provider value={floor}>
        <div ref={root} className={cn(FLOOR_GRID, "relative isolate rounded-[3px] border bg-muted/50 p-2")}>
          {ORDER.map((id) => (
            <RoomView
              key={id}
              id={id}
              workers={plan.rooms[id]}
              render={(worker) => (
                <Token
                  key={worker.id}
                  id={worker.id}
                  origin={worker.kind === "subagent" ? `card:${worker.entry.taskId}` : undefined}
                  view={viewOf(worker, live, contexts, models, linksByTask, titleOf, now)}
                />
              )}
            />
          ))}
        </div>
      </FloorContext.Provider>
      <FloorLegend />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Legend

/** "Who's who": what each robot silhouette, face and the mana bar mean. Collapsed by default. */
function FloorLegend() {
  const roles = Object.entries(ROLE_INFO) as [AgentRole, (typeof ROLE_INFO)[AgentRole]][];
  const moods = Object.entries(MOOD_LABEL) as [WorkerMood, string][];
  return (
    <details className="mt-3 text-xs text-muted-foreground">
      <summary
        className={cn(
          "w-fit cursor-pointer rounded-[3px] font-mono transition-colors select-none hover:text-foreground",
          FOCUS_RING,
        )}
      >
        Who&apos;s who
      </summary>
      <div className="mt-3 grid gap-x-8 gap-y-4 lg:grid-cols-2">
        <div>
          <p className="mb-2 font-medium text-foreground">Roles</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {roles.map(([role, info]) => (
              <li key={role} className="flex min-w-0 items-start gap-2">
                <WorkerAvatar hue={LEGEND_HUE} mood="working" role={role} animated={false} className="size-7 shrink-0" />
                <p className="min-w-0 leading-snug">
                  <span className="font-medium text-foreground">{info.label}</span> {info.description}
                </p>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-2 font-medium text-foreground">Moods</p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {moods.map(([mood, label]) => (
              <li key={mood} className="flex min-w-0 items-center gap-2">
                <WorkerAvatar hue={LEGEND_HUE} mood={mood} animated={false} className="size-7 shrink-0" />
                <span className="min-w-0 truncate">{label}</span>
              </li>
            ))}
            <li className="flex min-w-0 items-center gap-2">
              <WorkerAvatar hue={LEGEND_HUE} mood="working" help animated={false} className="size-7 shrink-0" />
              <span className="min-w-0 truncate">Needs you: open the card</span>
            </li>
          </ul>
          <p className="mt-3 flex items-center gap-2">
            <ManaBar value={0.6} className="w-9 shrink-0" />
            <span className="min-w-0">
              Mana: how much of the agent&apos;s context window is left. It drains as the run goes on.
            </span>
          </p>
        </div>
      </div>
    </details>
  );
}
