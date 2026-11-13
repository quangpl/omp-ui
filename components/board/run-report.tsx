"use client";

import { useState } from "react";
import {
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  CpuIcon,
  FileDiffIcon,
  FlaskConicalIcon,
  ImageOffIcon,
  MessageSquareQuoteIcon,
} from "lucide-react";
import { openAttachment } from "@/components/attachment-viewer";
import { attachmentKind, isPlainClick, KIND_ICON, type Attachment } from "@/components/viewer/common";
import { formatDuration } from "@/components/board/format";
import { extractAttachments, RichText } from "@/components/board/rich-text";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Comment, Run } from "@/lib/types";

export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface RunReportData {
  outcome: "succeeded" | "failed";
  /** The agent's own outcome line (`Outcome: …`), if any. */
  outcomeText: string | null;
  durationMs: number | null;
  model: string | null;
  changes: { files: number | null; additions: number | null; deletions: number | null } | null;
  tests: TestSummary | null;
  screenshots: Attachment[];
  /** Other viewable files referenced by the summary (logs, PDFs, videos…). */
  artifacts: Attachment[];
  /** The comment text without its `## Report` section (shown as the normal bubble). */
  body: string;
}

/** `## Report` (any heading level) and the heading level that ends the section. */
const REPORT_HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+report\b[^\n]*$/im;
const ANY_HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+\S/;
const FIELD = (name: string) =>
  new RegExp(String.raw`^[ \t]*(?:[-*+][ \t]+)?\**(?:${name})\**[ \t]*:\**[ \t]*(.+?)[ \t]*$`, "im");
const OUTCOME_FIELD = FIELD("outcome|result|status");
const MODEL_FIELD = FIELD("model");
const CHANGES_FIELD = FIELD("changes|changed files|diff");
const FAILURE_WORDS = /\b(fail(?:ed|ing|s|ure)?|errors?|blocked|broken|not done|incomplete|aborted)\b/i;
/** `git diff --shortstat`: "3 files changed, 120 insertions(+), 14 deletions(-)". */
const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/i;
const TEST_COUNT = /(\d[\d,]*)\s+(passed|passing|failed|failing|skipped|pending|todo|errors?|broken)\b/gi;
const TEST_WORDS = /\b(tests?|specs?|suites?|vitest|jest|pytest|playwright|mocha|cypress|e2e|unit)\b/i;
/** Prefer a "Tests: …" / "Tests  41 passed (42)" line over "Test Files …" or prose. */
const TESTS_LINE = /^[\W_]*(?:tests?|test results?)\b(?!\s*files)/i;
const ALL_PASS = /\ball\s+(\d[\d,]*)\s+(?:tests?|specs?)\s+pass(?:ed|ing|es)?\b/i;

const num = (value: string) => Number(value.replace(/,/g, ""));

