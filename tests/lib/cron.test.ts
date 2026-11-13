import { describe, expect, it } from "vitest";
import {
  CRON_PRESETS,
  CronError,
  cronError,
  describeCron,
  isValidTimeZone,
  nextCronTime,
  nextCronTimes,
  parseCron,
} from "@/lib/cron";

const utc = (iso: string) => new Date(iso);
const next = (expr: string, after: string, timeZone = "UTC") => nextCronTime(expr, utc(after), timeZone)?.toISOString() ?? null;

describe("parseCron", () => {
  it("parses numbers, ranges, steps and lists", () => {
    const cron = parseCron("*/20 9-17/4 1,15 * 1-5");
    expect(cron.minute).toEqual([0, 20, 40]);
    expect(cron.hour).toEqual([9, 13, 17]);
    expect(cron.dayOfMonth).toEqual([1, 15]);
    expect(cron.month).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(cron.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(cron.dayOfMonthRestricted).toBe(true);
    expect(cron.dayOfWeekRestricted).toBe(true);
  });

  it("supports a/n as a through the field maximum", () => {
    expect(parseCron("5/20 * * * *").minute).toEqual([5, 25, 45]);
    expect(parseCron("10-30/10 * * * *").minute).toEqual([10, 20, 30]);
  });

  it("accepts case-insensitive month and weekday names", () => {
    const cron = parseCron("0 0 * jan,Mar,DEC mon-FRI");
    expect(cron.month).toEqual([1, 3, 12]);
    expect(cron.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 0 * * SUN").dayOfWeek).toEqual([0]);
  });

  it("treats 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7").dayOfWeek).toEqual([0]);
    expect(parseCron("0 0 * * 5-7").dayOfWeek).toEqual([0, 5, 6]);
  });

  it("expands macros", () => {
    expect(parseCron("@yearly").source).toBe("0 0 1 1 *");
    expect(parseCron("@annually").source).toBe("0 0 1 1 *");
    expect(parseCron("@monthly").source).toBe("0 0 1 * *");
    expect(parseCron("@weekly").source).toBe("0 0 * * 0");
    expect(parseCron("@daily").source).toBe("0 0 * * *");
    expect(parseCron("@MIDNIGHT").source).toBe("0 0 * * *");
    expect(parseCron("@hourly").source).toBe("0 * * * *");
  });

  it("tolerates extra whitespace", () => {
    expect(parseCron("  0\t9  *   * 1-5 ").source).toBe("0 9 * * 1-5");
  });

  it("marks day fields starting with * as unrestricted", () => {
    const cron = parseCron("0 0 */2 * *");
    expect(cron.dayOfMonthRestricted).toBe(false);
    expect(cron.dayOfWeekRestricted).toBe(false);
  });

  it("rejects malformed expressions with CronError naming the field", () => {
    expect(() => parseCron("61 * * * *")).toThrow(CronError);
    expect(cronError("61 * * * *")).toBe("minute: 61 is out of range 0-59");
    expect(cronError("0 24 * * *")).toBe("hour: 24 is out of range 0-23");
    expect(cronError("0 0 0 * *")).toBe("day-of-month: 0 is out of range 1-31");
    expect(cronError("0 0 * 13 *")).toBe("month: 13 is out of range 1-12");
    expect(cronError("0 0 * * 8")).toBe("day-of-week: 8 is out of range 0-7");
    expect(cronError("0 0 * * * *")).toMatch(/Expected 5 fields.*got 6/);
    expect(cronError("0 0 * *")).toMatch(/got 4/);
    expect(cronError("")).not.toBeNull();
    expect(cronError("@reboot")).toMatch(/macro/);
    expect(cronError("*/0 * * * *")).toMatch(/^minute: step/);
    expect(cronError("5-1 * * * *")).toMatch(/^minute: range/);
    expect(cronError("0 0 * * MON-")).toMatch(/^day-of-week:/);
    expect(cronError("0 0 L * *")).toMatch(/^day-of-month:/);
    expect(cronError("0 0 * FOO *")).toMatch(/^month:/);
    expect(cronError("1,,2 * * * *")).toMatch(/^minute:/);
  });

  it("returns null from cronError for valid expressions", () => {
    expect(cronError("0 9 * * 1-5")).toBeNull();
    expect(cronError("@daily")).toBeNull();
  });
});

