"use client";

import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from "react";
import Link from "next/link";
import {
  Building2Icon,
  CrownIcon,
  FlameIcon,
  LockIcon,
  MedalIcon,
  PlayIcon,
  RocketIcon,
  ShieldCheckIcon,
  StickyNoteIcon,
} from "lucide-react";
import { cardHref } from "@/components/home/shared";
import { ACTIVITY_ICON } from "@/components/visualize/activity-icons";
import { type AchievementId, XP_PER_CARD, achievements, crewLevel, workerIdentity } from "@/components/visualize/game";
import type { LiveAgent } from "@/components/visualize/use-live-agents";
import { WorkerAvatar } from "@/components/visualize/worker-avatar";
import type { Dashboard, QueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Running cards listed in the ticker before it folds the rest into "+N more". */
const MAX_TICKER = 3;
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

function TickerRow({
  entry,
  agent,
  startedAt,
  now,
  index,
}: {
  entry: QueueEntry;
  agent: LiveAgent | undefined;
  startedAt: string | null;
  now: number;
  index: number;
}) {
  const worker = workerIdentity(entry.taskId);
  const activity = agent?.activity;
  const Icon = activity ? ACTIVITY_ICON[activity.icon] : null;
  const shift = shiftLength(agent?.startedAt ?? startedAt, now);
  return (
    <li
      className="animate-floor-in flex min-w-0 items-center gap-4 py-4"
      style={{ "--i": index } as CSSProperties}
    >
      <WorkerAvatar hue={worker.hue} mood="working" className="size-10" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex min-w-0 items-baseline gap-2.5">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{worker.name}</span>
          <Link
            href={cardHref({ boardId: entry.boardId, id: entry.taskId })}
            title={`${entry.title} in ${entry.boardName}`}
            className="inline-block min-w-0 truncate rounded-[3px] text-base font-medium transition-[color,scale] outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:active:scale-100"
          >
            {entry.title}
          </Link>
        </p>
        <p className="flex min-w-0 items-center gap-2 font-mono text-sm text-muted-foreground">
          {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
          <span className="shrink-0 text-foreground">{activity?.label ?? "Clocking in"}</span>
          {activity?.detail && <span className="min-w-0 truncate">{activity.detail}</span>}
        </p>
      </div>
      {shift && (
        <span className="shrink-0 font-mono text-sm text-muted-foreground tabular-nums" title="Time at the station">
          {shift}
        </span>
      )}
    </li>
  );
}

function FloorPulse({ dashboard, live, now }: { dashboard: Dashboard; live: Record<string, LiveAgent>; now: number }) {
  const { queue } = dashboard;
  const running = queue.running.length;
  const startedAt = new Map(dashboard.live.map((agent) => [agent.taskId, agent.startedAt]));
  const shown = queue.running.slice(0, MAX_TICKER);
  const more = running - shown.length;

  return (
    <div className="flex min-w-0 flex-col self-start lg:col-span-7">
      <h2 className="sr-only">Floor</h2>
      <p className="mb-3 flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <Lamp live={running > 0} />
        {running > 0 ? "At the station" : "Stations idle"}
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
              {shown.map((entry, index) => (
                <TickerRow
                  key={entry.taskId}
                  entry={entry}
                  agent={live[entry.taskId]}
                  startedAt={startedAt.get(entry.taskId) ?? null}
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
