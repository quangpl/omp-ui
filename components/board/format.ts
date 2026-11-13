"use client";

import { useEffect, useState } from "react";

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

let relativeFormatter: Intl.RelativeTimeFormat | null = null;

/** "just now", "5 minutes ago", "yesterday"… using the browser locale. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const diffSeconds = (time - now) / 1000;
  const abs = Math.abs(diffSeconds);
  if (abs < 45) return "just now";
  relativeFormatter ??= new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (abs >= seconds) return relativeFormatter.format(Math.round(diffSeconds / seconds), unit);
  }
  return relativeFormatter.format(Math.round(diffSeconds / 60) || -1, "minute");
}

/** Full local date/time, for `title` tooltips. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/** Compact duration: "<1s", "42s", "3m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Rough remaining time, to the minute: "<1m", "12m", "1h 05m". */
export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "<1m";
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/** Current timestamp that re-renders the caller every `intervalMs`. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong";
}
