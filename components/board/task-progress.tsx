"use client";

import { Fragment, type ReactNode, useMemo } from "react";
import {
  Circle,
  CircleCheck,
  CircleDot,
  CircleSlash,
  ListChecks,
  LoaderCircle,
  Shield,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { DetailSection } from "@/components/board/detail-section";
import { formatEta, useNow } from "@/components/board/format";
import { type Task, type TaskStatus, type TodoItemStatus, type TodoPhase } from "@/lib/types";
import {
  classifySdlcPhase,
  releaseGate,
  SDLC_PHASE_INFO,
  SDLC_PHASES,
  sdlcPhaseMap,
  sdlcProgress,
  type SdlcPhaseId,
  type SdlcPhaseProgress,
  type SdlcProgress,
} from "@/lib/sdlc";
import { progressFraction, todoEta, todoProgress, type TodoProgress } from "@/lib/todos";
import { cn } from "@/lib/utils";

/**
 * "~12m": estimated time until a running agent finishes its todo list, at the pace of the items
 * it completed. Nothing while the agent isn't running or before its first completed item.
 * `verbose` also shows "left".
 */
export function TodoEta({
  task,
  verbose = false,
  className,
}: {
  task: Pick<Task, "agentState" | "todos">;
  verbose?: boolean;
  className?: string;
}) {
  // Only running cards start a clock.
  if (task.agentState !== "running") return null;
  return <RunningTodoEta todos={task.todos} verbose={verbose} className={className} />;
}

function RunningTodoEta({ todos, verbose, className }: { todos: TodoPhase[]; verbose: boolean; className?: string }) {
  const now = useNow(30_000);
  const eta = todoEta(todos, now);
  if (eta === null) return null;
  const label = formatEta(eta);
  return (
    <span
      className={cn("tabular-nums", className)}
      title={`About ${label} left, at the pace of the completed todo items`}
    >
      ~{label}
      <span className={verbose ? undefined : "sr-only"}> left</span>
    </span>
  );
}

const RADIUS = 6.25;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Arc length bounds (fraction of the ring) while the ring spins for a running agent. */
const SPIN_ARC_MIN = 0.25;
const SPIN_ARC_MAX = 0.8;

const RING_TONE: Record<TaskStatus, string> = {
  todo: "text-muted-foreground",
  in_progress: "text-primary",
  done: "text-success",
};

/**
 * "3 of 7 todo items done · Now: Add tests", or the card's column when there is no todo list.
 * Open feedback counted as pending items reads "7 of 7 todo items done · 1 open feedback".
 * With the card's SDLC progress, the current phase leads: "Testing phase · 3 of 7 todo items done · …".
 */
export function progressLabel(status: TaskStatus, progress: TodoProgress | null, sdlc?: SdlcProgress | null): string {
  if (status === "done") {
    return progress ? `Done · ${progress.done} of ${progress.total - progress.feedback} todo items done` : "Done";
  }
  if (!progress) return status === "todo" ? "To do · not started" : "In progress";
  let label = `${progress.done} of ${progress.total - progress.feedback} todo items done`;
  if (sdlc?.current) label = `${SDLC_PHASE_INFO[sdlc.current].label} phase · ${label}`;
  if (progress.feedback > 0) label += ` · ${progress.feedback} open feedback`;
  return progress.current ? `${label} · Now: ${progress.current}` : label;
}

/**
 * "SDLC: Testing (phase 3 of 3) · 3 of 3 phases done", plus the process violations: the
 * tooltip and accessible name of the card's SDLC track.
 */
function sdlcSummary(sdlc: SdlcProgress): string {
  const phases = `${sdlc.completed} of ${sdlc.included} phases done`;
  let label = sdlc.current
    ? `SDLC: ${SDLC_PHASE_INFO[sdlc.current].label} (phase ${SDLC_PHASE_INFO[sdlc.current].step} of ${SDLC_PHASES.length}) · ${phases}`
    : `SDLC: ${phases}`;
  for (const violation of sdlc.violations) label += ` · ⚠ ${violation.message}`;
  return label;
}

const TRACK_SEGMENT: Record<SdlcPhaseProgress["status"], string> = {
  done: "h-1.5 w-2.5 bg-success",
  active: "h-1.5 w-2.5 bg-primary",
  pending: "h-1.5 w-2.5 border border-muted-foreground/45",
  skipped: "size-1 bg-muted-foreground/25",
};

/**
 * A card's compact SDLC track: one segment per phase (done, current, pending, skipped) with a
 * release-gate tick after Testing that turns amber when the process was breached. Renders nothing
 * when the todo list maps to no SDLC phase.
 */
export function SdlcTrack({
  task,
  className,
}: {
  task: Pick<Task, "todos" | "agentState" | "status">;
  className?: string;
}) {
  const sdlc = useMemo(() => sdlcProgress(task.todos), [task.todos]);
  if (!sdlc) return null;
  const label = sdlcSummary(sdlc);
  const running = task.agentState === "running" && task.status !== "done";
  const testing = sdlc.phases[SDLC_PHASE_INFO.testing.step - 1];
  const releaseBreached = releaseGate(sdlc) !== null && task.status === "done";
  const gateTone =
    sdlc.violations.length > 0 || releaseBreached
      ? "bg-amber-500"
      : testing.status === "done"
        ? "bg-success"
        : "bg-muted-foreground/40";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-flex h-5 shrink-0 items-center gap-0.5", className)}
      data-sdlc-phase={sdlc.current ?? undefined}
    >
      {sdlc.phases.map((phase) => {
        const current = phase.id === sdlc.current;
        // The current phase reads as active even before its first item starts.
        const look = current && phase.status === "pending" ? "active" : phase.status;
        return (
          <Fragment key={phase.id}>
            <span
              aria-hidden
              className={cn(
                "shrink-0 rounded-full",
                TRACK_SEGMENT[look],
                current && running && "motion-safe:animate-pulse",
              )}
            />
            {phase.id === "testing" && phase.status !== "skipped" && (
              <span aria-hidden className={cn("mx-px h-2.5 w-px shrink-0 rounded-full", gateTone)} />
            )}
          </Fragment>
        );
      })}
    </span>
  );
}

