"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import type { ArtifactPeriod } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "@/components/home/shared";

export const PERIOD_PRESETS = ["7d", "30d", "90d", "all", "custom"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export const DEFAULT_PERIOD: PeriodPreset = "30d";

/** The period as kept in the URL: a preset, plus local calendar dates (`YYYY-MM-DD`, inclusive) for `custom`. */
export interface PeriodSelection {
  preset: PeriodPreset;
  from: string;
  to: string;
}

const PRESET_DAYS: Partial<Record<PeriodPreset, number>> = { "7d": 7, "30d": 30, "90d": 90 };

const PRESET_LABEL: Record<PeriodPreset, { short: string; long: string }> = {
  "7d": { short: "7d", long: "Last 7 days" },
  "30d": { short: "30d", long: "Last 30 days" },
  "90d": { short: "90d", long: "Last 90 days" },
  all: { short: "All time", long: "All time" },
  custom: { short: "Custom", long: "Custom range" },
};

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dateParam(value: string | null): string {
  return value && DATE_VALUE.test(value) ? value : "";
}

export function parsePeriod(params: { get(name: string): string | null }): PeriodSelection {
  const raw = params.get("period");
  const preset = PERIOD_PRESETS.find((p) => p === raw) ?? DEFAULT_PERIOD;
  if (preset !== "custom") return { preset, from: "", to: "" };
  return { preset, from: dateParam(params.get("from")), to: dateParam(params.get("to")) };
}

/** URL params for a period (the default preset is implied). */
export function periodParams(selection: PeriodSelection, params: URLSearchParams): void {
  if (selection.preset !== DEFAULT_PERIOD) params.set("period", selection.preset);
  if (selection.preset !== "custom") return;
  if (selection.from) params.set("from", selection.from);
  if (selection.to) params.set("to", selection.to);
}

/** Local midnight of a `YYYY-MM-DD` date, `offsetDays` later. */
function localMidnight(value: string, offsetDays = 0): Date | null {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day + offsetDays);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `<input type="date">` value of a local date. */
function dateValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The API range: presets roll back from `now`; a custom end date is inclusive, so it ends at the next local midnight. */
export function periodRange(selection: PeriodSelection, now: number = Date.now()): ArtifactPeriod {
  const days = PRESET_DAYS[selection.preset];
  if (days !== undefined) return { from: new Date(now - days * DAY_MS).toISOString() };
  if (selection.preset !== "custom") return {};
  const from = selection.from ? localMidnight(selection.from) : null;
  const to = selection.to ? localMidnight(selection.to, 1) : null;
  return { from: from?.toISOString(), to: to?.toISOString() };
}

/** "in the last 30 days", "in this date range", … for empty states. */
export function describePeriod(selection: PeriodSelection): string {
  if (selection.preset === "all") return "yet";
  if (selection.preset === "custom") return "in this date range";
  return `in the ${PRESET_LABEL[selection.preset].long.toLowerCase()}`;
}

export function PeriodFilter({
  value,
  onChange,
}: {
  value: PeriodSelection;
  onChange: (next: PeriodSelection) => void;
}) {
  const id = useId();
  const inverted = Boolean(value.from && value.to && value.from > value.to);

  const select = (preset: PeriodPreset) => {
    if (preset === value.preset) return;
    if (preset !== "custom") return onChange({ preset, from: "", to: "" });
    // Start the custom range where the current preset was, so switching does not jump the results.
    const days = PRESET_DAYS[value.preset];
    const today = new Date();
    onChange({
      preset,
      from: days !== undefined ? dateValue(new Date(today.getTime() - days * DAY_MS)) : "",
      to: days !== undefined ? dateValue(today) : "",
    });
  };

  return (
    <div className="flex flex-col gap-3 sm:items-end">
      <div
        role="group"
        aria-label="Period"
        className="scroll-row inline-flex max-w-full items-center gap-0.5 self-start rounded-lg border bg-muted/40 p-0.5 sm:self-auto"
      >
        {PERIOD_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={value.preset === preset}
            aria-label={PRESET_LABEL[preset].long}
            title={PRESET_LABEL[preset].long}
            onClick={() => select(preset)}
            className={cn(
              FOCUS_RING,
              "pressable h-11 shrink-0 rounded-md px-3 text-xs font-medium whitespace-nowrap text-muted-foreground hover:text-foreground md:h-8",
              "aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs",
            )}
          >
            {PRESET_LABEL[preset].short}
          </button>
        ))}
      </div>
      {value.preset === "custom" && (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-from`} className="text-xs font-medium text-muted-foreground">
                From
              </label>
              <Input
                id={`${id}-from`}
                type="date"
                value={value.from}
                max={value.to || undefined}
                onChange={(event) => onChange({ ...value, from: dateParam(event.target.value) })}
                aria-invalid={inverted}
                aria-describedby={inverted ? `${id}-error` : `${id}-help`}
                className="h-11 md:h-8"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-to`} className="text-xs font-medium text-muted-foreground">
                To
              </label>
              <Input
                id={`${id}-to`}
                type="date"
                value={value.to}
                min={value.from || undefined}
                onChange={(event) => onChange({ ...value, to: dateParam(event.target.value) })}
                aria-invalid={inverted}
                aria-describedby={inverted ? `${id}-error` : `${id}-help`}
                className="h-11 md:h-8"
              />
            </div>
          </div>
          {inverted ? (
            <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
              The start date is after the end date.
            </p>
          ) : (
            <p id={`${id}-help`} className="text-xs text-muted-foreground">
              Both days included; leave one empty for an open range.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
