"use client";

import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from "react";
import Link from "next/link";
import {
  Building2Icon,
  CheckIcon,
  CrownIcon,
  FlameIcon,
  LockIcon,
  MedalIcon,
  PlayIcon,
  RocketIcon,
  ServerIcon,
  ShieldCheckIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cardHref } from "@/components/home/shared";
import { ACTIVITY_ICON } from "@/components/visualize/activity-icons";
import { sdlcStation } from "@/components/visualize/agent-map";
import { type AchievementId, XP_PER_CARD, achievements, crewLevel, workerIdentity } from "@/components/visualize/game";
import { agentVitals, moodTone, type Vitals } from "@/components/visualize/mood";
import { modelLabel, ROLE_INFO, roleOf, subagentName } from "@/components/visualize/roles";
import type { LiveAgent } from "@/components/visualize/use-live-agents";
import { ManaBar, MOOD_LABEL, RoleTag, WorkerAvatar } from "@/components/visualize/worker-avatar";
import { SDLC_PHASE_INFO, type SdlcProgress } from "@/lib/sdlc";
import type { Dashboard, QueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Running cards listed in the ticker before it folds the rest into "+N more". */
const MAX_TICKER = 3;
/** Busy subagents named under a ticker row before the rest fold into "+N". */
const MAX_CREW = 4;
/** The XP gauge never draws more ticks than this; past it one tick stands for several cards. */
const MAX_TICKS = 24;
/** How long a stamp ("+100 XP", a freshly earned badge) stays marked as new. */
const FRESH_MS = 2400;

const NUMBER = new Intl.NumberFormat("en-US");

const ACHIEVEMENT_ICON: Record<AchievementId, ComponentType<{ className?: string }>> = {
  "first-card": StickyNoteIcon,
  "first-run": PlayIcon,
  "first-ship": RocketIcon,
  "ten-shipped": MedalIcon,
  "fifty-shipped": CrownIcon,
  "full-house": FlameIcon,
  "multi-project": Building2Icon,
  "all-clear": ShieldCheckIcon,
};

/** A number that rolls into place whenever its value changes (re-keyed on value). */
function Numeral({ value, className }: { value: number; className?: string }) {
  return (
    <span key={value} className={cn("animate-digit-roll font-semibold tracking-[-0.05em] tabular-nums", className)}>
      {NUMBER.format(value)}
    </span>
  );
}

/** Solid dot; while `live`, a ring breathes out of it. */
function Lamp({ live, className }: { live: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-2.5 shrink-0", className)}>
      {live && <span className="animate-lamp absolute inset-0 rounded-full bg-signal" />}
      <span className={cn("relative size-full rounded-full", live ? "bg-signal" : "bg-muted-foreground/40")} />
    </span>
  );
}

/** "12m", "1h 05m": how long a worker has been at the station, at the page clock's resolution. */
function shiftLength(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null;
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/** Keys that appeared since the previous render batch, kept for FRESH_MS so their stamp can play. */
function useFresh(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const signature = keys.join("\n");
  useEffect(() => {
    const current = new Set(signature ? signature.split("\n") : []);
    const previous = seen.current;
    seen.current = current;
    if (previous === null) return;
    const added = [...current].filter((key) => !previous.has(key));
    if (added.length > 0) setFresh(new Set(added));
  }, [signature]);
  useEffect(() => {
    if (fresh.size === 0) return;
    const timer = window.setTimeout(() => setFresh(new Set()), FRESH_MS);
    return () => window.clearTimeout(timer);
  }, [fresh]);
  return fresh;
}

/** "+XP" of the latest batch of cards shipped while the page is open; null when nothing just shipped. */
function useShipStamp(done: number): { key: number; xp: number } | null {
  const previous = useRef(done);
  const [stamp, setStamp] = useState<{ key: number; xp: number } | null>(null);
  useEffect(() => {
    const gained = done - previous.current;
    previous.current = done;
    if (gained > 0) setStamp({ key: done, xp: gained * XP_PER_CARD });
  }, [done]);
  useEffect(() => {
    if (stamp === null) return;
    const timer = window.setTimeout(() => setStamp(null), FRESH_MS);
    return () => window.clearTimeout(timer);
  }, [stamp]);
  return stamp;
}

// ---------------------------------------------------------------------------------------------
// Left: the floor's pulse

/** Thin 0..1 gauge for a vital (fatigue, load, heat); amber past half, red past 80%. */
function VitalMeter({ label, value, className }: { label: string; value: number; className?: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={cn("flex items-center gap-1.5", className)} title={`${label}: ${percent}%`}>
      <span className="w-8 text-right font-mono text-[10px] leading-none text-muted-foreground">{label}</span>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="relative h-1 w-16 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500",
            percent >= 80 ? "bg-destructive" : percent >= 50 ? "bg-signal" : "bg-muted-foreground/50",
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
    </div>
  );
}

/** The subagents a lead has working right now: robot, name, role and (when omp reported it) model each. */
function Crew({ taskId, agent }: { taskId: string; agent: LiveAgent | undefined }) {
  const busy = Object.values(agent?.helpers ?? {}).filter((s) => s.status === "running" || s.status === "pending");
  if (busy.length === 0) return null;
  const hidden = busy.length - MAX_CREW;
  return (
    <ul aria-label="Subagents at work" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {busy.slice(0, MAX_CREW).map((subagent) => {
        const role = roleOf(subagent.agent);
        const name = subagentName(subagent.id, subagent.agent);
        const { hue } = workerIdentity(`${taskId}:${subagent.id}`);
        return (
          <li
            key={subagent.id}
            className="flex min-w-0 items-center gap-1"
            title={`${name}: ${ROLE_INFO[role].label} (${subagent.agent} agent)${subagent.description ? `, ${subagent.description}` : ""}`}
          >
            <WorkerAvatar hue={hue} mood="working" role={role} animated={false} className="size-5 shrink-0" />
            <span className="max-w-32 truncate font-mono text-muted-foreground">{name}</span>
            <RoleTag hue={hue}>{ROLE_INFO[role].label}</RoleTag>
            {subagent.model && (
              <span
                className="max-w-36 truncate font-mono text-[11px] text-muted-foreground"
                title={`Model: ${subagent.model}`}
              >
                {modelLabel(subagent.model)}
              </span>
            )}
          </li>
        );
      })}
      {hidden > 0 && <li className="font-mono text-muted-foreground">+{hidden}</li>}
    </ul>
  );
}

/** "5/7 Testing": the SDLC phase a card's agent is in; warns when it crossed a quality gate early. */
function SdlcChip({ sdlc }: { sdlc: SdlcProgress }) {
  const info = SDLC_PHASE_INFO[sdlcStation(sdlc)];
  const phase = sdlc.phases.find((p) => p.id === info.id);
  const delivered = sdlc.current === null;
  const flagged = sdlc.violations.length > 0;
  const title = [
    delivered
      ? `Every SDLC phase done (${sdlc.completed} of ${sdlc.included})`
      : `SDLC phase ${info.step} of 7: ${info.label}, ${phase?.done ?? 0} of ${phase?.total ?? 0} items done, ${sdlc.completed} of ${sdlc.included} phases done`,
    ...sdlc.violations.map((violation) => `Quality gate: ${violation.message}`),
  ].join("\n");
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 self-center rounded-[3px] border px-1.5 font-mono text-[11px] leading-[18px] tabular-nums",
        flagged
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : delivered
            ? "border-success/40 text-success"
            : "text-muted-foreground",
      )}
    >
      {flagged ? (
        <TriangleAlertIcon className="size-3" aria-hidden />
      ) : (
        delivered && <CheckIcon className="size-3" aria-hidden />
      )}
      {delivered ? `${sdlc.completed}/${sdlc.included} done` : `${info.step}/7 ${info.label}`}
    </span>
  );
}