/** Split the `## Report` section off the text. */
function splitReport(text: string): { body: string; report: string | null } {
  const match = REPORT_HEADING.exec(text);
  if (!match || match.index === undefined) return { body: text, report: null };
  const level = match[1].length;
  const start = match.index;
  const afterHeading = start + match[0].length;
  const rest = text.slice(afterHeading);
  let end = text.length;
  let offset = afterHeading;
  let inFence = false;
  for (const line of rest.split("\n")) {
    if (/^[ \t]*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    const heading = inFence ? null : ANY_HEADING.exec(line);
    if (heading && heading[1].length <= level && offset > afterHeading) {
      end = offset;
      break;
    }
    offset += line.length + 1;
  }
  return {
    body: `${text.slice(0, start)}${text.slice(end)}`.trim(),
    report: text.slice(afterHeading, end).trim(),
  };
}

/** Test counts from summaries like vitest, jest, pytest, playwright or "Tests: 42 passed, 0 failed". */
export function parseTests(text: string, trusted = false): TestSummary | null {
  const lines = text.split("\n").filter((line) => {
    TEST_COUNT.lastIndex = 0;
    return TEST_COUNT.test(line) && (trusted || TEST_WORDS.test(line) || /^\s*=+.*=+\s*$/.test(line));
  });
  const line = lines.find((l) => TESTS_LINE.test(l)) ?? lines[0];
  if (line) {
    const summary: TestSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
    for (const [, count, word] of line.matchAll(TEST_COUNT)) {
      const n = num(count);
      if (/^pass/i.test(word)) summary.passed += n;
      else if (/^(fail|error|broken)/i.test(word)) summary.failed += n;
      else summary.skipped += n;
    }
    const total = /(\d[\d,]*)\s+total\b/i.exec(line) ?? /\((\d[\d,]*)\)\s*$/.exec(line.trim());
    summary.total = total ? num(total[1]) : summary.passed + summary.failed + summary.skipped;
    return summary;
  }
  const all = ALL_PASS.exec(text);
  return all ? { passed: num(all[1]), failed: 0, skipped: 0, total: num(all[1]) } : null;
}

function parseChanges(report: string | null, text: string): RunReportData["changes"] {
  const shortstat = SHORTSTAT.exec(text);
  if (shortstat) {
    return {
      files: num(shortstat[1]),
      additions: shortstat[2] ? num(shortstat[2]) : null,
      deletions: shortstat[3] ? num(shortstat[3]) : null,
    };
  }
  const field = report ? CHANGES_FIELD.exec(report)?.[1] : undefined;
  if (!field) return null;
  const files = /(\d+)\s+files?\b/i.exec(field);
  const additions = /\+\s?(\d[\d,]*)/.exec(field);
  const deletions = /(?:^|\s)[-−–]\s?(\d[\d,]*)/.exec(field);
  if (!files && !additions && !deletions) return null;
  return {
    files: files ? num(files[1]) : null,
    additions: additions ? num(additions[1]) : null,
    deletions: deletions ? num(deletions[1]) : null,
  };
}

/** The run whose result this agent comment records (summary or failure text, nearest end time). */
function runOf(comment: Comment, runs: Run[]): Run | null {
  const body = comment.body.trim();
  const created = Date.parse(comment.createdAt);
  let best: Run | null = null;
  let bestGap = Infinity;
  for (const run of runs) {
    if (!run.endedAt) continue;
    const matches =
      run.status === "succeeded"
        ? (run.summary?.trim() || "Done.") === body
        : run.status === "failed" && !!run.error && body.startsWith("Agent failed:") && body.includes(run.error);
    if (!matches) continue;
    const gap = Math.abs(created - Date.parse(run.endedAt));
    if (gap < bestGap) {
      best = run;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Report of a finished run, when `comment` is the agent's result comment (matched to one of
 * `runs`) or carries a `## Report` section. Null for ordinary comments.
 */
export function parseRunReport(comment: Comment, runs: Run[] = []): RunReportData | null {
  if (comment.author !== "agent") return null;
  const run = runOf(comment, runs);
  const { body, report } = splitReport(comment.body);
  if (!run && report === null) return null;

  const outcomeText = report ? (OUTCOME_FIELD.exec(report)?.[1] ?? null) : null;
  const failed =
    run?.status === "failed" ||
    (run === null && comment.body.trim().startsWith("Agent failed:")) ||
    (outcomeText !== null && FAILURE_WORDS.test(outcomeText) && !/\b0 fail/i.test(outcomeText));
  const tests = (report ? parseTests(report, true) : null) ?? parseTests(comment.body);
  const attachments = extractAttachments(comment.body);
  return {
    outcome: failed ? "failed" : "succeeded",
    outcomeText,
    durationMs: run?.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null,
    model: report ? (MODEL_FIELD.exec(report)?.[1]?.replace(/`/g, "") ?? null) : null,
    changes: parseChanges(report, comment.body),
    tests,
    screenshots: attachments.filter((a) => attachmentKind(a) === "image"),
    artifacts: attachments.filter((a) => attachmentKind(a) !== "image"),
    body: report === null ? comment.body : body,
  };
}

/**
 * "Report" card under the agent's result comment: outcome, duration, model, changes, tests and a
 * screenshot gallery. Each screenshot (in the card or the viewer) offers "Feedback", which quotes
 * it in the comment box so the next message reaches the agent in the same thread.
 */
export function RunReport({
  report,
  onFeedback,
}: {
  report: RunReportData;
  onFeedback: (attachment: Attachment) => void;
}) {
  const failed = report.outcome === "failed";
  const { tests, changes } = report;
  const facts: { icon: typeof ClockIcon; label: string; title?: string }[] = [];
  if (report.durationMs !== null) facts.push({ icon: ClockIcon, label: formatDuration(report.durationMs), title: "Run duration" });
  if (report.model) facts.push({ icon: CpuIcon, label: report.model, title: "Model" });
  /** Screenshots then artifacts: ←/→ in the viewer steps through every file of the report. */
  const files = [...report.screenshots, ...report.artifacts];

  return (
    <section
      aria-label="Run report"
      className="mt-2 overflow-hidden rounded-xl border bg-card text-sm animate-fade-in-soft"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-muted/40 px-3 py-2">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Report</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
            failed
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
          )}
        >
          {failed ? <CircleXIcon className="size-3.5" /> : <CircleCheckIcon className="size-3.5" />}
          {failed ? "Failed" : "Succeeded"}
        </span>
        {facts.map(({ icon: Icon, label, title }) => (
          <span key={title} title={title} className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate tabular-nums">{label}</span>
          </span>
        ))}
        {changes && (
          <span title="Changes" className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <FileDiffIcon className="size-3.5 shrink-0" aria-hidden />
            {changes.files !== null && <span>{changes.files} {changes.files === 1 ? "file" : "files"}</span>}
            {changes.additions !== null && <span className="text-emerald-700 dark:text-emerald-400">+{changes.additions}</span>}
            {changes.deletions !== null && <span className="text-red-700 dark:text-red-400">−{changes.deletions}</span>}
          </span>
        )}
      </header>

      <div className="flex flex-col gap-3 px-3 py-2.5">
        {report.outcomeText && <RichText text={report.outcomeText} images="chip" className="text-sm" />}

        {tests && <TestsRow tests={tests} />}

        {report.screenshots.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Screenshots <span className="tabular-nums">({report.screenshots.length})</span>
            </p>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {report.screenshots.map((shot, index) => (
                <Screenshot
                  key={shot.url}
                  shot={shot}
                  index={index}
                  list={files}
                  onFeedback={onFeedback}
                />
              ))}
            </ul>
          </div>
        )}

        {report.artifacts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Files</span>
            {report.artifacts.map((file, index) => {
              const KindIcon = KIND_ICON[attachmentKind(file)];
              return (
                <a
                  key={file.url}
                  href={file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Preview ${file.name}`}
                  onClick={(event) => {
                    if (!isPlainClick(event)) return;
                    event.preventDefault();
                    openAttachment({ ...file, list: files, index: report.screenshots.length + index, onFeedback });
                  }}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs font-medium hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <KindIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{file.name}</span>
                </a>
              );
            })}
          </div>
        )}

        {!tests && report.screenshots.length === 0 && report.artifacts.length === 0 && !report.outcomeText && (
          <p className="text-xs text-muted-foreground">No test results or screenshots for this run.</p>
        )}
      </div>
    </section>
  );
}

