"use client";

import { type ComponentType, useMemo } from "react";
import Link from "next/link";
import { CheckIcon, InboxIcon, PackageCheckIcon, ShieldAlertIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { FOCUS_RING, cardHref, plural } from "@/components/home/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type GateBreach,
  type PipelineStation,
  type PipelineWorker,
  sdlcPipeline,
  sdlcStation,
} from "@/components/visualize/agent-map";
import { workerIdentity } from "@/components/visualize/game";
import { agentVitals, subagentVitals } from "@/components/visualize/mood";
import { ROLE_INFO, roleOf, subagentName } from "@/components/visualize/roles";
import type { LiveAgent } from "@/components/visualize/use-live-agents";
import { RoleTag, WorkerAvatar, WorkerOutline } from "@/components/visualize/worker-avatar";
import { SDLC_PHASE_INFO, SDLC_PHASES, type SdlcPhaseId, type SdlcPhaseStatus, type SdlcProgress } from "@/lib/sdlc";
import type { ContextUsage, Dashboard, QueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Card agents drawn per station; the rest fold into "+N more". */
const MAX_CARDS = 4;
/** Subagents drawn per station; the rest fold into "+N". */
const MAX_CREW = 6;
/** The gate that leaves this phase is the release gate: nothing ships before Testing passes. */
const RELEASE_FROM: SdlcPhaseId = "testing";

const STATUS_LABEL: Record<SdlcPhaseStatus, string> = {
  done: "done",
  active: "in progress",
  pending: "to do",
  skipped: "skipped",
};

const DOT: Record<SdlcPhaseStatus, string> = {
  done: "bg-success",
  active: "bg-signal",
  pending: "border border-muted-foreground/60",
  skipped: "bg-muted-foreground/15",
};

/** One dot per SDLC phase, in order: done, active (ringed while current), to do, skipped. */
function PhaseTrack({ sdlc }: { sdlc: SdlcProgress }) {
  const summary = sdlc.phases.map((phase) => `${SDLC_PHASE_INFO[phase.id].label}: ${STATUS_LABEL[phase.status]}`);
  return (
    <span
      role="img"
      aria-label={`Phases. ${summary.join(", ")}`}
      title={summary.join("\n")}
      className="flex items-center gap-1 @min-[62.5rem]:gap-[3px]"
    >
      {sdlc.phases.map((phase) => (
        <span
          key={phase.id}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            DOT[phase.status],
            phase.id === sdlc.current && "ring-2 ring-signal/35",
          )}
        />
      ))}
    </span>
  );
}

/** A card's progress as one sentence, for tooltips and screen readers. */
function progressSentence(entry: QueueEntry): string {
  const { sdlc } = entry;
  const info = SDLC_PHASE_INFO[sdlcStation(sdlc)];
  if (!sdlc) return `${info.label} (phase ${info.step} of 7), no plan yet`;
  const phase = sdlc.phases.find((p) => p.id === info.id);
  const items = sdlc.current === null ? "every phase done" : `${phase?.done ?? 0} of ${phase?.total ?? 0} items done`;
  const violations = sdlc.violations.map((violation) => violation.message).join("; ");
  return `${info.label} (phase ${info.step} of 7), ${items}, ${sdlc.completed} of ${sdlc.included} phases done${violations ? `. Quality gate: ${violations}` : ""}`;
}