function TickerRow({
  entry,
  agent,
  vitals,
  startedAt,
  model,
  now,
  index,
}: {
  entry: QueueEntry;
  agent: LiveAgent | undefined;
  vitals: Vitals;
  startedAt: string | null;
  /** Model the lead runs on, when known. */
  model: string | null;
  now: number;
  index: number;
}) {
  const worker = workerIdentity(entry.taskId);
  const activity = agent?.activity;
  const Icon = activity ? ACTIVITY_ICON[activity.icon] : null;
  const shift = shiftLength(agent?.startedAt ?? startedAt, now);
  const href = cardHref({ boardId: entry.boardId, id: entry.taskId });
  const mood = MOOD_LABEL[vitals.mood];
  const tone = moodTone(vitals.mood);
  // The feeling often opens with the mood's own words ("Running hot: …"); don't say it twice.
  const echoed = vitals.feeling.toLowerCase().startsWith(mood.toLowerCase());
  return (
    <li
      className="animate-floor-in flex min-w-0 items-center gap-4 py-4"
      style={{ "--i": index } as CSSProperties}
    >
      <WorkerAvatar hue={worker.hue} mood={vitals.mood} role="lead" help={vitals.help !== null} className="size-10" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex min-w-0 items-baseline gap-2.5">
          <span className="flex shrink-0 items-baseline gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">{worker.name}</span>
            <RoleTag hue={worker.hue}>{ROLE_INFO.lead.label}</RoleTag>
            {entry.node && (
              <span
                title={`Running on cluster node ${entry.node.name}`}
                className="inline-flex max-w-28 items-center gap-0.5 self-center rounded-[3px] border border-border px-1 font-mono text-[10px] leading-[14px] text-muted-foreground"
              >
                <ServerIcon className="size-2.5 shrink-0" aria-hidden />
                <span className="sr-only">on node </span>
                <span className="truncate">{entry.node.name}</span>
              </span>
            )}
          </span>
          <Link
            href={href}
            title={`${entry.title} in ${entry.boardName}`}
            className="inline-block min-w-0 truncate rounded-[3px] text-base font-medium transition-[color,scale] outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:active:scale-100"
          >
            {entry.title}
          </Link>
          {entry.sdlc && <SdlcChip sdlc={entry.sdlc} />}
        </p>
        <p className="flex min-w-0 items-center gap-2 font-mono text-sm text-muted-foreground">
          {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
          <span className="shrink-0 text-foreground">{activity?.label ?? "Clocking in"}</span>
          {activity?.detail && <span className="min-w-0 truncate">{activity.detail}</span>}
        </p>
        <Crew taskId={entry.taskId} agent={agent} />
        <p
          className={cn(
            "flex min-w-0 items-center gap-2 text-xs",
            tone === "error" ? "text-destructive" : tone === "strain" ? "text-signal-ink" : "text-muted-foreground",
          )}
        >
          {!echoed && <span className="shrink-0 font-medium">{mood}</span>}
          <span className="min-w-0 truncate" title={vitals.feeling}>
            {vitals.feeling}
          </span>
          {vitals.help && (
            <Link
              href={href}
              title={vitals.help.text}
              aria-label={`Needs help: ${vitals.help.text}. Open ${entry.title}`}
              className="shrink-0 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 font-medium text-destructive transition-colors outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-ring"
            >
              Needs help
            </Link>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {shift && (
          <span className="font-mono text-sm text-muted-foreground tabular-nums" title="Time at the station">
            {shift}
          </span>
        )}
        {model && (
          <span className="max-w-32 truncate font-mono text-[11px] text-muted-foreground" title={`Model: ${model}`}>
            {modelLabel(model)}
          </span>
        )}
        <div className="flex flex-col items-end gap-1" title={vitals.notes.join("\n") || undefined}>
          <div className="flex items-center gap-1.5">
            <span className="w-8 text-right font-mono text-[10px] leading-none text-muted-foreground">Mana</span>
            <ManaBar value={vitals.mana} className="w-16" />
          </div>
          <VitalMeter label="Tired" value={vitals.fatigue} className="hidden sm:flex" />
          <VitalMeter label="Load" value={vitals.load} className="hidden sm:flex" />
          <VitalMeter label="Heat" value={vitals.heat} className="hidden sm:flex" />
        </div>
      </div>
    </li>
  );
}

function FloorPulse({ dashboard, live, now }: { dashboard: Dashboard; live: Record<string, LiveAgent>; now: number }) {
  const { queue } = dashboard;
  const running = queue.running.length;
  const startedAt = new Map(dashboard.live.map((agent) => [agent.taskId, agent.startedAt]));
  const context = new Map(dashboard.live.map((agent) => [agent.taskId, agent.context]));
  const model = new Map(dashboard.live.map((agent) => [agent.taskId, agent.model]));
  const rows = queue.running.map((entry) => ({
    entry,
    vitals: agentVitals(live[entry.taskId], now, context.get(entry.taskId)),
  }));
  const needHelp = rows.filter((row) => row.vitals.help !== null).length;
  const shown = rows.slice(0, MAX_TICKER);
  const more = running - shown.length;

  return (
    <div className="flex min-w-0 flex-col self-start lg:col-span-7">
      <h2 className="sr-only">Floor</h2>
      <p className="mb-3 flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <Lamp live={running > 0} />
        {running > 0 ? "At the station" : "Stations idle"}
        {needHelp > 0 && (
          <span className="text-destructive">
            · {needHelp} {needHelp === 1 ? "needs" : "need"} help
          </span>
        )}
      </p>
      <p className="flex items-baseline leading-none" aria-label={`${running} of ${queue.limit} stations working`}>
        <Numeral value={running} className={cn("text-7xl leading-none sm:text-8xl", running > 0 && "text-signal-ink")} />
        <span className="ml-2 text-4xl font-semibold tracking-[-0.05em] text-muted-foreground tabular-nums sm:text-5xl">
          / <Numeral value={queue.limit} />
        </span>
      </p>

      <div className="mt-6 border-t">
        {running > 0 ? (
          <>
            <ul className="divide-y" aria-label="Workers at the station">
              {shown.map(({ entry, vitals }, index) => (
                <TickerRow
                  key={entry.taskId}
                  entry={entry}
                  agent={live[entry.taskId]}
                  vitals={vitals}
                  startedAt={startedAt.get(entry.taskId) ?? null}
                  model={model.get(entry.taskId) ?? null}
                  now={now}
                  index={index}
                />
              ))}
            </ul>
            {more > 0 && (
              <p className="border-t py-3 font-mono text-sm text-muted-foreground">+{more} more at the station</p>
            )}
          </>
        ) : (
          <div className="flex items-center gap-4 py-4 text-sm text-muted-foreground">
            <WorkerAvatar hue={235} mood="sleeping" animated={false} className="size-10 opacity-70" />
            <p className="min-w-0">
              {queue.queued.length > 0
                ? "The floor is quiet. Cards in line start as soon as their station frees up."
                : "The floor is quiet. Start a card from a board to put a worker on it."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Right: the crew plate

function XpGauge({ start, next, xp }: { start: number; next: number; xp: number }) {
  const cards = Math.max(1, Math.round((next - start) / XP_PER_CARD));
  const done = Math.min(cards, Math.max(0, Math.round((xp - start) / XP_PER_CARD)));
  const perTick = Math.ceil(cards / MAX_TICKS);
  const ticks = Math.ceil(cards / perTick);
  const filled = Math.floor(done / perTick);
  return (
    <div className="space-y-2">
      <div
        role="progressbar"
        aria-label="XP to the next level"
        aria-valuemin={start}
        aria-valuemax={next}
        aria-valuenow={xp}
        aria-valuetext={`${NUMBER.format(xp - start)} of ${NUMBER.format(next - start)} XP this level`}
        className="flex gap-1"
      >
        {Array.from({ length: ticks }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-3 min-w-1 flex-1 rounded-[3px] transition-colors duration-500 motion-reduce:transition-none",
              i < filled ? "bg-signal" : "bg-floor-paint",
            )}
          />
        ))}
      </div>
      {perTick > 1 && (
        <p className="font-mono text-[11px] text-muted-foreground">One tick is {perTick} cards</p>
      )}
    </div>
  );
}

function CrewPlate({ dashboard }: { dashboard: Dashboard }) {
  const done = dashboard.totals.done;
  const crew = crewLevel(done);
  const badges = achievements(dashboard);
  const unlocked = badges.filter((badge) => badge.unlocked);
  const freshBadges = useFresh(unlocked.map((badge) => badge.id));
  const stamp = useShipStamp(done);
  const cardsLeft = Math.max(0, Math.round((crew.nextLevelXp - crew.xp) / XP_PER_CARD));

  return (
    <section
      aria-labelledby="crew-rank"
      className="min-w-0 rounded-[3px] border bg-card p-5 text-card-foreground shadow-[0_1px_0_var(--color-border)] sm:p-6 lg:col-span-5"
    >
      <div className="flex items-end gap-5">
        <div className="shrink-0">
          <p className="mb-2 font-mono text-xs text-muted-foreground">Crew level</p>
          <Numeral value={crew.level} className="text-7xl leading-none sm:text-8xl" />
        </div>
        <div className="relative min-w-0 flex-1 pb-1">
          <h2 id="crew-rank" className="truncate text-xl font-semibold tracking-tight">
            {crew.rank}
          </h2>
          <p className="mt-1 font-mono text-sm text-signal-ink tabular-nums">
            <span key={crew.xp} className="animate-digit-roll">
              {NUMBER.format(crew.xp)} XP
            </span>
          </p>
          {stamp && (
            <span
              key={stamp.key}
              aria-hidden
              className="animate-stamp pointer-events-none absolute -top-3 right-0 rounded-[3px] border-2 border-signal px-1.5 py-0.5 font-mono text-xs font-semibold text-signal-ink"
            >
              +{NUMBER.format(stamp.xp)} XP
            </span>
          )}
        </div>
      </div>

      <div className="mt-6">
        <XpGauge start={crew.levelStartXp} next={crew.nextLevelXp} xp={crew.xp} />
        <p className="mt-2 flex items-baseline justify-between gap-3 font-mono text-xs text-muted-foreground">
          <span>
            {cardsLeft} {cardsLeft === 1 ? "card" : "cards"} to level {crew.level + 1}
          </span>
          <span className="shrink-0">{XP_PER_CARD} XP per card shipped</span>
        </p>
      </div>

      <div className="mt-6 border-t pt-5">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-medium">Badges</h3>
          <p className="font-mono text-xs text-muted-foreground tabular-nums">
            {unlocked.length} of {badges.length}
          </p>
        </div>
        <ul className="flex flex-wrap gap-2">
          {badges.map((badge) => {
            const Icon = badge.unlocked ? ACHIEVEMENT_ICON[badge.id] : LockIcon;
            const label = `${badge.title}: ${badge.description}${badge.unlocked ? " (earned)" : " (locked)"}`;
            return (
              <li
                key={badge.id}
                title={label}
                aria-label={label}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-[3px] border px-2 py-1 text-xs transition-colors",
                  badge.unlocked
                    ? "border-signal bg-signal-soft font-medium text-foreground"
                    : "border-dashed border-floor-paint text-muted-foreground",
                  freshBadges.has(badge.id) && "animate-stamp",
                )}
              >
                <Icon className={cn("size-3.5 shrink-0", badge.unlocked && "text-signal-ink")} aria-hidden />
                {badge.title}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** Hero of the Visualize page: the floor's pulse on the left, the crew plate on the right. */
export function ControlRoom({
  dashboard,
  live,
  now,
}: {
  dashboard: Dashboard;
  live: Record<string, LiveAgent>;
  now: number;
}) {
  return (
    <section aria-label="Control room" className="grid gap-10 lg:grid-cols-12 lg:gap-12">
      <FloorPulse dashboard={dashboard} live={live} now={now} />
      <CrewPlate dashboard={dashboard} />
    </section>
  );
}