/**
 * A card's progress ring: filled by the agent's todo list when it kept one, else by the card's
 * column (To do: empty dashed ring, In progress: half, Done: full with a check). While the agent
 * runs, the arc spins like a loading indicator; its length stays clamped so it never vanishes
 * (0 %) or closes into a full ring (100 %), where the rotation would be invisible.
 */
export function TaskProgressIcon({
  task,
  className,
}: {
  task: Pick<Task, "status" | "agentState" | "todos" | "openCommentCount">;
  className?: string;
}) {
  const progress = todoProgress(task.todos, task.openCommentCount);
  const fraction = progressFraction(task.status, progress);
  const sdlc = useMemo(() => sdlcProgress(task.todos), [task.todos]);
  const label = progressLabel(task.status, progress, sdlc);
  const spinning = task.agentState === "running" && task.status !== "done";
  const arc = spinning ? Math.min(Math.max(fraction, SPIN_ARC_MIN), SPIN_ARC_MAX) : fraction;
  const notStarted = !spinning && task.status === "todo" && fraction === 0;
  return (
    <svg
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
      className={cn("size-4 shrink-0", RING_TONE[task.status], spinning && "text-primary", className)}
      data-progress={Math.round(fraction * 100)}
    >
      <title>{label}</title>
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeDasharray={notStarted ? "2.2 2.2" : undefined}
        className={notStarted ? "opacity-70" : "opacity-20"}
      />
      {arc > 0 && (
        // The spin lives on the group: CSS `transform` on the circle would replace its rotate(-90) attribute.
        <g className={cn(spinning && "origin-center animate-spin motion-reduce:animate-none")}>
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeDasharray={`${arc * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            transform="rotate(-90 8 8)"
            className="transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none"
          />
        </g>
      )}
      {task.status === "done" && (
        <path
          d="M5.4 8.2 7.2 10l3.4-3.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

const ITEM_ICON: Record<TodoItemStatus, { icon: typeof Circle; className: string; label: string }> = {
  completed: { icon: CircleCheck, className: "text-success", label: "Done" },
  in_progress: { icon: CircleDot, className: "text-primary", label: "In progress" },
  pending: { icon: Circle, className: "text-muted-foreground/70", label: "Pending" },
  abandoned: { icon: CircleSlash, className: "text-muted-foreground/70", label: "Dropped" },
};

const STEP_ICON: Record<SdlcPhaseProgress["status"], { icon: typeof Circle; className: string; label: string }> = {
  done: { icon: CircleCheck, className: "text-success", label: "Done" },
  active: { icon: CircleDot, className: "text-primary", label: "In progress" },
  pending: { icon: Circle, className: "text-muted-foreground/60", label: "Pending" },
  skipped: { icon: CircleSlash, className: "text-muted-foreground/50", label: "Skipped" },
};

/**
 * The three SDLC phases in order, the current one highlighted, with a quality-gate checkpoint
 * between consecutive included phases: passed once the earlier phase is done, amber when the
 * later phase started through an open gate.
 */
function SdlcStepper({ sdlc, running }: { sdlc: SdlcProgress; running: boolean }) {
  let previous: SdlcPhaseProgress | null = null;
  return (
    <ol aria-label="SDLC phases" className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
      {sdlc.phases.map((phase) => {
        const info = SDLC_PHASE_INFO[phase.id];
        const current = phase.id === sdlc.current;
        // The current phase reads as active even before its first item starts.
        const look = current && phase.status === "pending" ? "active" : phase.status;
        const { icon: Icon, className: iconClass, label: statusLabel } = STEP_ICON[look];
        const from = phase.status === "skipped" ? null : previous;
        if (phase.status !== "skipped") previous = phase;
        return (
          <li key={phase.id} className="flex items-center gap-1">
            {from && <QualityGate from={from} to={phase} />}
            <span
              title={`${info.step}. ${info.label}: ${info.description}`}
              aria-current={current ? "step" : undefined}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-xs",
                current ? "bg-primary/10 font-medium text-primary ring-1 ring-primary/25" : "text-muted-foreground",
                !current && look === "done" && "text-foreground",
                look === "skipped" && "text-muted-foreground/60 line-through decoration-muted-foreground/40",
              )}
            >
              {look === "active" && running ? (
                <LoaderCircle
                  aria-hidden
                  className={cn("size-3.5 shrink-0 animate-spin motion-reduce:animate-none", iconClass)}
                />
              ) : (
                <Icon aria-hidden className={cn("size-3.5 shrink-0", iconClass)} />
              )}
              <span className="text-[10px] tabular-nums opacity-70">{info.step}</span>
              {/* Phones keep only the current phase's name; the rest read from icon and number. */}
              <span className={cn(!current && "max-sm:sr-only")}>{info.label}</span>
              <span className="sr-only">
                {" "}
                ({statusLabel}
                {current ? ", current phase" : ""})
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The checkpoint between two consecutive included SDLC phases. */
function QualityGate({ from, to }: { from: SdlcPhaseProgress; to: SdlcPhaseProgress }) {
  const passed = from.status === "done";
  const breached = !passed && (to.status === "active" || to.status === "done");
  const state = breached ? "breached" : passed ? "passed" : "open";
  const Icon = breached ? ShieldAlert : passed ? ShieldCheck : Shield;
  const title = `Quality gate ${state}: ${SDLC_PHASE_INFO[from.id].label} → ${SDLC_PHASE_INFO[to.id].label}. Exit criteria: ${SDLC_PHASE_INFO[from.id].gate}`;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-0.5 text-[10px] font-medium",
        breached ? "text-amber-700 dark:text-amber-300" : passed ? "text-success" : "text-muted-foreground/50",
      )}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">{title}</span>
    </span>
  );
}

/** An amber note about the SDLC process under the stepper. */
function SdlcCallout({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200"
    >
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 break-words">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

/** The SDLC phase a legacy-named todo phase counts toward, next to its heading ("BUILD · Implement"). */
function SdlcPhaseBadge({ phase }: { phase: SdlcPhaseId | null | undefined }) {
  if (!phase) return null;
  return (
    <span
      className="rounded-full bg-muted px-1.5 text-[10px] leading-4 font-medium tracking-normal normal-case"
      title="The SDLC phase this step counts toward"
    >
      <span className="sr-only">SDLC phase: </span>
      {SDLC_PHASE_INFO[phase].label}
    </span>
  );
}

/**
 * Card detail: the agent's todo list, by phase, under its SDLC stepper (when the list maps to SDLC
 * phases). Renders nothing when the agent never kept one.
 */
export function TodoListSection({
  task,
}: {
  task: Pick<Task, "status" | "agentState" | "todos" | "openCommentCount">;
}) {
  const progress = todoProgress(task.todos, task.openCommentCount);
  const sdlc = useMemo(() => sdlcProgress(task.todos), [task.todos]);
  // Legacy-named phases get a badge with the SDLC phase they count toward; canonical names need none.
  const mapped = useMemo(
    () =>
      sdlc && !sdlc.canonical
        ? (sdlcPhaseMap(task.todos)?.map((id, index) => (classifySdlcPhase(task.todos[index].name) ? null : id)) ?? null)
        : null,
    [sdlc, task.todos],
  );
  const running = task.agentState === "running";
  if (!progress) return null;
  const shippedPastGate = sdlc && task.status === "done" ? releaseGate(sdlc) : null;
  return (
    <DetailSection
      icon={ListChecks}
      title="Progress"
      action={
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground tabular-nums">
          <TaskProgressIcon task={task} className="size-3.5" />
          {progress.done} of {progress.total - progress.feedback} done
          {progress.feedback > 0 && (
            <span className="before:mr-1.5 before:content-['·']">{progress.feedback} open feedback</span>
          )}
          <TodoEta task={task} verbose className="before:mr-1.5 before:content-['·']" />
        </span>
      }
    >
      <div className="flex flex-col gap-3 rounded-xl border px-3.5 py-3">
        {sdlc && (
          <div className="flex min-w-0 flex-col gap-2 border-b pb-3">
            <SdlcStepper sdlc={sdlc} running={running && task.status !== "done"} />
            {sdlc.violations.length > 0 && (
              <SdlcCallout title="SDLC process not followed">
                <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4">
                  {sdlc.violations.map((violation) => (
                    <li key={`${violation.phase}:${violation.requires}`}>{violation.message}</li>
                  ))}
                </ul>
              </SdlcCallout>
            )}
            {shippedPastGate && <SdlcCallout title={`Shipped without passing the release gate: ${shippedPastGate}`} />}
          </div>
        )}
        {task.todos.map((phase, index) => (
          <div key={`${index}:${phase.name}`} className="flex min-w-0 flex-col gap-1.5">
            {phase.name && (
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {phase.name}
                <SdlcPhaseBadge phase={mapped?.[index]} />
              </p>
            )}
            <ul className="flex flex-col gap-1">
              {phase.tasks.map((item, itemIndex) => {
                const { icon: Icon, className, label } = ITEM_ICON[item.status];
                const active = running && item.status === "in_progress";
                return (
                  <li key={`${itemIndex}:${item.content}`} className="flex min-w-0 items-start gap-2 text-sm">
                    {active ? (
                      <LoaderCircle
                        aria-hidden
                        className={cn("mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
                      />
                    ) : (
                      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", className)} />
                    )}
                    <span
                      className={cn(
                        "min-w-0 break-words",
                        item.status === "in_progress" && "font-medium",
                        (item.status === "completed" || item.status === "abandoned") &&
                          "text-muted-foreground line-through decoration-muted-foreground/50",
                      )}
                    >
                      {item.content}
                      <span className="sr-only"> ({label})</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </DetailSection>
  );
}