function TestsRow({ tests }: { tests: TestSummary }) {
  const total = Math.max(tests.total, tests.passed + tests.failed + tests.skipped, 1);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <FlaskConicalIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">Tests</span>
        <span className="text-emerald-700 tabular-nums dark:text-emerald-400">{tests.passed} passed</span>
        <span className={cn("tabular-nums", tests.failed > 0 ? "font-medium text-destructive" : "text-muted-foreground")}>
          {tests.failed} failed
        </span>
        {tests.skipped > 0 && <span className="text-muted-foreground tabular-nums">{tests.skipped} skipped</span>}
        {tests.total > 0 && <span className="text-muted-foreground tabular-nums">· {tests.total} total</span>}
      </div>
      <div
        className="flex h-1.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${tests.passed} passed, ${tests.failed} failed, ${tests.skipped} skipped`}
      >
        <span className="bg-emerald-500" style={{ width: pct(tests.passed) }} />
        <span className="bg-destructive" style={{ width: pct(tests.failed) }} />
        <span className="bg-muted-foreground/40" style={{ width: pct(tests.skipped) }} />
      </div>
    </div>
  );
}

function Screenshot({
  shot,
  index,
  list,
  onFeedback,
}: {
  shot: Attachment;
  index: number;
  list: Attachment[];
  onFeedback: (attachment: Attachment) => void;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <li className="group/shot flex min-w-0 flex-col overflow-hidden rounded-lg border bg-background">
      <a
        href={shot.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Preview ${shot.name}`}
        onClick={(event) => {
          if (!isPlainClick(event)) return;
          event.preventDefault();
          openAttachment({ ...shot, list, index, onFeedback });
        }}
        className="relative block aspect-video overflow-hidden bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {broken ? (
          <span className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <ImageOffIcon className="size-5" aria-hidden />
            <span className="text-[11px]">Image unavailable</span>
          </span>
        ) : (
          <img
            src={shot.url}
            alt={shot.name}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className="size-full object-cover object-top transition-transform duration-200 group-hover/shot:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover/shot:scale-100"
          />
        )}
      </a>
      <div className="flex min-w-0 items-center gap-1 border-t py-0.5 pr-0.5 pl-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={shot.name}>
          {shot.name}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 shrink-0 px-2 text-xs md:h-7"
          onClick={() => onFeedback(shot)}
          aria-label={`Feedback on ${shot.name}`}
        >
          <MessageSquareQuoteIcon />
          Feedback
        </Button>
      </div>
    </li>
  );
}
