"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { CalendarClock, TriangleAlert } from "lucide-react";
import { formatRelative, useNow } from "@/components/board/format";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cronError, describeCron, isValidTimeZone, nextCronTime, nextCronTimes } from "@/lib/cron";
import { cn } from "@/lib/utils";

/** Schedule part of a scheduler's config, as edited by `ScheduleFields`. */
export interface ScheduleValue {
  cron: string;
  timezone: string;
  enabled: boolean;
  /** Stop after this many runs; null = never. */
  maxRuns: number | null;
}

/** The browser's IANA zone, else UTC (old engines, or no `Intl` time zone data). */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Weekdays at 09:00 in the browser's zone, enabled, repeating forever. */
export function defaultScheduleValue(): ScheduleValue {
  return { cron: "0 9 * * 1-5", timezone: browserTimeZone(), enabled: true, maxRuns: null };
}

/** Why `value` can't be saved, or null when it can. */
export function scheduleError(value: ScheduleValue): string | null {
  const cron = cronError(value.cron);
  if (cron) return cron;
  const timezone = value.timezone.trim();
  if (!timezone) return "Pick a time zone";
  if (!isValidTimeZone(timezone)) return `Unknown time zone "${timezone}"`;
  if (value.maxRuns !== null && (!Number.isInteger(value.maxRuns) || value.maxRuns < 1)) {
    return "The run count must be a whole number of at least 1";
  }
  if (nextCronTime(value.cron, new Date(), timezone) === null) return "This schedule never matches a date";
  return null;
}

type RepeatMode = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

