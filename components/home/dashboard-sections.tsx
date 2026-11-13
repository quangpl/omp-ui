"use client";

import { useEffect, useState, type ReactNode } from "react";
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
// Overview: greeting and a one-line status

function greeting(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function Overview({ dashboard, now }: { dashboard: Dashboard; now: number }) {
  const { totals, queue, needsYouTotal, boards } = dashboard;
  const running = queue.running.length;
  const queued = queue.queued.length;

  const status: string[] = [];
  if (needsYouTotal > 0) status.push(`${plural(needsYouTotal, "card")} need${needsYouTotal === 1 ? "s" : ""} you`);
  if (running > 0) status.push(`${plural(running, "agent")} working`);
  if (queued > 0) status.push(`${queued} queued`);
  if (status.length === 0) {
    status.push(totals.todo > 0 ? `${plural(totals.todo, "card")} ready to start` : "All quiet — nothing waiting on you");
  }

  const figures: { label: string; value: number; tone?: string }[] = [
    { label: "projects", value: boards.length },
    { label: "to do", value: totals.todo },
    { label: "in progress", value: totals.in_progress, tone: totals.in_progress > 0 ? "text-primary" : undefined },
    { label: "done", value: totals.done },
  ];
  const date = new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <section
      aria-labelledby="home-overview"
      className="animate-fade-in-soft flex flex-col gap-4 @2xl/home:flex-row @2xl/home:items-end @2xl/home:justify-between @2xl/home:gap-8"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{date}</p>
        <h2 id="home-overview" className="mt-1 text-2xl font-semibold tracking-tight text-balance md:text-3xl">
          {greeting(new Date(now).getHours())}
        </h2>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">{status.join(" · ")}</p>
      </div>
      <dl className="grid shrink-0 grid-cols-4 divide-x border-y py-2.5 @2xl/home:border-y-0 @2xl/home:py-0">
        {figures.map((figure) => (
          <div
            key={figure.label}
            className="flex min-w-0 flex-col-reverse justify-end gap-1 px-2.5 first:pl-0 last:pr-0 @2xl/home:px-5 @2xl/home:text-right"
          >
            <dt className="text-xs leading-tight text-muted-foreground">{figure.label}</dt>
            <dd className={cn("font-mono text-xl leading-none font-semibold tabular-nums md:text-2xl", figure.tone)}>
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Shown above the dashboard when a background refresh fails; the last data stays visible. */
export function RefreshError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="animate-fade-in-soft flex items-center gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
    >
      <TriangleAlertIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        Couldn&apos;t refresh the dashboard <span className="text-muted-foreground">— {message}</span>
      </span>
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
          : "border bg-card hover:bg-muted/60 active:bg-muted/60 [&_svg]:text-muted-foreground",
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
            <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
            <nav aria-label="Go to" className="flex shrink-0 items-center gap-1">
              <span className="mr-1 text-xs whitespace-nowrap text-muted-foreground">Go to</span>
              {goTo.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    STRIP_ITEM,
                    "px-2.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/60 [&_svg]:size-3.5",
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
    <section aria-labelledby="home-setup">
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
              <span id="home-setup" className="block text-sm font-semibold tracking-tight">
                {complete ? "You're all set" : "Getting started"}
              </span>
              <span className="block text-xs text-muted-foreground">
                {doneCount} of {required.length} steps done
                {!complete && next >= 0 ? ` · next: ${steps[next].title.toLowerCase()}` : ""}
              </span>
            </span>
            <span className="hidden h-1 w-24 overflow-hidden rounded-full bg-muted sm:block" aria-hidden="true">
              <span
                className="block h-full origin-left rounded-full bg-success transition-transform duration-500 motion-reduce:transition-none"
                style={{ transform: `scaleX(${doneCount / required.length})` }}
              />
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
        {!collapsed && (
          <ol id="home-setup-steps" className="grid grid-cols-1 gap-px border-t bg-border @xl/home:grid-cols-2">
            {steps.map((step, i) => {
              const current = i === next;
              const entrance = enter(i);
              return (
                <li key={step.title} style={entrance.style} className={cn(entrance.className, "flex items-start gap-3 bg-card p-3")}>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
                      step.done && "border-transparent bg-success/15 text-success",
                      current && "border-foreground/40 text-foreground",
                    )}
                  >
                    {step.done ? <CheckIcon className="size-3.5" /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm font-medium", step.done && "text-muted-foreground")}>
                      {step.title}
                      {step.optional && <span className="ml-1.5 text-xs font-normal text-muted-foreground">optional</span>}
                      <span className="sr-only">{step.done ? " (done)" : current ? " (next)" : ""}</span>
                    </p>
                    {!step.done && <p className="text-xs text-pretty text-muted-foreground">{step.body}</p>}
                    {!step.done && step.action && <div className="mt-2">{step.action}</div>}
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
// Loading skeleton: mirrors the layout in app/page.tsx

export function DashboardSkeleton() {
  const block = (className: string, key?: number) => <Skeleton key={key} className={className} />;
  const title = (width: string) => block(cn("mb-2.5 h-5", width));
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="flex flex-col gap-4 @2xl/home:flex-row @2xl/home:items-end @2xl/home:justify-between @2xl/home:gap-8">
        <div className="space-y-2">
          {block("h-3.5 w-32")}
          {block("h-8 w-56 max-w-full")}
          {block("h-4 w-72 max-w-full")}
        </div>
        <div className="grid grid-cols-4 divide-x border-y py-2.5 @2xl/home:border-y-0 @2xl/home:py-0">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex flex-col gap-1 px-2.5 first:pl-0 last:pr-0 @2xl/home:items-end @2xl/home:px-5">
              {block("h-5 w-8 md:h-6")}
              {block("h-3 w-12")}
            </div>
          ))}
        </div>
      </div>
      <div className="-mx-4 flex gap-2 overflow-hidden px-4 sm:-mx-6 sm:px-6 @2xl/home:mx-0 @2xl/home:px-0">
        {[28, 32, 28, 24, 24].map((width, i) => (
          <Skeleton key={i} style={{ width: `${width * 4}px` }} className="h-11 shrink-0 rounded-lg md:h-9" />
        ))}
      </div>
      <div className="grid grid-cols-1 items-start gap-6 @5xl/home:grid-cols-[minmax(0,2fr)_minmax(19rem,1fr)] @5xl/home:gap-x-10">
        <div className="flex min-w-0 flex-col gap-6 @5xl/home:gap-8">
          <div className="min-w-0">
            {title("w-28")}
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
          <div className="min-w-0">
            {title("w-24")}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))] gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <Panel key={i} className="flex flex-col gap-3 p-4">
                  {block("h-5 w-2/5")}
                  {block("h-3.5 w-3/4")}
                  <div className="grid grid-cols-3 gap-3">
                    {Array.from({ length: 3 }, (_, j) => block("h-9", j))}
                  </div>
                  {block("h-1 w-full rounded-full")}
                  {block("h-3.5 w-1/2")}
                </Panel>
              ))}
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-6 @5xl/home:gap-8">
          <div className="min-w-0">
            {title("w-28")}
            <Panel className="space-y-3 p-3">
              {block("h-1.5 w-full rounded-full")}
              {Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  {block("size-6 shrink-0 rounded-full")}
                  <div className="flex-1 space-y-1.5">
                    {block("h-4 w-3/4")}
                    {block("h-3 w-1/2")}
                  </div>
                </div>
              ))}
            </Panel>
          </div>
          <div className="min-w-0">
            {title("w-24")}
            <div className="flex items-end gap-3 border-t pt-3">
              <div className="flex-1 space-y-1.5">
                {block("h-3 w-16")}
                {block("h-7 w-12")}
                {block("h-3 w-32")}
              </div>
              {block("h-9 w-24")}
            </div>
          </div>
          <div className="min-w-0">
            {title("w-32")}
            <div className="space-y-3 border-t pt-3">
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
    </div>
  );
}
