"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CalendarOff,
  History,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  Settings2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { errorMessage, formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { NewTaskForm } from "@/components/board/new-task-form";
import { ProjectField } from "@/components/board/project-field";
import {
  ScheduleFields,
  STICKY_FORM_ACTIONS,
  scheduleError,
  type ScheduleValue,
} from "@/components/schedulers/schedule-fields";
import { RunResultBadge, SchedulerHistory, schedulerCardHref } from "@/components/schedulers/scheduler-history";
import { SchedulerLogs } from "@/components/schedulers/scheduler-logs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ApiRequestError, api, subscribeEvents } from "@/lib/api-client";
import { describeCron } from "@/lib/cron";
import type { BoardWithCounts, Scheduler, SchedulerRunView } from "@/lib/types";

/** Coalesce bursts of card/run events into one history refetch. */
const REFRESH_DELAY_MS = 500;

/** Longest scheduler name the API accepts. */
const NAME_MAX = 100;

type DetailTab = "config" | "history" | "logs";

const TAB_TRIGGER_CLASS =
  "flex-none gap-1.5 px-3 group-data-horizontal/tabs:after:bottom-[-3px] max-md:min-w-11";

/** The cron expression in words; the raw expression if it can't be described. */
function scheduleText(cron: string): string {
  try {
    return describeCron(cron);
  } catch {
    return cron;
  }
}

/** Enabled / Disabled / Limit reached (`maxRuns` hit, which also disables it). */
function SchedulerStatusBadge({ enabled, exhausted }: { enabled: boolean; exhausted: boolean }) {
  if (exhausted) {
    return (
      <Badge variant="secondary" className="gap-1">
        <CalendarOff />
        Limit reached
      </Badge>
    );
  }
  return enabled ? (
    <Badge className="gap-1 bg-success/10 text-success">
      <CalendarClock />
      Enabled
    </Badge>
  ) : (
    <Badge variant="outline">Disabled</Badge>
  );
}

/** Count pill in a tab label. */
function TabCount({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-1.5 text-[11px] leading-4 font-medium text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

/** One label/value pair of the summary grid. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/**
 * Scheduler page: header with its schedule, next run, last result and the Enabled / Run now /
 * Delete actions, then tabs to edit its configuration, browse its run history and read its log.
 * Updates live from the event stream (the scheduler itself and the cards it created).
 */
export function SchedulerDetail({ id }: { id: string }) {
  const router = useRouter();
  const now = useNow();
  const [scheduler, setScheduler] = useState<Scheduler | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runs, setRuns] = useState<SchedulerRunView[] | null>(null);
  const [boards, setBoards] = useState<BoardWithCounts[] | null>(null);
  const [logsKey, setLogsKey] = useState(0);
  const [tab, setTab] = useState<DetailTab>("config");
  const [toggling, setToggling] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** Latest scheduler/runs request; older responses (and ones overtaken by live events) are dropped. */
  const schedulerRequestRef = useRef(0);
  const runsRequestRef = useRef(0);
  /** Set while this page deletes the scheduler, so its own `scheduler.deleted` event stays quiet. */
  const deletingRef = useRef(false);
  /** Cards created by this scheduler (from its history), whose changes refresh the history. */
  const taskIdsRef = useRef(new Set<string>());

  useDocumentTitle(scheduler?.name);

  const applyScheduler = useCallback((next: Scheduler) => {
    schedulerRequestRef.current += 1;
    setScheduler(next);
  }, []);

  const loadScheduler = useCallback(async () => {
    const request = ++schedulerRequestRef.current;
    try {
      const next = await api.schedulers.get(id);
      if (request !== schedulerRequestRef.current) return;
      setScheduler(next);
      setLoadError(null);
    } catch (err) {
      if (request !== schedulerRequestRef.current) return;
      if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
      else setLoadError(errorMessage(err));
    }
  }, [id]);

  const loadRuns = useCallback(async () => {
    const request = ++runsRequestRef.current;
    try {
      const next = await api.schedulers.runs(id);
      if (request !== runsRequestRef.current) return;
      taskIdsRef.current = new Set(next.flatMap((run) => (run.taskId ? [run.taskId] : [])));
      setRuns(next);
    } catch {
      // A failed refresh keeps the history on screen; the first load falls back to "no runs".
      if (request === runsRequestRef.current) setRuns((current) => current ?? []);
    }
  }, [id]);

  const loadBoards = useCallback(async () => {
    try {
      setBoards(await api.boards.list());
    } catch (err) {
      toast.error("Couldn't load projects", { description: errorMessage(err) });
      setBoards((current) => current ?? []);
    }
  }, []);

  /** Refetch everything that may have changed while events could have been missed. */
  const refreshAll = useCallback(() => {
    void loadScheduler();
    void loadRuns();
    setLogsKey((key) => key + 1);
  }, [loadScheduler, loadRuns]);

  useEffect(() => {
    void loadScheduler();
    void loadRuns();
    void loadBoards();
  }, [loadScheduler, loadRuns, loadBoards]);

  useEffect(() => {
    const onFocus = () => refreshAll();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshAll]);

  // The stream is limited to the scheduler's project: its own events and its cards' all carry it.
  const boardId = scheduler?.boardId ?? null;
  useEffect(() => {
    if (!boardId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void loadRuns();
        setLogsKey((key) => key + 1);
      }, REFRESH_DELAY_MS);
    };
    const unsubscribe = subscribeEvents(
      (event) => {
        switch (event.type) {
          case "scheduler.updated":
            if (event.scheduler.id !== id) return;
            applyScheduler(event.scheduler);
            scheduleRefresh();
            return;
          case "scheduler.deleted":
            if (event.schedulerId !== id || deletingRef.current) return;
            toast("This scheduler was deleted");
            router.push("/schedulers");
            return;
          case "task.updated":
            if (event.task.schedulerId === id || taskIdsRef.current.has(event.task.id)) scheduleRefresh();
            return;
          case "task.deleted":
            if (taskIdsRef.current.has(event.taskId)) scheduleRefresh();
            return;
          case "run.updated":
            if (taskIdsRef.current.has(event.run.taskId)) scheduleRefresh();
            return;
        }
      },
      { boardId, onReconnect: refreshAll, onFirstOpen: refreshAll },
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [id, boardId, applyScheduler, loadRuns, refreshAll, router]);

  const setEnabled = async (enabled: boolean) => {
    if (!scheduler || toggling) return;
    const previous = scheduler.enabled;
    setToggling(true);
    applyScheduler({ ...scheduler, enabled });
    try {
      applyScheduler(await api.schedulers.update(id, { enabled }));
    } catch (err) {
      toast.error(enabled ? "Couldn't enable the scheduler" : "Couldn't disable the scheduler", {
        description: errorMessage(err),
      });
      setScheduler((current) => (current ? { ...current, enabled: previous } : current));
    } finally {
      setToggling(false);
    }
  };

  const runNow = async () => {
    if (!scheduler || running) return;
    setRunning(true);
    try {
      const run = await api.schedulers.run(id);
      const taskId = run.taskId;
      if (run.status === "created" && taskId) {
        const cardBoardId = scheduler.boardId;
        toast.success("Card created", {
          description: run.task?.title || "The agent is writing its title and brief.",
          action: { label: "Open", onClick: () => router.push(schedulerCardHref(cardBoardId, taskId)) },
        });
      } else {
        toast.error("The run failed", { description: run.error ?? "The card couldn't be created." });
      }
    } catch (err) {
      toast.error("Couldn't run the scheduler", { description: errorMessage(err) });
    } finally {
      setRunning(false);
      refreshAll();
    }
  };

  const remove = async () => {
    deletingRef.current = true;
    try {
      await api.schedulers.remove(id);
      toast.success("Scheduler deleted");
      router.push("/schedulers");
    } catch (err) {
      deletingRef.current = false;
      toast.error("Couldn't delete the scheduler", { description: errorMessage(err) });
    }
  };

  const projectName = scheduler ? boards?.find((board) => board.id === scheduler.boardId)?.name : undefined;

  if (notFound) {
    return (
      <div className="flex min-h-dvh flex-col">
        <AppHeader title="Scheduler" backHref="/schedulers" />
        <main className="px-safe pb-safe flex flex-1 items-center justify-center px-4 py-16">
          <div className="max-w-sm text-center">
            <CalendarOff className="mx-auto size-8 text-muted-foreground" aria-hidden />
            <h1 className="mt-3 text-lg font-semibold tracking-tight">Scheduler not found</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              It may have been deleted. Cards it created are still on their project&apos;s board.
            </p>
            <Button asChild className="mt-5 h-11 md:h-9">
              <Link href="/schedulers">
                <ArrowLeft />
                All schedulers
              </Link>
            </Button>
          </div>
        </main>
      </div>
    );
  }

  if (!scheduler) {
    return (
      <div className="flex min-h-dvh flex-col">
        <AppHeader title="Scheduler" backHref="/schedulers" />
        <main className="px-safe pb-safe flex-1">
          {loadError ? (
            <div className="mx-auto max-w-sm px-4 py-16 text-center">
              <TriangleAlert className="mx-auto size-8 text-destructive" aria-hidden />
              <h1 className="mt-3 text-lg font-semibold tracking-tight">Couldn&apos;t load this scheduler</h1>
              <p className="mt-1 text-sm break-words text-muted-foreground">{loadError}</p>
              <Button
                variant="outline"
                className="mt-5 h-11 md:h-9"
                onClick={() => {
                  setLoadError(null);
                  refreshAll();
                }}
              >
                <RefreshCw />
                Try again
              </Button>
            </div>
          ) : (
            <SchedulerDetailSkeleton />
          )}
        </main>
      </div>
    );
  }

  const exhausted = scheduler.maxRuns !== null && scheduler.runCount >= scheduler.maxRuns;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title={scheduler.name} subtitle={projectName} backHref="/schedulers" />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-[1400px] animate-page-in space-y-6 px-4 py-6 sm:px-6 md:space-y-8 md:py-8 lg:px-8 motion-reduce:animate-none">
          <section className="space-y-5">
            <Link
              href="/schedulers"
              className="inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:hidden"
            >
              <ArrowLeft className="size-4" aria-hidden />
              Schedulers
            </Link>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 text-2xl font-semibold tracking-tighter break-words md:text-3xl">
                    {scheduler.name}
                  </h2>
                  <SchedulerStatusBadge enabled={scheduler.enabled} exhausted={exhausted} />
                </div>
                <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                  <Link
                    href={`/b/${encodeURIComponent(scheduler.boardId)}`}
                    className="rounded font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {projectName ?? (boards === null ? "Project" : "Open project")}
                  </Link>
                  <span aria-hidden>·</span>
                  <span title={scheduler.cron}>{scheduleText(scheduler.cron)}</span>
                  <span className="font-mono text-xs">({scheduler.timezone})</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
                <Label
                  htmlFor="scheduler-enabled"
                  className="flex h-11 cursor-pointer items-center gap-2 rounded-md border px-3 md:h-9"
                >
                  <Switch
                    id="scheduler-enabled"
                    checked={scheduler.enabled}
                    disabled={toggling}
                    onCheckedChange={(enabled) => void setEnabled(enabled)}
                  />
                  Enabled
                </Label>
                <Button className="h-11 md:h-9" disabled={running} onClick={() => void runNow()}>
                  {running ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
                  {running ? "Running…" : "Run now"}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 text-destructive hover:text-destructive md:h-9"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 aria-hidden />
                  Delete
                </Button>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 rounded-xl border bg-card/40 p-4 md:grid-cols-4">
              <Fact label="Next run">
                {scheduler.nextRunAt ? (
                  <time dateTime={scheduler.nextRunAt} title={formatDateTime(scheduler.nextRunAt)}>
                    <span className="font-mono font-medium tabular-nums">{formatRelative(scheduler.nextRunAt, now)}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {formatDateTime(scheduler.nextRunAt)}
                    </span>
                  </time>
                ) : (
                  <span className="text-muted-foreground">
                    {exhausted ? "None, limit reached" : !scheduler.enabled ? "None while disabled" : "Never matches again"}
                  </span>
                )}
              </Fact>
              <Fact label="Last result">
                {scheduler.lastStatus ? (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RunResultBadge status={scheduler.lastStatus} />
                      {scheduler.lastStatus === "created" && scheduler.lastTaskId && (
                        <Link
                          href={schedulerCardHref(scheduler.boardId, scheduler.lastTaskId)}
                          className="inline-flex items-center gap-0.5 rounded text-xs font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          Open card
                          <ArrowRight className="size-3" aria-hidden />
                        </Link>
                      )}
                    </div>
                    {scheduler.lastRunAt && (
                      <p className="text-xs text-muted-foreground" title={formatDateTime(scheduler.lastRunAt)}>
                        {formatRelative(scheduler.lastRunAt, now)}
                      </p>
                    )}
                    {scheduler.lastStatus === "failed" && scheduler.lastError && (
                      <p className="line-clamp-2 text-xs break-words text-destructive" title={scheduler.lastError}>
                        {scheduler.lastError}
                      </p>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">Not run yet</span>
                )}
              </Fact>
              <Fact label="Runs">
                <span className="font-mono font-medium tabular-nums">
                  {scheduler.runCount.toLocaleString()}
                  {scheduler.maxRuns !== null && (
                    <span className="font-normal text-muted-foreground"> of {scheduler.maxRuns.toLocaleString()}</span>
                  )}
                </span>
              </Fact>
              <Fact label="Created">
                <span title={formatDateTime(scheduler.createdAt)}>{formatRelative(scheduler.createdAt, now)}</span>
              </Fact>
            </dl>
          </section>

          <Tabs value={tab} onValueChange={(value) => setTab(value as DetailTab)} className="gap-4">
            <div className="scroll-row -mx-4 border-b sm:-mx-6 md:mx-0">
              <TabsList
                variant="line"
                className="w-max min-w-full justify-start gap-1 px-2 group-data-horizontal/tabs:h-12 md:px-0 md:group-data-horizontal/tabs:h-11"
              >
                <TabsTrigger value="config" className={TAB_TRIGGER_CLASS}>
                  <Settings2 />
                  Configuration
                </TabsTrigger>
                <TabsTrigger value="history" className={TAB_TRIGGER_CLASS}>
                  <History />
                  History
                  {runs && runs.length > 0 && <TabCount>{runs.length}</TabCount>}
                </TabsTrigger>
                <TabsTrigger value="logs" className={TAB_TRIGGER_CLASS}>
                  <ScrollText />
                  Logs
                </TabsTrigger>
              </TabsList>
            </div>
            {/* Mounted while hidden so unsaved edits survive switching tabs. */}
            <TabsContent value="config" forceMount className="min-w-0 data-[state=inactive]:hidden">
              <SchedulerConfig key={scheduler.id} scheduler={scheduler} boards={boards} onSaved={applyScheduler} />
            </TabsContent>
            <TabsContent value="history" className="min-w-0">
              <SchedulerHistory runs={runs} boardId={scheduler.boardId} now={now} />
            </TabsContent>
            <TabsContent value="logs" className="min-w-0">
              <SchedulerLogs schedulerId={scheduler.id} runs={runs} refreshKey={logsKey} />
            </TabsContent>
          </Tabs>
        </div>
      </main>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this scheduler?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{scheduler.name}&rdquo; stops creating cards and its run history and log are removed. Cards it
              already created stay on their board.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" className="max-md:h-11" onClick={() => void remove()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Editable fields of a scheduler besides its prompt (which the composer owns). */
interface ConfigDraft {
  name: string;
  boardId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  maxRuns: number | null;
}

const DRAFT_KEYS = ["name", "boardId", "cron", "timezone", "enabled", "maxRuns"] as const;

function draftOf(scheduler: Scheduler): ConfigDraft {
  const { name, boardId, cron, timezone, enabled, maxRuns } = scheduler;
  return { name, boardId, cron, timezone, enabled, maxRuns };
}

/**
 * "Configuration" tab: name, project, prompt and schedule, saved together. Live updates of the
 * scheduler only replace the fields the user hasn't touched, so edits in progress survive them
 * (the prompt text is the composer's own state and is never replaced while mounted).
 */
function SchedulerConfig({
  scheduler,
  boards,
  onSaved,
}: {
  scheduler: Scheduler;
  boards: BoardWithCounts[] | null;
  onSaved: (scheduler: Scheduler) => void;
}) {
  const [draft, setDraft] = useState<ConfigDraft>(() => draftOf(scheduler));
  /** The scheduler as of the last sync; a draft field equal to it is untouched. */
  const baseRef = useRef<ConfigDraft>(draft);

  useEffect(() => {
    const next = draftOf(scheduler);
    const base = baseRef.current;
    baseRef.current = next;
    setDraft((current) => {
      const merged = { ...current };
      for (const key of DRAFT_KEYS) {
        if (current[key] === base[key]) (merged as Record<string, unknown>)[key] = next[key];
      }
      return merged;
    });
  }, [scheduler]);

  const schedule: ScheduleValue = useMemo(
    () => ({ cron: draft.cron, timezone: draft.timezone, enabled: draft.enabled, maxRuns: draft.maxRuns }),
    [draft.cron, draft.timezone, draft.enabled, draft.maxRuns],
  );
  const name = draft.name.trim();
  const nameError = name ? null : "Give the scheduler a name";
  const canSubmit = !nameError && name.length <= NAME_MAX && !scheduleError(schedule) && Boolean(draft.boardId);

  const save = async (prompt: string) => {
    try {
      const next = await api.schedulers.update(scheduler.id, {
        name,
        boardId: draft.boardId,
        prompt,
        cron: draft.cron.trim(),
        timezone: draft.timezone.trim(),
        enabled: draft.enabled,
        maxRuns: draft.maxRuns,
      });
      const saved = draftOf(next);
      baseRef.current = saved;
      setDraft(saved);
      onSaved(next);
      toast.success("Scheduler saved");
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  return (
    <div className="max-w-3xl">
      <NewTaskForm
        className={STICKY_FORM_ACTIONS}
        onSubmit={save}
        initialText={scheduler.prompt}
        boardId={draft.boardId}
        label="What should the agent do each time?"
        hint="Each run creates a card from this text in the project, like the New task form: an agent writes its title and brief, then starts work."
        submitLabel="Save changes"
        busyLabel="Saving…"
        resetOnSubmit={false}
        autoFocus={false}
        canSubmit={canSubmit}
        projectField={
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="scheduler-name">Name</Label>
              <Input
                id="scheduler-name"
                value={draft.name}
                maxLength={NAME_MAX}
                autoComplete="off"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? "scheduler-name-error" : undefined}
                className="h-11 md:h-9"
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
              {nameError && (
                <p id="scheduler-name-error" className="text-xs text-destructive">
                  {nameError}
                </p>
              )}
            </div>
            <ProjectField
              boards={boards}
              value={draft.boardId}
              onValueChange={(boardId) => setDraft((current) => ({ ...current, boardId }))}
            />
          </div>
        }
      >
        <ScheduleFields
          value={schedule}
          onChange={(value) => setDraft((current) => ({ ...current, ...value }))}
        />
        {draft.boardId !== scheduler.boardId && (
          <p className="text-xs text-muted-foreground">
            New cards go to the new project; cards already created stay where they are.
          </p>
        )}
      </NewTaskForm>
    </div>
  );
}

function SchedulerDetailSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 md:space-y-8 md:py-8 lg:px-8"
      aria-busy="true"
      aria-label="Loading scheduler"
    >
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-64 max-w-full" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-11 w-28 md:h-9" />
            <Skeleton className="h-11 w-28 md:h-9" />
            <Skeleton className="h-11 w-24 md:h-9" />
          </div>
        </div>
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-64 w-full max-w-3xl rounded-xl" />
      </div>
    </div>
  );
}