const REPEAT_LABELS: Record<RepeatMode, string> = {
  hourly: "Hourly",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom (cron)",
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** The editable parts of a preset-shaped cron expression. */
interface PresetParts {
  minute: number;
  hour: number;
  /** 0 (Sunday) – 6 (Saturday), for weekly. */
  weekday: number;
  /** 1–31, for monthly. */
  monthDay: number;
}

const DEFAULT_PARTS: PresetParts = { minute: 0, hour: 9, weekday: 1, monthDay: 1 };

/** Plain decimal integer in [min, max], else null (ranges, steps, lists and names don't count). */
function intField(field: string | undefined, min: number, max: number): number | null {
  if (field === undefined || !/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

/**
 * The preset `cron` is shaped like, with its parts; "custom" for anything else (steps, lists,
 * macros, month restrictions…), which the raw cron field edits instead.
 */
function detectPreset(cron: string): { mode: RepeatMode; parts: PresetParts } {
  const custom = { mode: "custom" as const, parts: DEFAULT_PARTS };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return custom;
  const [min, hour, dom, month, dow] = fields;
  const minute = intField(min, 0, 59);
  if (minute === null || month !== "*") return custom;
  if (hour === "*") {
    return dom === "*" && dow === "*" ? { mode: "hourly", parts: { ...DEFAULT_PARTS, minute } } : custom;
  }
  const h = intField(hour, 0, 23);
  if (h === null) return custom;
  const parts = { ...DEFAULT_PARTS, minute, hour: h };
  if (dom === "*") {
    if (dow === "*") return { mode: "daily", parts };
    if (dow === "1-5") return { mode: "weekdays", parts };
    const weekday = intField(dow, 0, 6);
    return weekday === null ? custom : { mode: "weekly", parts: { ...parts, weekday } };
  }
  const monthDay = intField(dom, 1, 31);
  return monthDay !== null && dow === "*" ? { mode: "monthly", parts: { ...parts, monthDay } } : custom;
}

/** Cron expression for a preset; `custom` keeps `current`. */
function buildCron(mode: RepeatMode, parts: PresetParts, current: string): string {
  const { minute, hour, weekday, monthDay } = parts;
  switch (mode) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
    case "monthly":
      return `${minute} ${hour} ${monthDay} * *`;
    case "custom":
      return current;
  }
}

let timeZoneList: string[] | null = null;

/** Every IANA zone the engine knows (for the datalist); empty where `Intl.supportedValuesOf` is missing. */
function supportedTimeZones(): string[] {
  if (timeZoneList) return timeZoneList;
  try {
    timeZoneList = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    timeZoneList = [];
  }
  // Some engines omit UTC from the list although they accept it.
  if (!timeZoneList.includes("UTC")) timeZoneList = ["UTC", ...timeZoneList];
  return timeZoneList;
}

const FIELD = "w-full data-[size=default]:h-11 md:data-[size=default]:h-9";
const INPUT = "h-11 md:h-9";

/**
 * `className` for a scheduler's `NewTaskForm` (dialog layout). On phones its action row (the
 * form's last child: Cancel and/or the submit button) becomes a frosted bar pinned to the bottom
 * edge above the home indicator, so the submit stays in reach below the long schedule section.
 */
export const STICKY_FORM_ACTIONS = cn(
  "max-sm:[&>div:last-child]:sticky max-sm:[&>div:last-child]:bottom-0 max-sm:[&>div:last-child]:z-10",
  "max-sm:[&>div:last-child]:-mx-4 max-sm:[&>div:last-child]:flex-row max-sm:[&>div:last-child>button:last-child]:flex-1",
  "max-sm:[&>div:last-child]:border-t max-sm:[&>div:last-child]:bg-background/85 max-sm:[&>div:last-child]:backdrop-blur-lg",
  "max-sm:[&>div:last-child]:glass-edge max-sm:[&>div:last-child]:px-4 max-sm:[&>div:last-child]:pt-3",
  "max-sm:[&>div:last-child]:pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
);

/**
 * Number input that tolerates transient invalid text (empty while retyping): only valid values
 * reach `onCommit`, and leaving the field restores the last committed one.
 */
function NumberField({
  id,
  value,
  min,
  max,
  disabled,
  onCommit,
  className,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft((prev) => (Number(prev) === value && prev.trim() !== "" ? prev : String(value)));
  }, [value]);
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={draft}
      disabled={disabled}
      className={cn(INPUT, className)}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const n = Number(raw);
        if (raw.trim() !== "" && Number.isInteger(n) && n >= min && n <= max) onCommit(n);
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

/**
 * Schedule editor of a scheduler: a "Repeat" preset (hourly / daily / weekdays / weekly / monthly,
 * each with its time fields) or a raw cron expression, the time zone it is evaluated in, when it
 * ends, and whether it is enabled. Below, a live preview: the schedule in words and its next three
 * run times in that zone, or why it is invalid.
 */
export function ScheduleFields({
  value,
  onChange,
  disabled,
}: {
  value: ScheduleValue;
  onChange: (next: ScheduleValue) => void;
  disabled?: boolean;
}) {
  const id = useId();
  // Picking "Custom" keeps the cron as is, so a preset-shaped one must not flip back to its preset.
  const [customPicked, setCustomPicked] = useState(false);
  const detected = useMemo(() => detectPreset(value.cron), [value.cron]);
  const mode: RepeatMode = customPicked ? "custom" : detected.mode;
  const { parts } = detected;

  const set = (patch: Partial<ScheduleValue>) => onChange({ ...value, ...patch });
  const setParts = (patch: Partial<PresetParts>) => set({ cron: buildCron(mode, { ...parts, ...patch }, value.cron) });

  const pickMode = (next: string) => {
    const nextMode = next as RepeatMode;
    if (nextMode === "custom") {
      setCustomPicked(true);
      return;
    }
    setCustomPicked(false);
    set({ cron: buildCron(nextMode, parts, value.cron) });
  };

  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  const timeField = (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-time`}>At</Label>
      <Input
        id={`${id}-time`}
        type="time"
        required
        value={time}
        disabled={disabled}
        className={INPUT}
        onChange={(event) => {
          const match = /^(\d{2}):(\d{2})/.exec(event.target.value);
          if (match) setParts({ hour: Number(match[1]), minute: Number(match[2]) });
        }}
      />
    </div>
  );

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4 rounded-xl border bg-card/40 p-4">
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
        Schedule
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-repeat`}>Repeat</Label>
          <Select value={mode} onValueChange={pickMode} disabled={disabled}>
            <SelectTrigger id={`${id}-repeat`} className={FIELD}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(REPEAT_LABELS) as RepeatMode[]).map((option) => (
                <SelectItem key={option} value={option} className="max-md:min-h-11">
                  {REPEAT_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {mode === "hourly" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-minute`}>At minute</Label>
            <NumberField
              id={`${id}-minute`}
              value={parts.minute}
              min={0}
              max={59}
              disabled={disabled}
              onCommit={(minute) => setParts({ minute })}
            />
          </div>
        )}
        {(mode === "daily" || mode === "weekdays") && timeField}
        {mode === "custom" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-cron`}>Cron expression</Label>
            <Input
              id={`${id}-cron`}
              value={value.cron}
              disabled={disabled}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              placeholder="*/15 * * * *"
              aria-describedby={`${id}-cron-hint`}
              className={cn(INPUT, "font-mono")}
              onChange={(event) => set({ cron: event.target.value })}
            />
            <p id={`${id}-cron-hint`} className="text-xs text-muted-foreground">
              minute hour day-of-month month day-of-week, or <code className="font-mono">@daily</code>,{" "}
              <code className="font-mono">@hourly</code>…
            </p>
          </div>
        )}
        {mode === "weekly" && (
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-weekday`}>On</Label>
              <Select
                value={String(parts.weekday)}
                onValueChange={(day) => setParts({ weekday: Number(day) })}
                disabled={disabled}
              >
                <SelectTrigger id={`${id}-weekday`} className={FIELD}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((day, index) => (
                    <SelectItem key={day} value={String(index)} className="max-md:min-h-11">
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {timeField}
          </div>
        )}
        {mode === "monthly" && (
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-monthday`}>On day</Label>
              <Select
                value={String(parts.monthDay)}
                onValueChange={(day) => setParts({ monthDay: Number(day) })}
                disabled={disabled}
              >
                <SelectTrigger id={`${id}-monthday`} className={FIELD}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                    <SelectItem key={day} value={String(day)} className="max-md:min-h-11">
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {timeField}
          </div>
        )}
      </div>
      {mode === "monthly" && parts.monthDay > 28 && (
        <p className="-mt-2 text-xs text-muted-foreground">Months without day {parts.monthDay} are skipped.</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-tz`}>Time zone</Label>
          <Input
            id={`${id}-tz`}
            list={`${id}-tz-list`}
            value={value.timezone}
            disabled={disabled}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            placeholder="Europe/Berlin"
            aria-invalid={value.timezone.trim() !== "" && !isValidTimeZone(value.timezone.trim()) ? true : undefined}
            className={INPUT}
            onChange={(event) => set({ timezone: event.target.value })}
          />
          <TimeZoneOptions id={`${id}-tz-list`} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-ends`}>Ends</Label>
          <div className="flex gap-2">
            <Select
              value={value.maxRuns === null ? "never" : "after"}
              onValueChange={(ends) => set({ maxRuns: ends === "never" ? null : (value.maxRuns ?? 10) })}
              disabled={disabled}
            >
              <SelectTrigger id={`${id}-ends`} className={cn(FIELD, value.maxRuns !== null && "flex-1")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never" className="max-md:min-h-11">
                  Never
                </SelectItem>
                <SelectItem value="after" className="max-md:min-h-11">
                  After a number of runs
                </SelectItem>
              </SelectContent>
            </Select>
            {value.maxRuns !== null && (
              <NumberField
                id={`${id}-max-runs`}
                value={value.maxRuns}
                min={1}
                max={100_000}
                disabled={disabled}
                className="w-24 shrink-0"
                onCommit={(maxRuns) => set({ maxRuns })}
              />
            )}
          </div>
          {value.maxRuns !== null && (
            <p className="text-xs text-muted-foreground">Turns itself off after {value.maxRuns} runs.</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/40 px-3 py-2.5">
        <div className="min-w-0">
          <Label htmlFor={`${id}-enabled`}>Enabled</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {value.enabled ? "Creates cards on schedule." : "Paused: keeps its settings but never runs on its own."}
          </p>
        </div>
        <Switch
          id={`${id}-enabled`}
          checked={value.enabled}
          disabled={disabled}
          className="after:-inset-y-3.5 md:after:-inset-y-2"
          onCheckedChange={(enabled) => set({ enabled })}
        />
      </div>

      <SchedulePreview value={value} />
    </section>
  );
}

/** `<datalist>` of the engine's time zones; built once, on first render in the browser. */
function TimeZoneOptions({ id }: { id: string }) {
  const [zones, setZones] = useState<string[]>([]);
  useEffect(() => setZones(supportedTimeZones()), []);
  return (
    <datalist id={id}>
      {zones.map((zone) => (
        <option key={zone} value={zone} />
      ))}
    </datalist>
  );
}

/** The schedule in words and its next three runs in its zone, or why it is invalid. */
function SchedulePreview({ value }: { value: ScheduleValue }) {
  const now = useNow(60_000);
  const timezone = value.timezone.trim();
  const preview = (() => {
    const error = scheduleError(value);
    if (error) return { error } as const;
    const format = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const runs = nextCronTimes(value.cron, new Date(now), timezone, 3).map((date) => ({
      iso: date.toISOString(),
      label: format.format(date),
    }));
    return { description: describeCron(value.cron), runs } as const;
  })();

  if ("error" in preview) {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        {preview.error}
      </p>
    );
  }
  return (
    <div aria-live="polite" className="flex flex-col gap-1.5 text-sm">
      <p className="font-medium">
        {preview.description} <span className="font-normal text-muted-foreground">({timezone})</span>
      </p>
      <ol className="flex flex-col gap-0.5 text-muted-foreground">
        {preview.runs.map((run, index) => (
          <li key={run.iso} className="flex flex-wrap gap-x-2 tabular-nums">
            <span className="w-12 shrink-0 text-xs leading-5">{index === 0 ? "Next" : "Then"}</span>
            <span className="font-mono text-[0.8125rem] text-foreground">{run.label}</span>
            <span className="text-xs leading-5">{formatRelative(run.iso, now)}</span>
          </li>
        ))}
      </ol>
      {!value.enabled && (
        <p className="text-xs text-muted-foreground">Disabled: these runs only happen once it is enabled again.</p>
      )}
    </div>
  );
}