/** A running card's agent at its station: robot, name, title, phase track and phase progress. */
function CardWorker({
  entry,
  agent,
  context,
  now,
}: {
  entry: QueueEntry;
  agent: LiveAgent | undefined;
  context: ContextUsage | null | undefined;
  now: number;
}) {
  const worker = workerIdentity(entry.taskId);
  const vitals = agentVitals(agent, now, context);
  const { sdlc } = entry;
  const phase = sdlc?.phases.find((p) => p.id === sdlcStation(sdlc));
  const flagged = (sdlc?.violations.length ?? 0) > 0;
  const progress = progressSentence(entry);
  return (
    <li>
      <Link
        href={cardHref({ boardId: entry.boardId, id: entry.taskId })}
        aria-label={`${worker.name}, lead on ${entry.title}: ${progress}`}
        title={`${entry.title} in ${entry.boardName}\n${progress}`}
        className={cn(
          "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1 rounded-[3px] p-1.5 transition-colors hover:bg-muted motion-reduce:transition-none @min-[62.5rem]:gap-x-1.5 @min-[62.5rem]:p-1",
          FOCUS_RING,
        )}
      >
        <WorkerAvatar
          hue={worker.hue}
          mood={vitals.mood}
          help={vitals.help !== null}
          className="row-span-3 size-9 shrink-0 @min-[62.5rem]:row-span-1 @min-[62.5rem]:size-7"
        />
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 self-center">
          <span className="max-w-full truncate font-mono text-[11px] leading-tight font-medium">{worker.name}</span>
          <RoleTag hue={worker.hue} className="shrink-0">
            {ROLE_INFO.lead.label}
          </RoleTag>
          {flagged && <TriangleAlertIcon className="size-3 shrink-0 text-destructive" aria-hidden />}
        </span>
        <span className="col-start-2 line-clamp-2 text-xs leading-snug font-medium break-words @min-[62.5rem]:col-span-2 @min-[62.5rem]:col-start-1">
          {entry.title}
        </span>
        {sdlc ? (
          <span className="col-start-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 @min-[62.5rem]:col-span-2 @min-[62.5rem]:col-start-1">
            <PhaseTrack sdlc={sdlc} />
            {sdlc.current === null ? (
              <CheckIcon className="size-3 text-success" aria-hidden />
            ) : (
              <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                {phase?.done ?? 0}/{phase?.total ?? 0}
              </span>
            )}
          </span>
        ) : (
          <span className="col-start-2 block truncate font-mono text-[10px] text-muted-foreground @min-[62.5rem]:col-span-2 @min-[62.5rem]:col-start-1">
            No plan yet
          </span>
        )}
      </Link>
    </li>
  );
}

/** A busy subagent at the station of its role: small robot, name and role tag; links to its lead's card. */
function CrewWorker({ worker, now }: { worker: Extract<PipelineWorker, { kind: "subagent" }>; now: number }) {
  const { entry, subagent } = worker;
  const role = roleOf(subagent.agent);
  const name = subagentName(subagent.id, subagent.agent);
  const { hue } = workerIdentity(`${entry.taskId}:${subagent.id}`);
  const label = `${name}: ${ROLE_INFO[role].label} (${subagent.agent} agent) for ${entry.title}${subagent.description ? `, ${subagent.description}` : ""}`;
  return (
    <li className="min-w-0">
      <Link
        href={cardHref({ boardId: entry.boardId, id: entry.taskId })}
        aria-label={label}
        title={label}
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-[3px] px-1 py-0.5 transition-colors hover:bg-muted motion-reduce:transition-none",
          FOCUS_RING,
        )}
      >
        <WorkerAvatar hue={hue} mood={subagentVitals(subagent, now).mood} role={role} animated={false} className="size-6 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{name}</span>
        <RoleTag hue={hue} className="ml-auto shrink-0">
          {ROLE_INFO[role].label}
        </RoleTag>
      </Link>
    </li>
  );
}