describe("nextCronTime in UTC", () => {
  it("fires every 15 minutes, strictly after the given instant", () => {
    expect(next("*/15 * * * *", "2026-01-01T10:07:30.500Z")).toBe("2026-01-01T10:15:00.000Z");
    expect(next("*/15 * * * *", "2026-01-01T10:15:00.000Z")).toBe("2026-01-01T10:30:00.000Z");
    expect(next("*/15 * * * *", "2026-01-01T23:50:00.000Z")).toBe("2026-01-02T00:00:00.000Z");
  });

  it("returns whole minutes", () => {
    const date = nextCronTime("* * * * *", utc("2026-01-01T10:07:42.123Z"), "UTC")!;
    expect(date.toISOString()).toBe("2026-01-01T10:08:00.000Z");
    expect(date.getUTCSeconds()).toBe(0);
    expect(date.getUTCMilliseconds()).toBe(0);
  });

  it("skips the weekend for weekdays at 09:00", () => {
    // 2026-11-13 is a Friday.
    expect(next("0 9 * * 1-5", "2026-11-13T09:00:00Z")).toBe("2026-11-16T09:00:00.000Z");
    expect(next("0 9 * * MON-FRI", "2026-11-13T08:59:59Z")).toBe("2026-11-13T09:00:00.000Z");
  });

  it("skips months without a 31st", () => {
    expect(next("0 0 31 * *", "2026-01-31T00:00:00Z")).toBe("2026-03-31T00:00:00.000Z");
    expect(next("0 0 31 * *", "2026-03-31T00:00:00Z")).toBe("2026-05-31T00:00:00.000Z");
  });

  it("matches either day field when both are restricted (Vixie OR rule)", () => {
    // 2026-10-31 is a Saturday; Nov 1 is the 1st (a Sunday), Nov 2 a Monday.
    expect(next("0 0 1 * 1", "2026-10-31T00:00:00Z")).toBe("2026-11-01T00:00:00.000Z");
    expect(next("0 0 1 * 1", "2026-11-01T00:00:00Z")).toBe("2026-11-02T00:00:00.000Z");
    // Unrestricted day-of-month: only Mondays.
    expect(next("0 0 * * 1", "2026-10-31T00:00:00Z")).toBe("2026-11-02T00:00:00.000Z");
    // Starting with * counts as unrestricted, so both must match: odd days that are Mondays.
    expect(next("0 0 */2 * 1", "2026-10-31T00:00:00Z")).toBe("2026-11-09T00:00:00.000Z");
  });

  it("finds Feb 29 in the next leap year", () => {
    expect(next("0 12 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T12:00:00.000Z");
  });

  it("returns null for a date that never exists", () => {
    expect(next("0 0 30 2 *", "2026-01-01T00:00:00Z")).toBeNull();
    expect(next("0 0 31 4,6,9,11 *", "2026-01-01T00:00:00Z")).toBeNull();
  });

  it("accepts a parsed expression", () => {
    expect(nextCronTime(parseCron("@hourly"), utc("2026-01-01T10:00:00Z"), "UTC")?.toISOString()).toBe(
      "2026-01-01T11:00:00.000Z",
    );
  });

  it("throws CronError for a malformed expression", () => {
    expect(() => nextCronTime("61 * * * *", utc("2026-01-01T00:00:00Z"), "UTC")).toThrow(CronError);
  });
});

describe("nextCronTime in time zones", () => {
  it("follows New York's offset across the year", () => {
    expect(next("0 9 * * *", "2026-07-01T00:00:00Z", "America/New_York")).toBe("2026-07-01T13:00:00.000Z");
    expect(next("0 9 * * *", "2026-01-15T00:00:00Z", "America/New_York")).toBe("2026-01-15T14:00:00.000Z");
  });

  it("handles half-hour offsets", () => {
    expect(next("0 9 * * *", "2026-01-15T00:00:00Z", "Asia/Kolkata")).toBe("2026-01-15T03:30:00.000Z");
    expect(next("0 9 * * *", "2026-01-15T03:30:00Z", "Asia/Kolkata")).toBe("2026-01-16T03:30:00.000Z");
  });

  it("uses the zone's calendar day for weekdays", () => {
    // Friday 2026-11-13 23:30 in New York is already Saturday in UTC.
    expect(next("30 23 * * 5", "2026-11-13T12:00:00Z", "America/New_York")).toBe("2026-11-14T04:30:00.000Z");
  });

  it("skips wall-clock times removed by spring-forward", () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT, so 02:30 doesn't exist that day.
    expect(next("30 2 * * *", "2026-03-07T08:00:00Z", "America/New_York")).toBe("2026-03-09T06:30:00.000Z");
    expect(next("0 3 * * *", "2026-03-08T05:00:00Z", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
  });

  it("fires a repeated fall-back time once, at its first occurrence", () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST, so 01:30 happens twice.
    expect(next("30 1 * * *", "2026-11-01T04:00:00Z", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
    expect(next("30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-02T06:30:00.000Z");
    // Starting inside the repeated hour (01:10 EST) doesn't fire the second 01:30.
    expect(next("30 1 * * *", "2026-11-01T06:10:00Z", "America/New_York")).toBe("2026-11-02T06:30:00.000Z");
    const times = nextCronTimes("30 1 * * *", utc("2026-11-01T00:00:00Z"), "America/New_York", 2);
    expect(times.map((d) => d.toISOString())).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  });

  it("throws for an unknown time zone", () => {
    expect(() => nextCronTime("0 9 * * *", utc("2026-01-01T00:00:00Z"), "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("nextCronTimes", () => {
  it("returns successive fire times", () => {
    const times = nextCronTimes("0 * * * *", utc("2026-01-01T10:30:00Z"), "UTC", 3);
    expect(times.map((d) => d.toISOString())).toEqual([
      "2026-01-01T11:00:00.000Z",
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T13:00:00.000Z",
    ]);
  });

  it("returns fewer when the schedule never matches, and none for count 0", () => {
    expect(nextCronTimes("0 0 30 2 *", utc("2026-01-01T00:00:00Z"), "UTC", 3)).toEqual([]);
    expect(nextCronTimes("* * * * *", utc("2026-01-01T00:00:00Z"), "UTC", 0)).toEqual([]);
  });
});

describe("describeCron", () => {
  it.each([
    ["* * * * *", "Every minute"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["5 * * * *", "Every hour at :05"],
    ["0 */2 * * *", "Every 2 hours at :00"],
    ["30 9 * * *", "Every day at 09:30"],
    ["0 9 * * 1-5", "At 09:00, Monday through Friday"],
    ["0 9 * * MON-FRI", "At 09:00, Monday through Friday"],
    ["0 9 * * 1", "At 09:00, on Monday"],
    ["0 18 * * 1,3,5", "At 18:00, on Monday, Wednesday and Friday"],
    ["0 9 1 * *", "At 09:00 on day 1 of every month"],
    ["0 9 25 12 *", "At 09:00 on December 25"],
    ["@hourly", "Every hour at :00"],
    ["@daily", "Every day at 00:00"],
    ["@weekly", "At 00:00, on Sunday"],
    ["@monthly", "At 00:00 on day 1 of every month"],
    ["@yearly", "At 00:00 on January 1"],
    ["*/5 9-17 * * 1-5", "Cron: */5 9-17 * * 1-5"],
    ["61 * * * *", "Invalid cron expression"],
  ])("%s → %s", (expr, text) => {
    expect(describeCron(expr)).toBe(text);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones and rejects unknown or empty ones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("CRON_PRESETS", () => {
  it("are valid expressions", () => {
    expect(CRON_PRESETS.map((p) => p.cron)).toEqual(["0 * * * *", "0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 9 1 * *"]);
    for (const preset of CRON_PRESETS) expect(cronError(preset.cron)).toBeNull();
  });
});
