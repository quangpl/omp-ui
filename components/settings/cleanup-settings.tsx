"use client";

import { useCallback, useEffect, useState } from "react";
import { BrushCleaningIcon, CheckIcon, Loader2Icon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import {
  SettingsField,
  SettingsGroup,
  SettingsPanel,
  SettingsSaveBar,
  SettingsSection,
} from "@/components/settings/settings-section";
import { formatBytes } from "@/components/stats/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiRequestError, api } from "@/lib/api-client";
import type { CleanupSchedule, CleanupStatus, ScheduledCleanupId } from "@/lib/types";
import { cn } from "@/lib/utils";

const FIELD = "h-11 md:h-9";
/** While a cleanup someone else started (the schedule, another tab) runs, re-read the status this often. */
const RUNNING_POLL_MS = 3_000;

const SCHEDULE_OPTIONS: { value: CleanupSchedule; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Nothing runs on its own; use “Clean up now” when you want." },
  {
    value: "weekly",
    label: "Weekly",
    hint: "Runs every 7 days. The first run is 7 days after you turn it on.",
  },
  {
    value: "monthly",
    label: "Monthly",
    hint: "Runs every 30 days. The first run is 30 days after you turn it on.",
  },
];

const ARROW_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function sameTargets(a: readonly ScheduledCleanupId[], b: readonly ScheduledCleanupId[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Three-option segmented radio group (Off / Weekly / Monthly). */
function ScheduleToggle({
  value,
  onChange,
  disabled,
}: {
  value: CleanupSchedule;
  onChange: (schedule: CleanupSchedule) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby="cleanup-schedule-label"
      className="grid w-full grid-cols-3 rounded-lg bg-muted p-1 sm:w-72"
      onKeyDown={(e) => {
        const step = ARROW_STEPS[e.key];
        if (!step) return;
        e.preventDefault();
        const index = SCHEDULE_OPTIONS.findIndex((option) => option.value === value);
        const next = SCHEDULE_OPTIONS[(index + step + SCHEDULE_OPTIONS.length) % SCHEDULE_OPTIONS.length].value;
        onChange(next);
        e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus();
      }}
    >
      {SCHEDULE_OPTIONS.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-10 rounded-md text-sm font-medium transition-[background-color,color,box-shadow,scale] duration-150 ease-(--ease-fluid) outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] disabled:opacity-50 motion-reduce:transition-none md:h-7",
              checked
                ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 text-right">{children}</dd>
    </div>
  );
}

/** Settings → Data cleanup: prune leftover AgentMan data weekly or monthly, or right now. */
export function CleanupSettingsSection() {
  const [status, setStatus] = useState<CleanupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<CleanupSchedule>("off");
  const [targets, setTargets] = useState<ScheduledCleanupId[]>([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const now = useNow();

  /** Take a fresh status; `resetDraft` also replaces the schedule and target picks with the saved ones. */
  const applyStatus = useCallback((next: CleanupStatus, resetDraft: boolean) => {
    setStatus(next);
    if (resetDraft) {
      setSchedule(next.schedule);
      setTargets(next.targets);
    }
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    api.cleanup
      .status()
      .then((next) => applyStatus(next, true))
      .catch((err) => setLoadError(errorText(err, "Could not load the cleanup settings.")));
  }, [applyStatus]);

  useEffect(load, [load]);

  // Follow a cleanup this page didn't start until it finishes.
  const serverRunning = (status?.running ?? false) && !running;
  useEffect(() => {
    if (!serverRunning) return;
    const timer = window.setInterval(() => {
      api.cleanup
        .status()
        .then((next) => applyStatus(next, false))
        .catch(() => {
          // Keep the last status; the next tick retries.
        });
    }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [serverRunning, applyStatus]);

  const dirty = status !== null && (status.schedule !== schedule || !sameTargets(status.targets, targets));
  const noTargets = targets.length === 0;
  const invalid = schedule !== "off" && noTargets;
  const busy = running || (status?.running ?? false);

  function toggleTarget(id: ScheduledCleanupId) {
    if (!status) return;
    const picked = new Set(targets);
    if (picked.has(id)) picked.delete(id);
    else picked.add(id);
    // Keep the server's order so the saved list and the dirty check stay stable.
    setTargets(status.available.map((t) => t.id).filter((t) => picked.has(t)));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || saving || invalid) return;
    setSaving(true);
    try {
      await api.settings.update({ cleanupSchedule: schedule, cleanupTargets: targets });
      applyStatus(await api.cleanup.status(), true);
      toast.success("Cleanup schedule saved");
    } catch (err) {
      toast.error(errorText(err, "Could not save the cleanup schedule."));
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    if (busy || noTargets) return;
    setRunning(true);
    try {
      const next = await api.cleanup.run(targets);
      applyStatus(next, false);
      const result = next.lastResult;
      const freed = result && result.freedBytes > 0 ? `Freed ${formatBytes(result.freedBytes)}.` : "Nothing to free.";
      if (result?.results.some((step) => !step.ok)) {
        toast.warning("Cleanup finished with problems", { description: freed });
      } else {
        toast.success("Cleanup finished", { description: freed });
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        toast.error("A cleanup is already running", { description: "Wait for it to finish, then try again." });
        api.cleanup
          .status()
          .then((next) => applyStatus(next, false))
          .catch(() => {});
      } else {
        toast.error(errorText(err, "Could not run the cleanup."));
      }
    } finally {
      setRunning(false);
    }
  }

  const scheduleHint = SCHEDULE_OPTIONS.find((option) => option.value === schedule)?.hint;
  const labels = new Map<string, string>(status?.available.map((t) => [t.id, t.label]));

  return (
    <SettingsSection
      id="cleanup"
      icon={<BrushCleaningIcon />}
      title="Data cleanup"
      description="Remove AgentMan leftovers on a schedule: orphaned files and worktrees, stale drafts, caches and old logs. Docker prunes stay manual under Stats → Optimize."
    >
      {loadError ? (
        <SettingsPanel className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="flex min-w-0 flex-1 gap-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">Couldn't load cleanup settings</p>
              <p className="text-destructive">{loadError}</p>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={load} className={cn(FIELD, "pressable w-full gap-2 sm:w-auto")}>
            <RotateCcwIcon />
            Try again
          </Button>
        </SettingsPanel>
      ) : !status ? (
        <SettingsPanel>
          <div aria-busy="true" className="divide-y">
            <div className="space-y-3 p-4 sm:p-5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-12 w-full sm:w-72 md:h-9" />
              <Skeleton className="h-3 w-2/3" />
            </div>
            <div className="space-y-4 p-4 sm:p-5">
              <Skeleton className="h-3 w-28" />
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="size-4 shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-3 p-4 sm:p-5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-11 w-full" />
            </div>
          </div>
        </SettingsPanel>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <SettingsPanel>
            <SettingsGroup title="Schedule">
              <SettingsField label="Run automatically" labelId="cleanup-schedule-label" hint={scheduleHint}>
                <ScheduleToggle value={schedule} onChange={setSchedule} disabled={saving} />
              </SettingsField>
            </SettingsGroup>

            <SettingsGroup title="What to clean">
              <fieldset className="min-w-0 space-y-2" aria-describedby={invalid ? "cleanup-targets-error" : undefined}>
                <legend className="sr-only">Cleanup targets</legend>
                <ul className="-mx-4 divide-y divide-border/70 sm:-mx-5">
                  {status.available.map((target) => (
                    <li key={target.id}>
                      <label className="flex min-h-12 cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40 active:bg-muted/70 has-disabled:cursor-not-allowed has-disabled:active:bg-transparent sm:px-5">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-5 shrink-0 accent-primary md:size-4"
                          checked={targets.includes(target.id)}
                          disabled={saving}
                          onChange={() => toggleTarget(target.id)}
                        />
                        <span className="min-w-0 flex-1 space-y-0.5">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-sm font-medium">{target.label}</span>
                            {target.risk === "review" && (
                              <Badge className="shrink-0 bg-amber-500/15 text-amber-700 dark:text-amber-400">Review</Badge>
                            )}
                          </span>
                          <span className="block text-xs text-pretty text-muted-foreground">{target.description}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {invalid ? (
                  <p id="cleanup-targets-error" className="text-xs text-destructive">
                    Pick at least one target, or turn the schedule off.
                  </p>
                ) : (
                  <p className="text-xs text-pretty text-muted-foreground">
                    “Review” items delete work you may still want; leave them off unless you're sure.
                  </p>
                )}
              </fieldset>
            </SettingsGroup>

            <SettingsGroup title="Activity">
              <dl className="divide-y">
                <Row label="Last cleanup">
                  {status.lastRunAt ? (
                    <>
                      <time dateTime={status.lastRunAt} title={formatDateTime(status.lastRunAt)}>
                        {formatRelative(status.lastRunAt, now)}
                      </time>
                      {status.lastTrigger && (
                        <Badge className="bg-muted text-muted-foreground">
                          {status.lastTrigger === "scheduled" ? "Scheduled" : "Manual"}
                        </Badge>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Never</span>
                  )}
                </Row>
                <Row label="Next scheduled cleanup">
                  {status.running ? (
                    <Badge className="bg-primary/10 text-primary">
                      <Loader2Icon className="animate-spin" />
                      Cleaning up…
                    </Badge>
                  ) : status.nextRunAt ? (
                    <time dateTime={status.nextRunAt} title={formatDateTime(status.nextRunAt)}>
                      {formatRelative(status.nextRunAt, now)}
                    </time>
                  ) : (
                    <span className="text-muted-foreground">Not scheduled</span>
                  )}
                </Row>
              </dl>

              {status.lastResult && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Last result
                    {status.lastResult.freedBytes > 0 && ` · freed ${formatBytes(status.lastResult.freedBytes)}`}
                  </p>
                  {status.lastResult.results.length > 0 ? (
                    <ul className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-xs">
                      {status.lastResult.results.map((step) => (
                        <li key={step.id} className="flex min-w-0 items-start gap-2">
                          {step.ok ? (
                            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-label="Done" />
                          ) : (
                            <TriangleAlertIcon
                              className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                              aria-label="Problem"
                            />
                          )}
                          <span className="min-w-0 flex-1 text-pretty break-words">
                            {/* Server messages read "<label>: <outcome>"; show the label once, in bold. */}
                            <span className="font-medium">{labels.get(step.id) ?? step.id}</span>
                            <span className="text-muted-foreground">
                              {" — "}
                              {step.message.replace(`${labels.get(step.id) ?? step.id}: `, "")}
                            </span>
                          </span>
                          {step.freedBytes ? (
                            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                              {formatBytes(step.freedBytes)}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">Nothing needed cleaning.</p>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void runNow()}
                  disabled={busy || noTargets}
                  className={cn(FIELD, "pressable w-full gap-2 sm:w-auto")}
                >
                  {busy ? <Loader2Icon className="animate-spin" /> : <BrushCleaningIcon />}
                  {busy ? "Cleaning up…" : "Clean up now"}
                </Button>
                <p className="text-xs text-pretty text-muted-foreground">
                  {noTargets ? "Pick at least one target to clean." : "Runs the targets checked above, saved or not."}
                </p>
              </div>
            </SettingsGroup>

            <SettingsSaveBar
              dirty={dirty}
              saving={saving}
              disabled={!dirty || invalid}
              onDiscard={() => applyStatus(status, true)}
            />
          </SettingsPanel>
        </form>
      )}
    </SettingsSection>
  );
}
