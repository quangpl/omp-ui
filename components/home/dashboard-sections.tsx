"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  ChartColumnIcon,
  CheckIcon,
  ChevronDownIcon,
  CommandIcon,
  ContainerIcon,
  FolderPlusIcon,
  KeyboardIcon,
  PackageCheckIcon,
  PlusIcon,
  RadarIcon,
  RefreshCwIcon,
  SettingsIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { openCommandPalette } from "@/components/command-palette";
import { openKeyboardHelp } from "@/components/keyboard-help";
import { useNewCard } from "@/components/new-card";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { isMenuHrefVisible, useVisibleDashboardMenus } from "@/lib/dashboard-menus";
import { modKeyLabel } from "@/lib/hotkeys";
import type { Dashboard } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, Panel, boardHref, cardHref, plural, useEntrance } from "./shared";

// ---------------------------------------------------------------------------------------------
// Overview: the pulse header. Greeting, date and status line, then one chip per live figure.

function greeting(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Section headings the pulse chips jump to (set via SectionTitle in needs-you.tsx and live-agents.tsx). */
const NEEDS_YOU_HEADING = "home-needs-you";
const AGENTS_HEADING = "home-agents";

/** Smooth-scrolls to an in-page heading; modified clicks keep the plain anchor behavior. */
function jumpTo(event: MouseEvent<HTMLAnchorElement>, id: string) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
}

type PulseTone = "attention" | "live" | "success";

/** Chip surfaces: neutral at zero, a semantic tint only once the figure is non-zero. */
const PULSE_STYLE: Record<PulseTone | "neutral", { chip: string; hover: string; value: string; label: string }> = {
  neutral: {
    chip: "border-transparent bg-muted/50",
    hover: "hover:bg-muted active:bg-muted",
    value: "text-foreground",
    label: "text-muted-foreground",
  },
  attention: {
    chip: "border-amber-500/30 bg-amber-500/10",
    hover: "hover:bg-amber-500/15 active:bg-amber-500/15",
    value: "text-amber-800 dark:text-amber-300",
    label: "text-amber-800/90 dark:text-amber-300/80",
  },
  live: {
    chip: "border-primary/25 bg-primary/5",
    hover: "hover:bg-primary/10 active:bg-primary/10",
    value: "text-primary",
    label: "text-muted-foreground",
  },
  success: {
    chip: "border-transparent bg-muted/50",
    hover: "hover:bg-muted active:bg-muted",
    value: "text-success",
    label: "text-muted-foreground",
  },
};

interface Pulse {
  key: string;
  value: number;
  label: string;
  /** Unset at zero so the chip stays neutral. */
  tone?: PulseTone;
  /** Leading status dot; "live" breathes while the figure is non-zero. */
  dot?: "attention" | "live";
  /** Heading id the chip jumps to. */
  target?: { id: string; name: string };
  /** Queued agents, shown as a quiet tail on the running chip. */
  queued?: number;
}

function PulseChip({ pulse }: { pulse: Pulse }) {
  const style = PULSE_STYLE[pulse.tone ?? "neutral"];
  const active = pulse.tone !== undefined;
  const body = (
    <>
      {pulse.dot && (
        <span aria-hidden="true" className="relative flex size-1.5 shrink-0">
          {pulse.dot === "live" && active && (
            <span className="absolute inset-0 animate-breathe rounded-full bg-primary" />
          )}
          <span
            className={cn(
              "relative size-1.5 rounded-full",
              !active ? "bg-muted-foreground/40" : pulse.dot === "live" ? "bg-primary" : "bg-amber-500",
            )}
          />
        </span>
      )}
      <span className={cn("font-mono text-base leading-none font-semibold tracking-tight tabular-nums", style.value)}>
        {pulse.value}
      </span>
      <span className={cn("text-[11px] leading-none whitespace-nowrap", style.label)}>{pulse.label}</span>
      {pulse.queued !== undefined && pulse.queued > 0 && (
        <span className="text-[11px] leading-none whitespace-nowrap text-muted-foreground">
          <span aria-hidden="true">· </span>
          <span className="font-mono tabular-nums">{pulse.queued}</span> queued
        </span>
      )}
    </>
  );
  const base = cn(
    "inline-flex h-11 shrink-0 snap-start items-center gap-2 rounded-lg border px-3 md:h-9",
    style.chip,
  );
  if (!pulse.target) return <li className={base}>{body}</li>;
  const { id, name } = pulse.target;
  return (
    <li className="shrink-0 snap-start">
      <a
        href={`#${id}`}
        onClick={(event) => jumpTo(event, id)}
        title={`Jump to ${name}`}
        className={cn(base, style.hover, "pressable transition-colors", FOCUS_RING)}
      >
        {body}
      </a>
    </li>
  );
}