/** One SDLC phase: its step, name and job, plus every agent working in it right now. */
function Station({
  phase,
  station,
  live,
  contexts,
  now,
}: {
  phase: SdlcPhaseId;
  station: PipelineStation;
  live: Record<string, LiveAgent>;
  contexts: ReadonlyMap<string, ContextUsage | null>;
  now: number;
}) {
  const info = SDLC_PHASE_INFO[phase];
  const cards = station.workers.filter((worker) => worker.kind === "running");
  const crew = station.workers.filter((worker) => worker.kind === "subagent");
  const occupied = station.workers.length > 0;
  const hiddenCards = cards.length - MAX_CARDS;
  const hiddenCrew = crew.length - MAX_CREW;
  return (
    <section
      aria-labelledby={`sdlc-${phase}`}
      className={cn(
        "flex min-w-0 flex-col rounded-[3px] border bg-card transition-colors duration-500 motion-reduce:transition-none @min-[40rem]:w-44 @min-[40rem]:shrink-0 @min-[40rem]:snap-start @min-[62.5rem]:w-auto @min-[62.5rem]:shrink @min-[62.5rem]:grow @min-[62.5rem]:basis-0",
        occupied && "border-signal",
        station.alerts > 0 && "border-destructive/50",
      )}
    >
      <header
        className="flex items-start gap-2 px-3 pt-2.5 @min-[62.5rem]:flex-wrap @min-[62.5rem]:gap-y-1 @min-[62.5rem]:px-2 @min-[62.5rem]:pt-2"
        title={info.description}
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[3px] border font-mono text-[11px] tabular-nums transition-colors duration-500 motion-reduce:transition-none @min-[62.5rem]:mt-0 @min-[62.5rem]:size-5",
            occupied ? "border-signal bg-signal-soft text-signal-ink" : "text-muted-foreground",
          )}
        >
          {info.step}
        </span>
        <div className="min-w-0 flex-1 @min-[62.5rem]:order-last @min-[62.5rem]:basis-full">
          <h3
            id={`sdlc-${phase}`}
            className="truncate text-sm leading-tight font-semibold tracking-tight @min-[62.5rem]:text-xs"
          >
            <span className="sr-only">Phase {info.step} of 7: </span>
            {info.label}
          </h3>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {info.required ? "Always" : "When needed"}
          </p>
        </div>
        <span
          className={cn(
            "font-mono text-xs tabular-nums @min-[62.5rem]:ml-auto",
            occupied ? "text-foreground" : "text-muted-foreground/60",
          )}
        >
          {station.workers.length}
          <span className="sr-only"> {station.workers.length === 1 ? "agent" : "agents"}</span>
        </span>
      </header>
      <p
        className="line-clamp-2 px-3 pt-1 text-xs leading-snug break-words text-muted-foreground @min-[62.5rem]:px-2 @min-[62.5rem]:text-[11px]"
        title={info.description}
      >
        {info.description}
      </p>
      {station.alerts > 0 && (
        <p
          className="mx-3 mt-2 flex min-w-0 items-center gap-1 text-[11px] font-medium text-destructive @min-[62.5rem]:mx-2"
          title={`${plural(station.alerts, "card")} started ${info.label} before an earlier phase was complete`}
        >
          <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{plural(station.alerts, "card")} started early</span>
        </p>
      )}
      {occupied ? (
        <div className="flex flex-1 flex-col gap-2 p-2 @min-[62.5rem]:p-1">
          {cards.length > 0 && (
            <ul aria-label="Card agents" className="grid gap-0.5">
              {cards.slice(0, MAX_CARDS).map((worker) => (
                <CardWorker
                  key={worker.id}
                  entry={worker.entry}
                  agent={live[worker.entry.taskId]}
                  context={contexts.get(worker.entry.taskId)}
                  now={now}
                />
              ))}
              {hiddenCards > 0 && (
                <li className="px-1.5 font-mono text-xs text-muted-foreground">+{hiddenCards} more</li>
              )}
            </ul>
          )}
          {crew.length > 0 && (
            <ul aria-label="Subagents" className={cn("grid gap-0.5", cards.length > 0 && "border-t pt-2")}>
              {crew.slice(0, MAX_CREW).map((worker) => (
                <CrewWorker key={worker.id} worker={worker} now={now} />
              ))}
              {hiddenCrew > 0 && <li className="px-1 font-mono text-xs text-muted-foreground">+{hiddenCrew}</li>}
            </ul>
          )}
        </div>
      ) : (
        <p className="flex min-h-12 flex-1 items-center justify-center gap-2 p-2 font-mono text-xs text-muted-foreground/70 @min-[40rem]:min-h-24">
          <WorkerOutline className="size-6 text-muted-foreground/40" />
          Open
        </p>
      )}
    </section>
  );
}

/**
 * Quality-gate checkpoint leaving `from` for the next phase. Hover or focus it for the exit
 * criteria; it turns red while a running card crossed it before the phase it skipped was done.
 */
