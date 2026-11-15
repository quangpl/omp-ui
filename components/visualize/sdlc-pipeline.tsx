"use client";

import { type ComponentType, useMemo } from "react";
import Link from "next/link";
import {
  CheckIcon,
  InboxIcon,
  PackageCheckIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
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
import { modelLabel, ROLE_INFO, roleOf, subagentName } from "@/components/visualize/roles";
import { CycleRing, type RingSegment, ringAngle, ringPoint } from "@/components/visualize/sdlc-cycle-ring";
import type { LiveAgent } from "@/components/visualize/use-live-agents";
import { RoleTag, WorkerAvatar, WorkerOutline } from "@/components/visualize/worker-avatar";
import { SDLC_PHASE_INFO, type SdlcPhaseId, type SdlcPhaseStatus, type SdlcProgress } from "@/lib/sdlc";
import type { ContextUsage, Dashboard, QueueEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Card agents drawn per stacked station; the rest fold into "+N more". */
const MAX_CARDS = 4;
/** Subagents drawn per stacked station; the rest fold into "+N". */
const MAX_CREW = 6;
/** Card agents drawn per node on the ring, where neighbours leave little room. */
const MAX_RING_CARDS = 2;
/** Subagent avatars drawn per node on the ring. */
const MAX_RING_CREW = 4;
/** The gate that leaves this phase is the release gate: nothing ships before Testing passes. */
const RELEASE_FROM: SdlcPhaseId = "testing";

type TooltipSide = "top" | "right" | "bottom" | "left";
type CrewMember = Extract<PipelineWorker, { kind: "subagent" }>;

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

/** Tooltip side pointing away from the ring's center at slot `index`, so tips never cover the hub. */
function outwardSide(index: number, count: number): TooltipSide {
  const radians = (ringAngle(index, count) * Math.PI) / 180;
  const x = Math.sin(radians);
  const y = -Math.cos(radians);
  if (Math.abs(y) >= Math.abs(x)) return y < 0 ? "top" : "bottom";
  return x > 0 ? "right" : "left";
}

/** One dot per phase in the card's plan (skipped phases omitted), in order: done, active (ringed while current), to do. Nothing while no phase is included. */
function PhaseTrack({ sdlc }: { sdlc: SdlcProgress }) {
  const phases = sdlc.phases.filter((phase) => phase.status !== "skipped");
  if (phases.length === 0) return null;
  const summary = phases.map((phase) => `${SDLC_PHASE_INFO[phase.id].label}: ${STATUS_LABEL[phase.status]}`);
  return (
    <span role="img" aria-label={`Phases. ${summary.join(", ")}`} title={summary.join("\n")} className="flex items-center gap-1">
      {phases.map((phase) => (
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
  if (!sdlc) return `${info.label}, no plan yet`;
  const phase = sdlc.phases.find((p) => p.id === info.id);
  const items = sdlc.current === null ? "every phase done" : `${phase?.done ?? 0} of ${phase?.total ?? 0} items done`;
  const violations = sdlc.violations.map((violation) => violation.message).join("; ");
  return `${info.label}, ${items}, ${sdlc.completed} of ${sdlc.included} phases done${violations ? `. Quality gate: ${violations}` : ""}`;
}

/**
 * A running card's agent at its station: robot, name, model, title, phase track and phase progress.
 * `compact` is the ring node variant: smaller robot, one-line title, no role tag.
 */
function CardWorker({
  entry,
  agent,
  context,
  model,
  now,
  compact = false,
}: {
  entry: QueueEntry;
  agent: LiveAgent | undefined;
  context: ContextUsage | null | undefined;
  /** Model the lead runs on, when known. */
  model: string | null | undefined;
  now: number;
  compact?: boolean;
}) {
  const worker = workerIdentity(entry.taskId);
  const vitals = agentVitals(agent, now, context);
  const { sdlc } = entry;
  const phase = sdlc?.phases.find((p) => p.id === sdlcStation(sdlc));
  const flagged = (sdlc?.violations.length ?? 0) > 0;
  const progress = progressSentence(entry);
  const modelNote = model ? `, model ${modelLabel(model)}` : "";
  return (
    <li className="min-w-0">
      <Link
        href={cardHref({ boardId: entry.boardId, id: entry.taskId })}
        aria-label={`${worker.name}, lead on ${entry.title}${modelNote}: ${progress}`}
        title={`${entry.title} in ${entry.boardName}\n${progress}${model ? `\nModel: ${model}` : ""}`}
        className={cn(
          "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start rounded-[3px] transition-colors hover:bg-muted motion-reduce:transition-none",
          compact ? "gap-x-1.5 gap-y-0.5 p-1" : "gap-x-2 gap-y-1 p-1.5",
          FOCUS_RING,
        )}
      >
        <WorkerAvatar
          hue={worker.hue}
          mood={vitals.mood}
          help={vitals.help !== null}
          className={cn("row-span-3 shrink-0", compact ? "size-7" : "size-9")}
        />
        <span
          className={cn(
            "flex min-w-0 items-center gap-x-1.5 gap-y-0.5 self-center",
            compact ? "flex-nowrap" : "flex-wrap",
          )}
        >
          <span
            className={cn(
              "max-w-full min-w-0 truncate font-mono text-[11px] leading-tight font-medium",
              compact && "shrink-0",
            )}
          >
            {worker.name}
          </span>
          {!compact && (
            <RoleTag hue={worker.hue} className="shrink-0">
              {ROLE_INFO.lead.label}
            </RoleTag>
          )}
          {model && (
            <span
              className={cn(
                "min-w-0 truncate font-mono text-[11px] leading-tight text-muted-foreground",
                !compact && "max-w-36",
              )}
              title={`Model: ${model}`}
            >
              {modelLabel(model)}
            </span>
          )}
          {flagged && <TriangleAlertIcon className="size-3 shrink-0 text-destructive" aria-hidden />}
        </span>
        <span
          className={cn(
            "col-start-2 font-medium break-words",
            compact ? "truncate text-[11px] leading-tight" : "line-clamp-2 text-xs leading-snug",
          )}
        >
          {entry.title}
        </span>
        {sdlc ? (
          <span className="col-start-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
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
          <span className="col-start-2 block truncate font-mono text-[10px] text-muted-foreground">No plan yet</span>
        )}
      </Link>
    </li>
  );
}

/** Who a busy subagent is: its robot, role and the one-line description (with its model when known) used for tooltips and screen readers. */
function crewIdentity({ entry, subagent }: CrewMember, now: number) {
  const role = roleOf(subagent.agent);
  const name = subagentName(subagent.id, subagent.agent);
  const { hue } = workerIdentity(`${entry.taskId}:${subagent.id}`);
  return {
    role,
    name,
    hue,
    mood: subagentVitals(subagent, now).mood,
    href: cardHref({ boardId: entry.boardId, id: entry.taskId }),
    label: `${name}: ${ROLE_INFO[role].label} (${subagent.agent} agent) for ${entry.title}${subagent.description ? `, ${subagent.description}` : ""}${subagent.model ? `, model ${modelLabel(subagent.model)}` : ""}`,
  };
}

/** A busy subagent at the station of its role: small robot, name, role tag and model; links to its lead's card. */
function CrewWorker({ worker, now }: { worker: CrewMember; now: number }) {
  const crew = crewIdentity(worker, now);
  const { model } = worker.subagent;
  return (
    <li className="min-w-0">
      <Link
        href={crew.href}
        aria-label={crew.label}
        title={crew.label}
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-[3px] px-1 py-0.5 transition-colors hover:bg-muted motion-reduce:transition-none",
          FOCUS_RING,
        )}
      >
        <WorkerAvatar hue={crew.hue} mood={crew.mood} role={crew.role} animated={false} className="size-6 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{crew.name}</span>
        <RoleTag hue={crew.hue} className="ml-auto shrink-0">
          {ROLE_INFO[crew.role].label}
        </RoleTag>
        {model && (
          <span className="max-w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={`Model: ${model}`}>
            {modelLabel(model)}
          </span>
        )}
      </Link>
    </li>
  );
}

/** A busy subagent folded into a ring node's avatar cluster; same link and description as CrewWorker. */
function CrewAvatar({ worker, now }: { worker: CrewMember; now: number }) {
  const crew = crewIdentity(worker, now);
  return (
    <li>
      <Link
        href={crew.href}
        aria-label={crew.label}
        title={crew.label}
        className={cn(
          "block rounded-[3px] p-0.5 transition-colors hover:bg-muted motion-reduce:transition-none",
          FOCUS_RING,
        )}
      >
        <WorkerAvatar hue={crew.hue} mood={crew.mood} role={crew.role} animated={false} className="size-6" />
      </Link>
    </li>
  );
}

/** The phase's step number, lit while someone works in it. */
function StepNumber({ step, occupied, compact = false }: { step: number; occupied: boolean; compact?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[3px] border font-mono text-[11px] tabular-nums transition-colors duration-500 motion-reduce:transition-none",
        compact ? "size-5" : "mt-0.5 size-6",
        occupied ? "border-signal bg-signal-soft text-signal-ink" : "text-muted-foreground",
      )}
    >
      {step}
    </span>
  );
}

/** How many agents stand at the station. */
function WorkerCount({ count }: { count: number }) {
  return (
    <span className={cn("shrink-0 font-mono text-xs tabular-nums", count > 0 ? "text-foreground" : "text-muted-foreground/60")}>
      {count}
      <span className="sr-only"> {count === 1 ? "agent" : "agents"}</span>
    </span>
  );
}

/** Cards that started this phase before an earlier one was complete. */
function AlertLine({ phase, alerts, className }: { phase: SdlcPhaseId; alerts: number; className?: string }) {
  return (
    <p
      className={cn("flex min-w-0 items-center gap-1 text-[11px] font-medium text-destructive", className)}
      title={`${plural(alerts, "card")} started ${SDLC_PHASE_INFO[phase].label} before an earlier phase was complete`}
    >
      <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{plural(alerts, "card")} started early</span>
    </p>
  );
}

/** Stacked layout: one SDLC phase full width, its step, name and job, plus every agent working in it right now. */
function StackStation({
  phase,
  station,
  step,
  count,
  done,
  live,
  contexts,
  models,
  now,
}: {
  phase: SdlcPhaseId;
  station: PipelineStation;
  /** 1-based position among the phases drawn. */
  step: number;
  /** How many phases are drawn. */
  count: number;
  /** Every running card that includes this phase has finished it. */
  done: boolean;
  live: Record<string, LiveAgent>;
  contexts: ReadonlyMap<string, ContextUsage | null>;
  models: ReadonlyMap<string, string | null>;
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
      aria-labelledby={`sdlc-stack-${phase}`}
      className={cn(
        "flex min-w-0 flex-col rounded-[3px] border bg-card transition-colors duration-500 motion-reduce:transition-none",
        station.alerts > 0 ? "border-destructive/50" : occupied ? "border-signal" : done && "border-success/50",
      )}
    >
      <header className="flex items-start gap-2 px-3 pt-2.5" title={info.description}>
        <StepNumber step={step} occupied={occupied} />
        <div className="min-w-0 flex-1">
          <h3 id={`sdlc-stack-${phase}`} className="truncate text-sm leading-tight font-semibold tracking-tight">
            <span className="sr-only">Phase {step} of {count}: </span>
            {info.label}
          </h3>
          <p className="truncate font-mono text-[10px] text-muted-foreground">{info.required ? "Always" : "When needed"}</p>
        </div>
        <WorkerCount count={station.workers.length} />
      </header>
      <p className="line-clamp-2 px-3 pt-1 text-xs leading-snug break-words text-muted-foreground" title={info.description}>
        {info.description}
      </p>
      {station.alerts > 0 && <AlertLine phase={phase} alerts={station.alerts} className="mx-3 mt-2" />}
      {occupied ? (
        <div className="flex flex-1 flex-col gap-2 p-2">
          {cards.length > 0 && (
            <ul aria-label="Card agents" className="grid gap-0.5">
              {cards.slice(0, MAX_CARDS).map((worker) => (
                <CardWorker
                  key={worker.id}
                  entry={worker.entry}
                  agent={live[worker.entry.taskId]}
                  context={contexts.get(worker.entry.taskId)}
                  model={models.get(worker.entry.taskId)}
                  now={now}
                />
              ))}
              {hiddenCards > 0 && <li className="px-1.5 font-mono text-xs text-muted-foreground">+{hiddenCards} more</li>}
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
      ) : done ? (
        <p className="flex min-h-12 flex-1 items-center justify-center gap-2 p-2 font-mono text-xs text-success">
          <CheckIcon className="size-4" aria-hidden />
          Done
        </p>
      ) : (
        <p className="flex min-h-12 flex-1 items-center justify-center gap-2 p-2 font-mono text-xs text-muted-foreground/70">
          <WorkerOutline className="size-6 text-muted-foreground/40" />
          Open
        </p>
      )}
    </section>
  );
}

/** Ring layout: one SDLC phase as a compact node on the cycle, its first agents and a cluster of its subagents. */
function RingStation({
  phase,
  station,
  step,
  count,
  done,
  live,
  contexts,
  models,
  now,
}: {
  phase: SdlcPhaseId;
  station: PipelineStation;
  /** 1-based position among the phases drawn. */
  step: number;
  /** How many phases are drawn. */
  count: number;
  /** Every running card that includes this phase has finished it. */
  done: boolean;
  live: Record<string, LiveAgent>;
  contexts: ReadonlyMap<string, ContextUsage | null>;
  models: ReadonlyMap<string, string | null>;
  now: number;
}) {
  const info = SDLC_PHASE_INFO[phase];
  const cards = station.workers.filter((worker) => worker.kind === "running");
  const crew = station.workers.filter((worker) => worker.kind === "subagent");
  const occupied = station.workers.length > 0;
  const hiddenCards = cards.length - MAX_RING_CARDS;
  const hiddenCrew = crew.length - MAX_RING_CREW;
  return (
    <section
      aria-labelledby={`sdlc-ring-${phase}`}
      className={cn(
        "flex w-40 min-w-0 flex-col rounded-[3px] border bg-card shadow-xs transition-colors duration-500 motion-reduce:transition-none @min-[60rem]:w-44",
        station.alerts > 0 ? "border-destructive/50" : occupied ? "border-signal" : done && "border-success/50",
      )}
    >
      <header className="flex items-center gap-1.5 px-2 pt-2" title={info.description}>
        <StepNumber step={step} occupied={occupied} compact />
        <div className="min-w-0 flex-1">
          <h3 id={`sdlc-ring-${phase}`} className="truncate text-xs leading-tight font-semibold tracking-tight">
            <span className="sr-only">Phase {step} of {count}: </span>
            {info.label}
          </h3>
          <p className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
            {info.required ? "Always" : "When needed"}
          </p>
          <span className="sr-only">{info.description}</span>
        </div>
        <WorkerCount count={station.workers.length} />
      </header>
      {station.alerts > 0 && <AlertLine phase={phase} alerts={station.alerts} className="mx-2 mt-1.5" />}
      {occupied ? (
        <div className="flex min-w-0 flex-col gap-1 p-1">
          {cards.length > 0 && (
            <ul aria-label="Card agents" className="grid min-w-0 gap-0.5">
              {cards.slice(0, MAX_RING_CARDS).map((worker) => (
                <CardWorker
                  key={worker.id}
                  entry={worker.entry}
                  agent={live[worker.entry.taskId]}
                  context={contexts.get(worker.entry.taskId)}
                  model={models.get(worker.entry.taskId)}
                  now={now}
                  compact
                />
              ))}
              {hiddenCards > 0 && (
                <li className="px-1 font-mono text-[10px] text-muted-foreground tabular-nums">+{hiddenCards} more</li>
              )}
            </ul>
          )}
          {crew.length > 0 && (
            <ul
              aria-label="Subagents"
              className={cn("flex min-w-0 flex-wrap items-center gap-0.5 px-0.5", cards.length > 0 && "border-t pt-1")}
            >
              {crew.slice(0, MAX_RING_CREW).map((worker) => (
                <CrewAvatar key={worker.id} worker={worker} now={now} />
              ))}
              {hiddenCrew > 0 && (
                <li className="pl-0.5 font-mono text-[10px] text-muted-foreground tabular-nums">+{hiddenCrew}</li>
              )}
            </ul>
          )}
        </div>
      ) : done ? (
        <p className="flex items-center gap-1.5 px-2 pt-1 pb-2 font-mono text-[11px] text-success">
          <CheckIcon className="size-3.5" aria-hidden />
          Done
        </p>
      ) : (
        <p className="flex items-center gap-1.5 px-2 pt-1 pb-2 font-mono text-[11px] text-muted-foreground/70">
          <WorkerOutline className="size-5 text-muted-foreground/40" />
          Open
        </p>
      )}
    </section>
  );
}

/**
 * Quality-gate checkpoint leaving `from` for the next visible phase `to` (null closes the cycle:
 * what passes the last gate ships to Delivered). Hover or focus it for the exit
 * criteria; it turns red while a running card crossed it before the phase it skipped was done.
 */
function GateShield({ from, to, breaches, side }: { from: SdlcPhaseId; to: SdlcPhaseId | null; breaches: GateBreach[]; side: TooltipSide }) {
  const info = SDLC_PHASE_INFO[from];
  const next = to ? SDLC_PHASE_INFO[to].label : "Delivered";
  const release = from === RELEASE_FROM;
  const alert = breaches.length > 0;
  const name = release ? "Release gate" : `${info.label} gate`;
  const Icon = alert ? ShieldAlertIcon : ShieldCheckIcon;
  const crossed = breaches.map((breach) => `${breach.entry.title}: ${breach.violation.message}`);
  const label = `${name}: leave ${info.label} for ${next} only when ${info.gate}.${alert ? ` ${plural(breaches.length, "card")} crossed it early. ${crossed.join(". ")}` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "relative flex items-center gap-1 rounded-[3px] border bg-card px-1 py-1 transition-colors motion-reduce:transition-none",
            FOCUS_RING,
            alert
              ? "border-destructive/50 bg-destructive/10 text-destructive"
              : release
                ? "border-foreground/40 text-foreground"
                : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className={cn("shrink-0", release ? "size-4.5" : "size-3.5")} aria-hidden />
          {release && (
            <span className="font-mono text-[9px] leading-none font-medium tracking-wide uppercase">Release</span>
          )}
          {alert && (
            <span className="flex items-center gap-0.5 font-mono text-[10px] leading-none font-medium tabular-nums">
              <TriangleAlertIcon className="size-2.5" aria-hidden />
              {breaches.length}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-72">
        <div className="space-y-1 text-left">
          <p className="font-medium">
            {name}: {info.label} → {next}
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
  );
}

/** Shared by the marker's tooltip and its screen-reader text. */
const FEEDBACK_NOTE = "Maintenance feeds the next Planning round: the cycle never ends";

/** The feedback edge closing the cycle, Maintenance back to Planning. Not a quality gate, so no exit criteria. */
function FeedbackMarker() {
  return (
    <span
      title={FEEDBACK_NOTE}
      className="flex items-center gap-1 rounded-full border border-dashed border-muted-foreground/50 bg-card px-2 py-1 font-mono text-[9px] leading-none font-medium tracking-wide text-muted-foreground uppercase"
    >
      <RotateCcwIcon className="size-3 shrink-0" aria-hidden />
      Feedback
      <span className="sr-only">: {FEEDBACK_NOTE}</span>
    </span>
  );
}

/** Stacked layout: the gate between two stations on a vertical flow line. */
function StackGate({ from, to, breaches }: { from: SdlcPhaseId; to: SdlcPhaseId | null; breaches: GateBreach[] }) {
  const alert = breaches.length > 0;
  return (
    <div className="relative flex items-center justify-center py-1.5">
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-1/2 w-px",
          alert ? "bg-destructive/50" : from === RELEASE_FROM ? "bg-foreground/30" : "bg-border",
        )}
      />
      <GateShield from={from} to={to} breaches={breaches} side="bottom" />
    </div>
  );
}

/** Stacked layout: after Maintenance, the flow line turns back to Planning. */
function StackLoopBack() {
  return (
    <div className="flex flex-col items-center">
      <Connector />
      <p className="flex items-center gap-2">
        <FeedbackMarker />
        <span className="font-mono text-xs text-muted-foreground">back to Planning</span>
      </p>
    </div>
  );
}

/** Plain flow line between an end cap and the stacked stations. */
function Connector() {
  return <span aria-hidden className="mx-auto h-3 w-px bg-border" />;
}

/** Stacked layout: Backlog / Delivered, where cards wait before Planning and where they land after the run. */
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
    <div title={hint} className="flex items-center gap-3 rounded-[3px] border border-dashed bg-card px-3 py-2.5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-[3px] border text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className="text-xs leading-snug break-words text-muted-foreground">{hint}</p>
      </div>
      <p className="text-3xl leading-none font-semibold tracking-[-0.05em] tabular-nums">
        {count}
        <span className="sr-only"> {count === 1 ? "card" : "cards"}</span>
      </p>
    </div>
  );
}

/** One Backlog / Delivered tally inside the ring's hub. */
function HubTally({
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
    <div title={hint} className="flex min-w-0 flex-col items-center gap-1">
      <p className="flex items-center gap-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3 shrink-0" aria-hidden />
        {label}
      </p>
      <p className="text-4xl leading-none font-semibold tracking-[-0.05em] tabular-nums">
        {count}
        <span className="sr-only"> {count === 1 ? "card" : "cards"}</span>
      </p>
      <p className="max-w-full truncate font-mono text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Center of the ring: what waits before the cycle, what left it, and what is moving through it. */
function CycleHub({
  backlog,
  delivered,
  running,
  subagents,
  flagged,
}: {
  backlog: number;
  delivered: number;
  running: number;
  subagents: number;
  flagged: number;
}) {
  return (
    <div className="absolute top-1/2 left-1/2 flex w-[44%] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 text-center">
      <div className="grid w-full grid-cols-2 gap-4">
        <HubTally icon={InboxIcon} label="Backlog" count={backlog} hint="In line, before Planning" />
        <HubTally icon={PackageCheckIcon} label="Delivered" count={delivered} hint="Recently done" />
      </div>
      <span aria-hidden className="w-3/4 border-t border-dashed" />
      <p aria-hidden className="font-mono text-[11px] leading-relaxed text-muted-foreground">
        <span className="text-foreground tabular-nums">{running}</span> {running === 1 ? "card" : "cards"} in flight
        {" · "}
        <span className="text-foreground tabular-nums">{subagents}</span> {subagents === 1 ? "subagent" : "subagents"}
        {flagged > 0 && <span className="text-destructive"> · {plural(flagged, "gate alert")}</span>}
      </p>
    </div>
  );
}

/** What the dots and shields mean; the feedback row only while Maintenance is on the board. */
function PipelineLegend({ feedback }: { feedback: boolean }) {
  const statuses: SdlcPhaseStatus[] = ["done", "active", "pending"];
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
      {feedback && (
        <li className="flex items-center gap-1.5">
          <RotateCcwIcon className="size-3.5" aria-hidden />
          feedback: Maintenance feeds the next Planning round
        </li>
      )}
    </ul>
  );
}

/**
 * The software lifecycle as a continuous cycle: the visible SDLC phases — the required ones plus
 * when-needed phases some running card includes or executes (`sdlcPipeline().visible`) — with a
 * quality gate between each consecutive pair (the gate leaving Testing is the release gate) and a
 * Feedback marker on the Maintenance → Planning edge while Maintenance is drawn. Every running
 * card's agent stands at the phase it is executing with its progress through its included phases;
 * busy subagents stand at the phase their role works in. Phases every card finished are
 * highlighted as done. Sized from the section (an `@container`):
 * - from 56rem, the phases sit clockwise from 12 o'clock on a ring (CycleRing), gates on the arcs
 *   between them, and a hub in the middle tallies Backlog, Delivered and what is in flight;
 * - below, the visible phases stack top to bottom between the Backlog and Delivered end caps, gates
 *   on the flow line between them; while Maintenance is drawn, a loop-back row turns it back to Planning.
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
  const models = useMemo(
    () => new Map(dashboard.live.map((agent) => [agent.taskId, agent.model])),
    [dashboard.live],
  );
  const phases = pipeline.visible;
  const count = phases.length;
  /** Visible phases nobody works in that every running card including them has finished: highlighted as done. */
  const donePhases = useMemo(() => {
    return new Set(
      pipeline.visible.filter((phase) => {
        if (pipeline.stations[phase].workers.length > 0) return false;
        const statuses = queue.running
          .map((entry) => entry.sdlc?.phases.find((p) => p.id === phase)?.status ?? "skipped")
          .filter((status) => status !== "skipped");
        return statuses.length > 0 && statuses.every((status) => status === "done");
      }),
    );
  }, [pipeline, queue.running]);
  const segments = useMemo<RingSegment[]>(
    () =>
      pipeline.visible.map((phase) => ({
        id: phase,
        occupied: pipeline.stations[phase].workers.length > 0,
        alert: pipeline.stations[phase].breaches.length > 0,
        done: donePhases.has(phase),
      })),
    [pipeline, donePhases],
  );
  const subagents = phases.reduce(
    (sum, phase) => sum + pipeline.stations[phase].workers.filter((worker) => worker.kind === "subagent").length,
    0,
  );
  const flagged = queue.running.filter((entry) => (entry.sdlc?.violations.length ?? 0) > 0).length;
  const delivered = dashboard.finished.length;

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
        aria-label="SDLC cycle"
        className="rounded-[3px] border bg-muted/50 p-2 @min-[56rem]:px-4 @min-[56rem]:py-14"
      >
        {/* Wide: the cycle as a ring. */}
        <div className="relative mx-auto hidden aspect-square w-full max-w-[46rem] @min-[56rem]:block">
          <CycleRing segments={segments} />
          <CycleHub
            backlog={pipeline.backlog}
            delivered={delivered}
            running={queue.running.length}
            subagents={subagents}
            flagged={flagged}
          />
          <ol aria-label="Phases" className="pointer-events-none absolute inset-0">
            {phases.map((phase, i) => (
              <li key={phase}>
                <div
                  className="pointer-events-auto absolute z-10 -translate-x-1/2 -translate-y-1/2 focus-within:z-20 hover:z-20"
                  style={ringPoint(i, count)}
                >
                  <RingStation
                    phase={phase}
                    station={pipeline.stations[phase]}
                    step={i + 1}
                    count={count}
                    done={donePhases.has(phase)}
                    live={live}
                    contexts={contexts}
                    models={models}
                    now={now}
                  />
                </div>
                <div
                  className="pointer-events-auto absolute z-10 -translate-x-1/2 -translate-y-1/2"
                  // Gates sit slightly outside the track so tall occupied stations never cover them.
                  style={ringPoint(i + 0.5, count, 47)}
                >
                  {phase === "maintenance" ? (
                    <FeedbackMarker />
                  ) : (
                    <GateShield
                      from={phase}
                      to={i + 1 < count ? phases[i + 1] : null}
                      breaches={pipeline.stations[phase].breaches}
                      side={outwardSide(i + 0.5, count)}
                    />
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* Narrow: the cycle stacked; while Maintenance is drawn, a dashed rail loops it back to Planning. */}
        <div className="flex flex-col @min-[56rem]:hidden">
          <EndCap icon={InboxIcon} label="Backlog" count={pipeline.backlog} hint="In line, before Planning" />
          <Connector />
          <ol aria-label="Phases" className="relative flex flex-col pl-5">
            {phases.includes("maintenance") && (
              <span
                aria-hidden
                className="absolute top-4 bottom-4 left-1.5 w-3.5 rounded-l-[3px] border-y border-l border-dashed border-muted-foreground/40"
              />
            )}
            {phases.map((phase, i) => (
              <li key={phase} className="flex flex-col">
                <StackStation
                  phase={phase}
                  station={pipeline.stations[phase]}
                  step={i + 1}
                  count={count}
                  done={donePhases.has(phase)}
                  live={live}
                  contexts={contexts}
                  models={models}
                  now={now}
                />
                {phase === "maintenance" ? (
                  <StackLoopBack />
                ) : (
                  <StackGate from={phase} to={i + 1 < count ? phases[i + 1] : null} breaches={pipeline.stations[phase].breaches} />
                )}
              </li>
            ))}
          </ol>
          <Connector />
          <EndCap icon={PackageCheckIcon} label="Delivered" count={delivered} hint="Recently done" />
        </div>
      </div>
      <PipelineLegend feedback={phases.includes("maintenance")} />
    </section>
  );
}
