// Cron expressions for schedulers (lib/scheduler.ts, components/schedulers/**). Pure and
// isomorphic (no Node imports): parsing, validation, the next fire times in an IANA time zone
// (through `Intl.DateTimeFormat` only), and a short English description.
//
// Syntax: five whitespace-separated fields — minute (0-59), hour (0-23), day-of-month (1-31),
// month (1-12 or JAN-DEC), day-of-week (0-7 or SUN-SAT; 0 and 7 are Sunday). Each field is a
// comma list of `*`, `n`, `a-b`, `*/n`, `a-b/n` or `a/n` (`a` through the field's maximum);
// names are case-insensitive. Macros: @yearly @annually @monthly @weekly @daily @midnight @hourly.
// As in Vixie cron, when both day fields are restricted (don't start with `*`) a day matches if
// EITHER matches; otherwise both must.
//
// Time zones: matching is on the zone's wall clock. A wall-clock time skipped by a spring-forward
// transition doesn't fire that day; one repeated by a fall-back transition fires once, at its first
// occurrence.

/** A malformed cron expression; the message names the offending field. */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

/** A parsed cron expression: the matching values of each field, ascending. */
export interface ParsedCron {
  /** The normalized five-field expression (macros expanded, single spaces). */
  source: string;
  minute: readonly number[];
  hour: readonly number[];
  dayOfMonth: readonly number[];
  month: readonly number[];
  /** 0 (Sunday) – 6 (Saturday); 7 is folded into 0. */
  dayOfWeek: readonly number[];
  /** The day-of-month field doesn't start with `*` (Vixie OR rule). */
  dayOfMonthRestricted: boolean;
  /** The day-of-week field doesn't start with `*` (Vixie OR rule). */
  dayOfWeekRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  /** Index of `names[0]`. */
  namesFrom?: number;
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, namesFrom: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES, namesFrom: 0 },
];

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** One value of a field: a decimal number or (for month / day-of-week) a name. */
function fieldValue(token: string, spec: FieldSpec): number {
  let value: number;
  if (/^\d+$/.test(token)) {
    value = Number(token);
  } else {
    const index = spec.names?.indexOf(token.toUpperCase()) ?? -1;
    if (index < 0) throw new CronError(`${spec.name}: "${token}" is not a valid value`);
    value = index + (spec.namesFrom ?? 0);
  }
  if (value < spec.min || value > spec.max) {
    throw new CronError(`${spec.name}: ${value} is out of range ${spec.min}-${spec.max}`);
  }
  return value;
}