export function Overview({ dashboard, now }: { dashboard: Dashboard; now: number }) {
  const { totals, queue, needsYouTotal, stats } = dashboard;
  const running = queue.running.length;
  const queued = queue.queued.length;
  const shipped = stats.week.shipped;

  const status: string[] = [];
  if (needsYouTotal > 0) status.push(`${plural(needsYouTotal, "card")} need${needsYouTotal === 1 ? "s" : ""} you`);
  if (running > 0) status.push(`${plural(running, "agent")} working`);
  if (queued > 0) status.push(`${queued} queued`);
  if (status.length === 0) {
    status.push(totals.todo > 0 ? `${plural(totals.todo, "card")} ready to start` : "All quiet, nothing waiting on you");
  }

  const pulses: Pulse[] = [
    {
      key: "needs-you",
      value: needsYouTotal,
      label: needsYouTotal === 1 ? "needs you" : "need you",
      tone: needsYouTotal > 0 ? "attention" : undefined,
      dot: "attention",
      target: { id: NEEDS_YOU_HEADING, name: "Needs you" },
    },
    {
      key: "running",
      value: running,
      label: "running",
      tone: running > 0 ? "live" : undefined,
      dot: "live",
      target: { id: AGENTS_HEADING, name: "Live agents" },
      queued,
    },
    { key: "in-progress", value: totals.in_progress, label: "in progress" },
    { key: "todo", value: totals.todo, label: "to do" },
    { key: "shipped", value: shipped, label: "shipped in 7 days", tone: shipped > 0 ? "success" : undefined },
  ];
  const date = new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <section
      aria-labelledby="home-overview"
      className="animate-fade-in-soft flex flex-col gap-4 @5xl/home:flex-row @5xl/home:items-end @5xl/home:justify-between @5xl/home:gap-10"
    >
      <div className="min-w-0">
        <h2 id="home-overview" className="text-2xl font-semibold tracking-tight text-balance @2xl/home:text-3xl">
          {greeting(new Date(now).getHours())}
        </h2>
        <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
          <span className="whitespace-nowrap">{date}</span>
          <span aria-hidden="true" className="mx-1.5 text-muted-foreground/50">
            ·
          </span>
          {status.join(", ")}
        </p>
      </div>
      {/*
        Narrow: a swipeable strip bleeding to the page edge. Medium: the chips wrap in place.
        Wide: they sit right-aligned beside the greeting, baseline with the status line.
      */}
      <ul
        aria-label="At a glance"
        className="scroll-row -mx-4 -my-1 flex snap-x scroll-px-4 items-center gap-2 px-4 py-1 sm:-mx-6 sm:scroll-px-6 sm:px-6 @2xl/home:mx-0 @2xl/home:my-0 @2xl/home:flex-wrap @2xl/home:overflow-visible @2xl/home:px-0 @2xl/home:py-0 @5xl/home:min-w-0 @5xl/home:justify-end"
      >
        {pulses.map((pulse) => (
          <PulseChip key={pulse.key} pulse={pulse} />
        ))}
      </ul>
    </section>
  );
}