function Gate({ from, breaches }: { from: SdlcPhaseId; breaches: GateBreach[] }) {
  const info = SDLC_PHASE_INFO[from];
  const next = SDLC_PHASE_INFO[SDLC_PHASES[info.step]];
  const release = from === RELEASE_FROM;
  const alert = breaches.length > 0;
  const name = release ? "Release gate" : `${info.label} gate`;
  const Icon = alert ? ShieldAlertIcon : ShieldCheckIcon;
  const crossed = breaches.map((breach) => `${breach.entry.title}: ${breach.violation.message}`);
  const label = `${name}: leave ${info.label} for ${next.label} only when ${info.gate}.${alert ? ` ${plural(breaches.length, "card")} crossed it early. ${crossed.join(". ")}` : ""}`;
  return (
    <div
      className={cn(
        "relative flex items-center justify-center py-1.5 @min-[40rem]:shrink-0 @min-[40rem]:flex-col @min-[40rem]:justify-start @min-[40rem]:py-0 @min-[40rem]:pt-2",
        release ? "@min-[40rem]:w-16 @min-[62.5rem]:w-12" : "@min-[40rem]:w-10 @min-[62.5rem]:w-6",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-1/2 w-px @min-[40rem]:inset-x-0 @min-[40rem]:top-5.5 @min-[40rem]:bottom-auto @min-[40rem]:left-0 @min-[40rem]:h-px @min-[40rem]:w-auto",
          alert ? "bg-destructive/50" : release ? "bg-foreground/30" : "bg-border",
        )}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              "relative flex max-w-full items-center gap-1.5 rounded-[3px] border bg-card px-1.5 py-1 transition-colors motion-reduce:transition-none @min-[40rem]:flex-col @min-[40rem]:gap-0.5 @min-[62.5rem]:px-0.5",
              FOCUS_RING,
              alert
                ? "border-destructive/50 bg-destructive/10 text-destructive"
                : release
                  ? "border-foreground/40 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className={cn("shrink-0", release ? "size-5" : "size-4")} aria-hidden />
            {(release || alert) && (
              <span className="text-center font-mono text-[9px] leading-tight font-medium tracking-wide uppercase @min-[62.5rem]:tracking-normal">
                {[release && "Release", alert && `⚠${breaches.length}`].filter(Boolean).join(" ")}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          <div className="space-y-1 text-left">
            <p className="font-medium">
              {name}: {info.label} → {next.label}
            </p>
            <p className="opacity-80">Exit criteria: {info.gate}.</p>
            {release && <p className="opacity-80">A card ships only once Testing has passed.</p>}
            {crossed.map((line) => (
              <p key={line} className="flex gap-1">
                <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                {line}
              </p>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Plain flow arrow between an end cap and the pipeline. */
function Connector() {
  return (
    <span
      aria-hidden
      className="mx-auto h-3 w-px bg-border @min-[40rem]:mx-0 @min-[40rem]:mt-5.5 @min-[40rem]:h-px @min-[40rem]:w-3 @min-[40rem]:shrink-0 @min-[62.5rem]:w-2"
    />
  );
}

/** Backlog / Delivered: where cards wait before Planning and where they land after the run. */
function EndCap({
  icon: Icon,
  label,
  count,
  hint,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  count: number;
  hint: string;
}) {
  return (
    <div
      title={hint}
      className="flex items-center gap-3 rounded-[3px] border border-dashed bg-card px-3 py-2.5 @min-[40rem]:w-28 @min-[40rem]:shrink-0 @min-[40rem]:snap-start @min-[40rem]:flex-col @min-[40rem]:items-start @min-[40rem]:gap-1 @min-[62.5rem]:w-[4.5rem] @min-[62.5rem]:px-1.5"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-[3px] border text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase @min-[62.5rem]:tracking-normal">
          {label}
        </p>
        <p className="text-xs leading-snug break-words text-muted-foreground @min-[62.5rem]:text-[11px]">{hint}</p>
      </div>
      <p className="text-3xl leading-none font-semibold tracking-[-0.05em] tabular-nums @min-[62.5rem]:text-2xl">
        {count}
        <span className="sr-only"> {count === 1 ? "card" : "cards"}</span>
      </p>
    </div>
  );
}

/** What the dots and shields mean. */
function PipelineLegend() {
  const statuses: SdlcPhaseStatus[] = ["done", "active", "pending", "skipped"];
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
      {statuses.map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("size-1.5 rounded-full", DOT[status])} />
          {STATUS_LABEL[status]}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <ShieldCheckIcon className="size-3.5" aria-hidden />
        quality gate: hover for its exit criteria
      </li>
      <li className="flex items-center gap-1.5 text-destructive">
        <ShieldAlertIcon className="size-3.5" aria-hidden />
        crossed before the earlier phase was done
      </li>
    </ul>
  );
}

/**
 * The software lifecycle as a production line: Backlog, the seven SDLC phases with a quality gate
 * between each pair (the gate before Deployment is the release gate), then Delivered. Every running
 * card's agent stands at the phase it is executing with its progress through all phases; busy
 * subagents stand at the phase their role works in. Sized from the section (an `@container`):
 * narrow sections stack the stations; from 40rem they run left to right and scroll sideways; from
 * 62.5rem the whole line (both end caps, every station and gate) fits without scrolling.
 */
export function SdlcPipeline({
  dashboard,
  live,
  now,
}: {
  dashboard: Dashboard;
  live: Record<string, LiveAgent>;
  now: number;
}) {
  const { queue } = dashboard;
  const pipeline = useMemo(() => sdlcPipeline(queue, live), [queue, live]);
  const contexts = useMemo(
    () => new Map(dashboard.live.map((agent) => [agent.taskId, agent.context])),
    [dashboard.live],
  );
  const subagents = SDLC_PHASES.reduce(
    (sum, phase) => sum + pipeline.stations[phase].workers.filter((worker) => worker.kind === "subagent").length,
    0,
  );
  const flagged = queue.running.filter((entry) => (entry.sdlc?.violations.length ?? 0) > 0).length;

  return (
    <section aria-labelledby="viz-sdlc" className="@container min-w-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <h2 id="viz-sdlc" className="text-lg font-semibold tracking-tight">
          SDLC pipeline
        </h2>
        <p className="font-mono text-xs text-muted-foreground">
          {plural(queue.running.length, "card")} in flight · {plural(subagents, "subagent")}
          {flagged > 0 && <span className="text-destructive"> · {plural(flagged, "gate alert")}</span>}
        </p>
      </div>
      <div
        role="region"
        aria-label="SDLC stations"
        tabIndex={0}
        className={cn(
          "flex flex-col rounded-[3px] border bg-muted/50 p-2 @min-[40rem]:snap-x @min-[40rem]:snap-proximity @min-[40rem]:scroll-px-2 @min-[40rem]:flex-row @min-[40rem]:overflow-x-auto @min-[62.5rem]:snap-none",
          FOCUS_RING,
        )}
      >
        <EndCap
          icon={InboxIcon}
          label="Backlog"
          count={pipeline.backlog}
          hint="In line, before Planning"
        />
        <Connector />
        <ol
          aria-label="Phases"
          className="flex flex-col @min-[40rem]:shrink-0 @min-[40rem]:flex-row @min-[62.5rem]:min-w-0 @min-[62.5rem]:shrink @min-[62.5rem]:grow"
        >
          {SDLC_PHASES.map((phase, i) => (
            <li
              key={phase}
              className={cn(
                "flex flex-col @min-[40rem]:shrink-0 @min-[40rem]:flex-row @min-[62.5rem]:min-w-0 @min-[62.5rem]:shrink @min-[62.5rem]:grow",
                // Basis = the gate's width, so every station gets the same share of the rest.
                i === SDLC_PHASES.length - 1
                  ? "@min-[62.5rem]:basis-0"
                  : phase === RELEASE_FROM
                    ? "@min-[62.5rem]:basis-12"
                    : "@min-[62.5rem]:basis-6",
              )}
            >
              <Station phase={phase} station={pipeline.stations[phase]} live={live} contexts={contexts} now={now} />
              {i < SDLC_PHASES.length - 1 && <Gate from={phase} breaches={pipeline.stations[phase].breaches} />}
            </li>
          ))}
        </ol>
        <Connector />
        <EndCap
          icon={PackageCheckIcon}
          label="Delivered"
          count={dashboard.finished.length}
          hint="Recently done"
        />
      </div>
      <PipelineLegend />
    </section>
  );
}