/** The matching values of one field, ascending. */
function parseField(field: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (!part) throw new CronError(`${spec.name}: empty list item in "${field}"`);
    const pieces = part.split("/");
    if (pieces.length > 2) throw new CronError(`${spec.name}: "${part}" has more than one step`);
    const [base, stepText] = pieces;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new CronError(`${spec.name}: step "${stepText}" must be a whole number of at least 1`);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (base.includes("-")) {
      const bounds = base.split("-");
      if (bounds.length !== 2 || !bounds[0] || !bounds[1]) {
        throw new CronError(`${spec.name}: "${base}" is not a valid range`);
      }
      lo = fieldValue(bounds[0], spec);
      hi = fieldValue(bounds[1], spec);
      if (lo > hi) throw new CronError(`${spec.name}: range ${bounds[0]}-${bounds[1]} runs backwards`);
    } else {
      lo = fieldValue(base, spec);
      hi = stepText === undefined ? lo : spec.max;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a cron expression; throws `CronError` (naming the field) when it is malformed. */
export function parseCron(expr: string): ParsedCron {
  const trimmed = expr.trim();
  if (!trimmed) throw new CronError("The cron expression is empty");
  let source = trimmed.replace(/\s+/g, " ");
  if (source.startsWith("@")) {
    const expanded = MACROS[source.toLowerCase()];
    if (!expanded) throw new CronError(`Unknown cron macro "${source}"`);
    source = expanded;
  }
  const fields = source.split(" ");
  if (fields.length !== 5) {
    throw new CronError(
      `Expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, i) => parseField(field, FIELDS[i]));
  const weekdays = [...new Set(dayOfWeek.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    source,
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek: weekdays,
    dayOfMonthRestricted: !fields[2].startsWith("*"),
    dayOfWeekRestricted: !fields[4].startsWith("*"),
  };
}

/** Why `expr` is not a valid cron expression, or null when it is. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    if (err instanceof CronError) return err.message;
    throw err;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached wall-clock formatter for `timeZone`; throws a RangeError for an unknown zone. */
function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** Whether `timeZone` is an IANA time zone the engine knows ("UTC", "Europe/Berlin"…). */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || !timeZone.trim()) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The wall clock of `timeZone` at instant `ms`, encoded as the UTC timestamp with the same
 * calendar parts (a "wall timestamp"), so wall-clock arithmetic is plain UTC arithmetic.
 */
function wallTime(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second);
}

/**
 * The first instant whose wall clock in `timeZone` is the whole-minute wall timestamp `wall`, or
 * null when a spring-forward transition skips it. Offsets lie within ±14 h, so the offsets in
 * effect 14 h either side cover every candidate.
 */
function firstInstant(wall: number, timeZone: string): number | null {
  const before = wall - 14 * HOUR_MS;
  const after = wall + 14 * HOUR_MS;
  const candidates = [
    wall - (wallTime(before, timeZone) - before),
    wall - (wallTime(after, timeZone) - after),
  ].sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (wallTime(candidate, timeZone) === wall) return candidate;
  }
  return null;
}

/** The smallest value in ascending `values` that is ≥ `from`, or null. */
function nextIn(values: readonly number[], from: number): number | null {
  for (const v of values) if (v >= from) return v;
  return null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayMatches(cron: ParsedCron, year: number, month: number, day: number): boolean {
  const dom = cron.dayOfMonth.includes(day);
  const dow = cron.dayOfWeek.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  return cron.dayOfMonthRestricted && cron.dayOfWeekRestricted ? dom || dow : dom && dow;
}

/**
 * The first wall timestamp ≥ `from` (whole minute) matching `cron`, or null past `limit`. Skips a
 * whole month, day or hour as soon as that field fails instead of scanning minutes.
 */
function nextWallMatch(cron: ParsedCron, from: number, limit: number): number | null {
  const start = new Date(from);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  let day = start.getUTCDate();
  let hour = start.getUTCHours();
  let minute = start.getUTCMinutes();
  const nextDay = () => {
    day += 1;
    hour = 0;
    minute = 0;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  };
  for (;;) {
    if (Date.UTC(year, month - 1, day, hour, minute) > limit) return null;
    const m = nextIn(cron.month, month);
    if (m !== month) {
      if (m === null) {
        year += 1;
        month = cron.month[0];
      } else {
        month = m;
      }
      day = 1;
      hour = 0;
      minute = 0;
      continue;
    }
    if (!dayMatches(cron, year, month, day)) {
      nextDay();
      continue;
    }
    const h = nextIn(cron.hour, hour);
    if (h === null) {
      nextDay();
      continue;
    }
    if (h !== hour) {
      hour = h;
      minute = 0;
    }
    const mi = nextIn(cron.minute, minute);
    if (mi === null) {
      hour += 1;
      minute = 0;
      if (hour > 23) nextDay();
      continue;
    }
    return Date.UTC(year, month - 1, day, hour, mi);
  }
}

/**
 * The first minute strictly after `after` that matches `expr` on the wall clock of `timeZone`, or
 * null when none falls within 5 years. Throws `CronError` for a malformed expression and a
 * RangeError for an unknown time zone.
 */
export function nextCronTime(expr: string | ParsedCron, after: Date, timeZone: string): Date | null {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  const afterMs = after.getTime();
  if (Number.isNaN(afterMs)) throw new RangeError("Invalid date");
  const end = new Date(afterMs);
  end.setUTCFullYear(end.getUTCFullYear() + 5);
  const limit = end.getTime();
  // A day of slack so offsets can't cut the wall-clock search short; `limit` decides.
  const wallLimit = wallTime(limit, timeZone) + DAY_MS;
  let from = Math.floor(wallTime(afterMs, timeZone) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (;;) {
    const wall = nextWallMatch(cron, from, wallLimit);
    if (wall === null) return null;
    const instant = firstInstant(wall, timeZone);
    // Skipped by spring-forward, or (after a fall-back) its first occurrence is already past.
    if (instant !== null && instant > afterMs) return instant > limit ? null : new Date(instant);
    from = wall + MINUTE_MS;
  }
}

/** Up to `count` successive fire times of `expr` after `after` (fewer when the schedule ends). */
export function nextCronTimes(expr: string | ParsedCron, after: Date, timeZone: string, count: number): Date[] {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  const times: Date[] = [];
  let cursor = after;
  while (times.length < count) {
    const next = nextCronTime(cron, cursor, timeZone);
    if (!next) break;
    times.push(next);
    cursor = next;
  }
  return times;
}

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** "a", "a and b", "a, b and c". */
function listText(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Monday through Friday" for a run of 3+ consecutive days, else "on Monday and Wednesday". */
function weekdaysText(days: readonly number[]): string {
  const consecutive = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  if (days.length >= 3 && consecutive) {
    return `${WEEKDAY_LABELS[days[0]]} through ${WEEKDAY_LABELS[days[days.length - 1]]}`;
  }
  return `on ${listText(days.map((d) => WEEKDAY_LABELS[d]))}`;
}

/** Readable English for common shapes ("At 09:00, Monday through Friday"), else "Cron: <expr>". */
export function describeCron(expr: string): string {
  let cron: ParsedCron;
  try {
    cron = parseCron(expr);
  } catch (err) {
    if (err instanceof CronError) return "Invalid cron expression";
    throw err;
  }
  const [minute, hour, dom, month, dow] = cron.source.split(" ");
  const isInt = (field: string) => /^\d+$/.test(field);
  const fallback = `Cron: ${expr.trim().replace(/\s+/g, " ")}`;
  const anyDay = dom === "*" && month === "*" && dow === "*";

  if (anyDay && hour === "*") {
    if (minute === "*") return "Every minute";
    const step = /^\*\/(\d+)$/.exec(minute);
    if (step) return Number(step[1]) === 1 ? "Every minute" : `Every ${Number(step[1])} minutes`;
    if (isInt(minute)) return `Every hour at :${pad(Number(minute))}`;
    return fallback;
  }
  if (anyDay && isInt(minute)) {
    const step = /^\*\/(\d+)$/.exec(hour);
    if (step && Number(step[1]) > 1) return `Every ${Number(step[1])} hours at :${pad(Number(minute))}`;
  }
  if (!isInt(minute) || !isInt(hour)) return fallback;
  const at = `${pad(Number(hour))}:${pad(Number(minute))}`;

  if (anyDay) return `Every day at ${at}`;
  if (dom === "*" && month === "*") {
    return cron.dayOfWeek.length === 7 ? `Every day at ${at}` : `At ${at}, ${weekdaysText(cron.dayOfWeek)}`;
  }
  if (isInt(dom) && dow === "*") {
    if (month === "*") return `At ${at} on day ${Number(dom)} of every month`;
    if (cron.month.length === 1) return `At ${at} on ${MONTH_LABELS[cron.month[0] - 1]} ${Number(dom)}`;
  }
  return fallback;
}

/** Common schedules offered by the scheduler form. */
export const CRON_PRESETS: readonly { id: string; label: string; cron: string }[] = [
  { id: "hourly", label: "Every hour", cron: "0 * * * *" },
  { id: "daily", label: "Every day at 09:00", cron: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "Every Monday at 09:00", cron: "0 9 * * 1" },
  { id: "monthly", label: "Monthly on the 1st at 09:00", cron: "0 9 1 * *" },
];