/** Shown above the dashboard when a background refresh fails; the last data stays visible. */
export function RefreshError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="animate-fade-in-soft flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 py-1.5 pr-1.5 pl-2 text-sm"
    >
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive"
      >
        <TriangleAlertIcon className="size-3.5" />
      </span>
      <p className="min-w-0 flex-1 truncate" title={message}>
        <span className="font-medium">Couldn&apos;t refresh the dashboard.</span>{" "}
        <span className="text-muted-foreground">{message}</span>
      </p>
      <Button variant="outline" size="sm" className="h-11 shrink-0 md:h-7" onClick={onRetry}>
        <RefreshCwIcon />
        Retry
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Quick actions

function KeyHint({ keys }: { keys: string[] }) {
  return (
    <KbdGroup className="hidden md:inline-flex">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </KbdGroup>
  );
}

/** One pill in the quick-actions strip; the longer hint lives in the tooltip. */
const STRIP_ITEM =
  "inline-flex h-11 shrink-0 snap-start items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap md:h-9 [&_svg]:size-4 [&_svg]:shrink-0";

function QuickAction({
  icon,
  label,
  hint,
  keys,
  onClick,
  primary,
  index,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  keys?: string[];
  onClick: () => void;
  primary?: boolean;
  index: number;
}) {
  const enter = useEntrance()(index);
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      style={enter.style}
      className={cn(
        STRIP_ITEM,
        enter.className,
        FOCUS_RING,
        "pressable",
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90 [&_kbd]:bg-primary-foreground/15 [&_kbd]:text-primary-foreground"
          : "bg-muted/60 hover:bg-muted active:bg-muted [&_kbd]:bg-background/70 [&_svg]:text-muted-foreground dark:[&_kbd]:bg-background/40",
      )}
    >
      {icon}
      {label}
      {keys && <KeyHint keys={keys} />}
    </button>
  );
}

const GO_TO: { href: string; label: string; icon: ReactNode; keys: string[] }[] = [
  { href: "/containers", label: "Containers", icon: <ContainerIcon />, keys: ["G", "D"] },
  { href: "/visualize", label: "Visualize", icon: <RadarIcon />, keys: ["G", "V"] },
  { href: "/artifacts", label: "Artifacts", icon: <PackageCheckIcon />, keys: ["G", "A"] },
  { href: "/stats", label: "Stats", icon: <ChartColumnIcon />, keys: ["G", "T"] },
  { href: "/settings", label: "Settings", icon: <SettingsIcon />, keys: ["G", "S"] },
];

export function QuickActions({ onCreateProject }: { onCreateProject: () => void }) {
  const openNewCard = useNewCard();
  const mod = modKeyLabel();
  const visibleMenus = useVisibleDashboardMenus();
  const goTo = GO_TO.filter((item) => isMenuHrefVisible(item.href, visibleMenus));
  return (
    <section aria-labelledby="home-quick-actions">
      <h2 id="home-quick-actions" className="sr-only">
        Quick actions
      </h2>
      {/*
        One strip: actions, then the Go-to links. Phones swipe it sideways edge to edge (the bleed
        hints there is more); wider containers wrap it instead.
      */}
      <div className="scroll-row -mx-4 flex snap-x scroll-px-4 items-center gap-2 px-4 pb-1 sm:-mx-6 sm:scroll-px-6 sm:px-6 @2xl/home:mx-0 @2xl/home:flex-wrap @2xl/home:overflow-visible @2xl/home:px-0 @2xl/home:pb-0">
        <QuickAction
          primary
          index={0}
          icon={<PlusIcon />}
          label="New task"
          hint="Brief an agent in any project"
          keys={["N"]}
          onClick={() => openNewCard()}
        />
        <QuickAction
          index={1}
          icon={<FolderPlusIcon />}
          label="Add project"
          hint="Server folder or Git repo"
          onClick={onCreateProject}
        />
        <QuickAction
          index={2}
          icon={<CommandIcon />}
          label="Jump to…"
          hint="Projects, cards, commands"
          keys={[mod, "K"]}
          onClick={openCommandPalette}
        />
        <QuickAction
          index={3}
          icon={<KeyboardIcon />}
          label="Shortcuts"
          hint="Every key in one place"
          keys={["?"]}
          onClick={openKeyboardHelp}
        />
        {goTo.length > 0 && (
          <>
            <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            <nav aria-label="Go to" className="flex shrink-0 items-center gap-0.5 @2xl/home:flex-wrap">
              <span className="mr-1 text-[11px] whitespace-nowrap text-muted-foreground">Go to</span>
              {goTo.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  title={`${item.label} (${item.keys.join(" then ")})`}
                  className={cn(
                    STRIP_ITEM,
                    "gap-1.5 px-2 text-[13px] font-normal text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground active:bg-muted/60 md:h-8 [&_kbd]:bg-transparent [&_kbd]:px-0.5 [&_kbd]:text-muted-foreground/70 [&_svg]:size-3.5",
                    FOCUS_RING,
                    "pressable",
                  )}
                >
                  {item.icon}
                  {item.label}
                  <KeyHint keys={item.keys} />
                </Link>
              ))}
            </nav>
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Steps: getting started, computed from real state

const SETUP_DISMISSED_KEY = "omp-ui:setup-dismissed";
const SETUP_COLLAPSED_KEY = "omp-ui:setup-collapsed";

/** Dismissed / collapsed state of the steps checklist, persisted in localStorage. */
export interface SetupPrefs {
  dismissed: boolean;
  dismiss: () => void;
  /** null until the user toggles it: then the checklist collapses once every step is done. */
  collapsed: boolean | null;
  setCollapsed: (value: boolean) => void;
}

export function useSetupPrefs(): SetupPrefs {
  const [dismissed, setDismissed] = useState(false);
  const [collapsed, setCollapsedState] = useState<boolean | null>(null);
  useEffect(() => {
    setDismissed(localStorage.getItem(SETUP_DISMISSED_KEY) === "1");
    const stored = localStorage.getItem(SETUP_COLLAPSED_KEY);
    setCollapsedState(stored === null ? null : stored === "1");
  }, []);
  return {
    dismissed,
    dismiss: () => {
      localStorage.setItem(SETUP_DISMISSED_KEY, "1");
      setDismissed(true);
    },
    collapsed,
    setCollapsed: (value: boolean) => {
      localStorage.setItem(SETUP_COLLAPSED_KEY, value ? "1" : "0");
      setCollapsedState(value);
    },
  };
}

interface Step {
  title: string;
  body: string;
  done: boolean;
  optional?: boolean;
  action?: ReactNode;
}

export function GettingStarted({
  dashboard,
  prefs,
}: {
  dashboard: Dashboard;
  prefs: SetupPrefs;
}) {
  const openNewCard = useNewCard();
  const enter = useEntrance();
  const { setup, boards, needsYou } = dashboard;
  const firstBoardId = boards[0]?.id;
  const toPush = needsYou.find((card) => card.reasons.includes("unpushed"));

  const linkButton = (href: string, label: string, keys?: string[]) => (
    <Button size="sm" variant="outline" className="h-11 md:h-7" asChild>
      <Link href={href}>
        {label}
        {keys ? <KeyHint keys={keys} /> : <ArrowRightIcon />}
      </Link>
    </Button>
  );

  const steps: Step[] = [
    { title: "Create a project", body: "A server folder or a cloned Git repo.", done: true },
    {
      title: "Write your first task",
      body: "One card per task. State the goal, constraints and what “done” means.",
      done: setup.hasCard,
      action: (
        <Button size="sm" className="h-11 md:h-7" onClick={() => openNewCard()}>
          <PlusIcon />
          New task
          <KeyHint keys={["N"]} />
        </Button>
      ),
    },
    {
      title: "Run an agent",
      body: "New cards start their agent automatically. To rerun, press Start (or R on a focused card).",
      done: setup.hasRun,
    },
    {
      title: "Ship a change",
      body: "Read the summary on the Done card, then Push to main (P) or open a PR from its Ship panel.",
      done: setup.hasPush,
      action: toPush
        ? linkButton(cardHref(toPush), "Review & push")
        : firstBoardId
          ? linkButton(boardHref(firstBoardId), "Open board")
          : undefined,
    },
    {
      title: "Review the settings",
      body: "Concurrent agents, default model, approval mode, auto-retries and browser access.",
      done: setup.settingsSaved,
      action: linkButton("/settings", "Settings", ["G", "S"]),
    },
    {
      title: "Connect Docker",
      body: setup.dockerAvailable
        ? "Docker is reachable."
        : "The server can't reach Docker. Install or start it to run services from Containers.",
      done: setup.dockerAvailable,
      optional: true,
      action: linkButton("/containers", "Containers", ["G", "D"]),
    },
  ];
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  const complete = doneCount === required.length;
  const next = steps.findIndex((s) => !s.done);
  const collapsed = prefs.collapsed ?? complete;

  return (
    <section aria-labelledby="home-setup" className="@container/setup">
      <Panel className="animate-fade-in-soft overflow-hidden">
        <div className="flex items-center gap-2 p-2 pl-3">
          <button
            type="button"
            onClick={() => prefs.setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls="home-setup-steps"
            className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md text-left md:min-h-8", FOCUS_RING)}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span id="home-setup" className="truncate text-sm font-semibold tracking-tight">
                  {complete ? "You're all set" : "Getting started"}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-md px-1.5 font-mono text-[11px] font-medium tabular-nums",
                    complete ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
                  )}
                >
                  {doneCount}/{required.length}
                  <span className="sr-only"> steps done</span>
                </span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {complete || next < 0 ? (
                  "Every required step is done"
                ) : (
                  <>
                    Next: <span className="text-foreground">{steps[next].title}</span>
                  </>
                )}
              </span>
            </span>
            <ChevronDownIcon
              className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-180")}
              aria-hidden="true"
            />
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 text-muted-foreground md:size-8"
            onClick={prefs.dismiss}
            aria-label="Dismiss getting started"
            title="Dismiss"
          >
            <XIcon />
          </Button>
        </div>
        <div className="mx-3 mb-2.5 h-0.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div
            className="h-full origin-left rounded-full bg-primary transition-transform duration-500 motion-reduce:transition-none"
            style={{ transform: `scaleX(${doneCount / required.length})` }}
          />
        </div>
        {!collapsed && (
          <ol id="home-setup-steps" className="grid grid-cols-1 gap-px border-t bg-border @xl/setup:grid-cols-2">
            {steps.map((step, i) => {
              const current = i === next;
              const entrance = enter(i);
              return (
                <li
                  key={step.title}
                  style={entrance.style}
                  className={cn(
                    entrance.className,
                    "flex items-start gap-3 border-l-2 bg-card p-3",
                    current ? "border-primary" : "border-transparent",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold tabular-nums text-muted-foreground",
                      step.done && "border-transparent bg-success/15 text-success",
                      current && "border-primary/50 bg-primary/10 text-primary",
                    )}
                  >
                    {step.done ? <CheckIcon className="size-3.5" /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm font-medium", step.done && "text-muted-foreground")}>
                      {step.title}
                      {step.optional && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">optional</span>}
                      <span className="sr-only">{step.done ? " (done)" : current ? " (next)" : ""}</span>
                    </p>
                    {!step.done && <p className="mt-0.5 text-xs text-pretty text-muted-foreground">{step.body}</p>}
                    {!step.done && step.action && <div className="mt-2.5">{step.action}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Loading skeleton: mirrors the grid, order and shapes in app/page.tsx so nothing jumps on load

export function DashboardSkeleton() {
  const block = (className: string, key?: number) => <Skeleton key={key} className={className} />;
  // SectionTitle: a min-h-8 row with a 13px heading, mb-3 before the section body.
  const title = (width: string) => <div className="mb-3 flex min-h-8 items-center">{block(cn("h-4", width))}</div>;
  return (
    <div
      className="grid grid-cols-1 items-start gap-6 @2xl/home:grid-cols-2 @2xl/home:gap-x-8 @5xl/home:grid-cols-[minmax(0,2fr)_minmax(19rem,1fr)] @5xl/home:gap-x-10"
      aria-busy="true"
      aria-label="Loading dashboard"
    >
      {/* Pulse header: greeting, status line, chip strip */}
      <div className="col-span-full flex min-w-0 flex-col gap-4 @5xl/home:flex-row @5xl/home:items-end @5xl/home:justify-between @5xl/home:gap-10">
        <div className="space-y-2.5">
          {block("h-8 w-56 max-w-full @2xl/home:h-9")}
          {block("h-4 w-80 max-w-full")}
        </div>
        <div className="-mx-4 flex gap-2 overflow-hidden px-4 sm:-mx-6 sm:px-6 @2xl/home:mx-0 @2xl/home:flex-wrap @2xl/home:px-0 @5xl/home:justify-end">
          {[26, 24, 26, 18, 34].map((width, i) => (
            <Skeleton key={i} style={{ width: `${width * 4}px` }} className="h-11 shrink-0 rounded-lg md:h-9" />
          ))}
        </div>
      </div>

      {/* Work column: needs you, projects, quick actions */}
      <div className="contents @5xl/home:flex @5xl/home:min-w-0 @5xl/home:flex-col @5xl/home:gap-8">
        <div className="order-2 col-span-full min-w-0">
          {title("w-24")}
          <Panel className="divide-y overflow-hidden">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5 px-3 py-2">
                {block("size-7 shrink-0 rounded-md")}
                <div className="flex min-h-11 flex-1 flex-col justify-center gap-1.5 md:min-h-9">
                  {block("h-4 w-3/5")}
                  {block("h-3 w-4/5")}
                </div>
                {block("size-11 shrink-0 md:h-7 md:w-16")}
              </div>
            ))}
          </Panel>
        </div>
        <div className="order-5 col-span-full min-w-0">
          {title("w-20")}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))] gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Panel key={i} className="flex flex-col gap-3 p-4">
                {block("h-5 w-2/5")}
                {block("h-3.5 w-3/4")}
                <div className="grid grid-cols-3 gap-3">
                  {Array.from({ length: 3 }, (_, j) => block("h-9 rounded-lg", j))}
                </div>
                {block("h-1 w-full rounded-full")}
                {block("h-3.5 w-1/2")}
              </Panel>
            ))}
          </div>
        </div>
        <div className="order-6 col-span-full -mx-4 flex min-w-0 gap-2 overflow-hidden px-4 sm:-mx-6 sm:px-6 @2xl/home:mx-0 @2xl/home:flex-wrap @2xl/home:px-0">
          {[28, 30, 26, 24].map((width, i) => (
            <Skeleton key={i} style={{ width: `${width * 4}px` }} className="h-11 shrink-0 rounded-lg md:h-9" />
          ))}
        </div>
      </div>

      {/* Rail: live agents, stats, activity */}
      <div className="contents @5xl/home:flex @5xl/home:min-w-0 @5xl/home:flex-col @5xl/home:gap-8">
        <div className="order-3 col-span-full min-w-0 @5xl/home:order-none">
          {title("w-24")}
          <Panel className="space-y-3 p-3">
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="flex items-start gap-2.5">
                {block("size-6 shrink-0 rounded-full")}
                <div className="flex-1 space-y-1.5">
                  {block("h-4 w-3/4")}
                  {block("h-3 w-1/2")}
                </div>
                {block("size-11 shrink-0 md:size-7")}
              </div>
            ))}
          </Panel>
        </div>
        <div className="order-7 min-w-0">
          {title("w-16")}
          <Panel className="space-y-3 p-4">
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="space-y-1.5">
                  {block("h-3 w-12")}
                  {block("h-7 w-10")}
                </div>
              ))}
            </div>
            {block("h-12 w-full rounded-lg")}
          </Panel>
        </div>
        <div className="order-8 min-w-0">
          {title("w-28")}
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-start gap-2.5">
                {block("size-[22px] shrink-0 rounded-full")}
                <div className="flex-1 space-y-1.5">
                  {block("h-3 w-2/3")}
                  {block("h-4 w-full")}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
