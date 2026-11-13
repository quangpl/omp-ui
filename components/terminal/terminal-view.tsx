"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  CornerDownLeftIcon,
  EraserIcon,
  LoaderCircleIcon,
  SquareIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AnsiSegments, parseRuns, runsToPlain, type OutputRun } from "@/components/terminal/ansi";
import { useCommandHistory, useTerminal, type ConnectionStatus } from "@/components/terminal/use-terminal";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isModalOpen, isTypingTarget } from "@/lib/hotkeys";
import type { TerminalBlock } from "@/lib/terminal-types";
import { cn } from "@/lib/utils";

/** Within this distance of the bottom the log keeps following new output. */
const STICK_THRESHOLD_PX = 32;
const SUGGESTIONS = ["ls -la", "git status", "df -h"];
const NO_RUNS: OutputRun[] = [];

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["Enter"], label: "Run" },
  { keys: ["Shift", "Enter"], label: "New line" },
  { keys: ["↑", "↓"], label: "Command history" },
  { keys: ["Ctrl", "C"], label: "Stop the newest command, or clear the line" },
  { keys: ["Ctrl", "L"], label: "Clear the screen" },
];

/** `path` with the home directory shown as `~`. */
function tildify(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatSkipped(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** True when the user has text selected on the page (Ctrl+C must copy it then, not interrupt). */
function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString());
}

async function copyText(text: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(success);
  } catch {
    toast.error("Couldn't copy", { description: "The browser blocked clipboard access." });
  }
}

/** A block as plain text (prompt, output without escapes, markers), for the copy buttons. */
function blockToText(block: TerminalBlock, runs: readonly OutputRun[], interrupted: boolean): string {
  const lines = [`$ ${block.command}`];
  const output = runsToPlain(runs).replace(/\n$/, "");
  if (output) lines.push(output);
  if (interrupted) lines.push("^C");
  if (block.error) lines.push(block.error);
  return lines.join("\n");
}

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const live = status === "live";
  const label = live ? "Live" : status === "reconnecting" ? "Reconnecting…" : "Connecting…";
  return (
    <span
      role="status"
      title={live ? "Attached to the server session" : label}
      className="inline-flex shrink-0 items-center gap-1.5 font-sans text-[11px] text-muted-foreground"
    >
      <span aria-hidden="true" className="relative flex size-1.5">
        {live && <span className="absolute inset-0 animate-breathe rounded-full bg-success" />}
        <span
          className={cn(
            "relative size-1.5 rounded-full",
            live ? "bg-success" : "animate-pulse bg-amber-500 motion-reduce:animate-none",
          )}
        />
      </span>
      {/* Phones keep just the dot while live; trouble is always spelled out. */}
      <span className={cn(live && "max-sm:sr-only")}>{label}</span>
    </span>
  );
}

/** "N running", else the newest finished block's outcome, else Idle. */
function SessionStatus({ blocks }: { blocks: readonly TerminalBlock[] }) {
  const running = blocks.filter((b) => b.status === "running").length;
  const last = blocks.findLast((b) => b.status === "done");
  let label = "Idle";
  let dot = "bg-muted-foreground/50";
  let text = "text-muted-foreground";
  if (running > 0) {
    label = `${running} running`;
    dot = "bg-primary";
    text = "text-foreground";
  } else if (last?.cancelled) {
    label = "Cancelled";
    dot = "bg-amber-500";
  } else if (last && last.exitCode === 0) {
    label = "Exit 0";
    dot = "bg-success";
    text = "text-success";
  } else if (last) {
    label = last.exitCode !== null ? `Exit ${last.exitCode}` : (last.signal ?? "Failed");
    dot = "bg-destructive";
    text = "text-destructive";
  }
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border bg-background/60 px-2 font-sans text-[11px] font-medium tabular-nums transition-colors duration-200 motion-reduce:transition-none",
        text,
      )}
    >
      <span aria-hidden="true" className="relative flex size-1.5">
        {running > 0 && (
          <span className="absolute inset-0 animate-breathe rounded-full bg-primary" />
        )}
        <span className={cn("relative size-1.5 rounded-full", dot)} />
      </span>
      {label}
    </span>
  );
}

function BlockMeta({ block }: { block: TerminalBlock }) {
  if (block.status === "running") {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 font-sans text-[11px] text-muted-foreground">
        <LoaderCircleIcon aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
        running
      </div>
    );
  }
  const ok = block.exitCode === 0;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-sans text-[11px] text-muted-foreground">
      {block.exitCode !== null ? (
        <span
          className={cn(
            "inline-flex h-[18px] items-center gap-1 rounded-full px-1.5 font-mono font-medium",
            ok ? "bg-success/12 text-success" : "bg-destructive/10 text-destructive",
          )}
        >
          {ok ? <CheckIcon aria-hidden="true" className="size-3" /> : <XIcon aria-hidden="true" className="size-3" />}
          <span className="sr-only">exit code</span>
          {block.exitCode}
        </span>
      ) : (
        block.signal &&
        !block.cancelled && (
          <span className="inline-flex h-[18px] items-center rounded-full bg-destructive/10 px-1.5 font-mono font-medium text-destructive">
            {block.signal}
          </span>
        )
      )}
      {block.durationMs !== null && <span className="tabular-nums">{formatDuration(block.durationMs)}</span>}
      {block.cancelled && <span>cancelled</span>}
      {block.timedOut && <span className="text-amber-600 dark:text-amber-400">timed out</span>}
      {block.truncated && <span className="text-amber-600 dark:text-amber-400">output truncated</span>}
      {block.error && <span className="text-destructive">{block.error}</span>}
    </div>
  );
}

const BlockView = memo(function BlockView({
  block,
  runs,
  skipped,
  home,
  interrupted,
  onCancel,
}: {
  block: TerminalBlock;
  runs: OutputRun[];
  skipped: number;
  home: string;
  /** `^C` shown: cancelled by the server, or a cancel requested here and not yet confirmed. */
  interrupted: boolean;
  onCancel: (id: string) => void;
}) {
  const parsed = useMemo(() => parseRuns(runs), [runs]);
  const running = block.status === "running";
  const hasOutput = parsed.some((p) => p.segments.length > 0);
  const dir = tildify(block.cwd, home);
  const dirName = dir === "~" || dir === "/" ? dir : dir.slice(dir.lastIndexOf("/") + 1) || dir;

  return (
    <div className="group/block relative px-3 py-2.5 animate-in fade-in slide-in-from-bottom-1 duration-200 ease-(--ease-out-smooth) motion-reduce:animate-none md:px-4">
      <div className="flex min-w-0 items-baseline gap-2 pr-20">
        <span aria-hidden="true" className="shrink-0 font-bold text-primary select-none">
          ❯
        </span>
        <span title={block.cwd} className="shrink-0 text-muted-foreground select-none">
          {dirName}
        </span>
        <span className="min-w-0 font-medium break-all whitespace-pre-wrap text-foreground">{block.command}</span>
      </div>

      {skipped > 0 && (
        <p className="mt-1 font-sans text-[11px] text-muted-foreground/80 italic">
          … {formatSkipped(skipped)} of earlier output not shown
        </p>
      )}
      {(hasOutput || running || interrupted) && (
        <pre className="mt-1 font-mono break-words whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere]">
          {parsed.map((p, i) => (
            <AnsiSegments key={i} segments={p.segments} />
          ))}
          {interrupted && <span className="text-muted-foreground">^C</span>}
          {running && !interrupted && (
            <span
              aria-hidden="true"
              className="ml-px inline-block h-[1.15em] w-[0.6ch] translate-y-[0.2em] animate-pulse rounded-[1px] bg-primary/70 motion-reduce:animate-none"
            />
          )}
        </pre>
      )}
      <BlockMeta block={block} />

      <div className="absolute top-1.5 right-2 flex items-center gap-1 font-sans md:right-3">
        {running && (
          <Button
            variant="ghost"
            size="xs"
            disabled={interrupted}
            aria-label={`Stop ${block.command}`}
            onClick={() => onCancel(block.id)}
            className="pressable relative h-8 text-destructive after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] hover:bg-destructive/10 hover:text-destructive md:h-6 md:after:hidden"
          >
            <SquareIcon aria-hidden="true" className="fill-current" />
            {interrupted ? "Stopping" : "Stop"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copy command and output"
          onClick={() => void copyText(blockToText(block, runs, interrupted), "Copied command and output")}
          className="relative size-8 text-muted-foreground opacity-0 transition-opacity duration-150 after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] group-hover/block:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none md:size-6 md:after:hidden [@media(hover:none)]:opacity-100"
        >
          <CopyIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
});

function EmptyState({ cwd, onPick }: { cwd: string; onPick: (command: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 px-5 py-8 font-sans animate-in fade-in duration-300 motion-reduce:animate-none">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <SquareTerminalIcon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold tracking-tight text-foreground">Server terminal</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Commands run on the server in <span className="font-mono break-all text-foreground/80">{cwd}</span> and
            keep running when you leave this page.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-xs text-muted-foreground">Try</span>
        {SUGGESTIONS.map((command) => (
          <button
            key={command}
            type="button"
            onClick={() => onPick(command)}
            className="pressable h-11 rounded-lg border bg-background/60 px-3 font-mono text-xs text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-7 md:rounded-md md:px-2"
          >
            {command}
          </button>
        ))}
      </div>
      <dl className="hidden grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-xs text-muted-foreground sm:grid">
        {SHORTCUTS.map(({ keys, label }) => (
          <div key={label} className="contents">
            <dt>
              <KbdGroup>
                {keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </KbdGroup>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function LoadingState() {
  return (
    <div aria-hidden="true" className="space-y-5 px-3 py-4 md:px-4">
      {["w-40", "w-64", "w-28"].map((width, i) => (
        <div key={width} className="space-y-2" style={{ opacity: 1 - i * 0.25 }}>
          <Skeleton className={cn("h-3.5", width)} />
          <Skeleton className="h-3.5 w-full max-w-md" />
          <Skeleton className="h-3.5 w-3/4 max-w-sm" />
        </div>
      ))}
    </div>
  );
}

/**
 * Terminus-style terminal attached to the server's persistent session: command blocks with live
 * ANSI-colored output, a shell-like command line (history, Ctrl+C, Ctrl+L) and follow-the-tail
 * scrolling that pauses while the user reads back.
 */
export function TerminalView() {
  const { session, connection, cancelling, run, cancel, interrupt, clear } = useTerminal();
  const commandHistory = useCommandHistory();
  const [input, setInput] = useState("");
  const [showJump, setShowJump] = useState(false);
  /** Position in history while browsing with ↑/↓; null = editing the draft. */
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  const blocks = session?.blocks ?? [];
  const home = session?.home ?? "";
  const cwdLabel = session ? tildify(session.cwd, home) : "";
  const runningCount = blocks.filter((b) => b.status === "running").length;

  const focusInput = useCallback(() => textareaRef.current?.focus({ preventScroll: true }), []);
  /** After a button click: keep typing on desktop, but don't pop the on-screen keyboard on phones. */
  const refocusOnDesktop = useCallback(() => {
    if (window.matchMedia("(pointer: fine)").matches) focusInput();
  }, [focusInput]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    stickRef.current = true;
    setShowJump(false);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? "smooth" : "auto" });
  }, []);

  // Follow new output while stuck to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [session]);

  // The log also shrinks (input grows, keyboard opens): stay at the bottom then too.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Only an upward scroll unsticks: growth, smooth jumps and clamping never scroll up past the threshold.
    if (distance <= STICK_THRESHOLD_PX) stickRef.current = true;
    else if (el.scrollTop < lastScrollTopRef.current) stickRef.current = false;
    lastScrollTopRef.current = el.scrollTop;
    setShowJump(!stickRef.current);
  };

  // Auto-grow the command line up to its max height (CSS), then it scrolls.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Type right away on desktop; on touch devices that would throw up the keyboard uninvited.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) focusInput();
  }, [focusInput]);

  const clearScreen = useCallback(() => {
    void clear();
    scrollToBottom();
  }, [clear, scrollToBottom]);

  const resetHistoryNav = () => {
    historyIndexRef.current = null;
    draftRef.current = "";
  };

  const submit = () => {
    const command = input.trim();
    if (!command) return;
    commandHistory.push(command);
    resetHistoryNav();
    setInput("");
    scrollToBottom();
    if (command === "clear" || command === "cls") {
      void clear();
      return;
    }
    void run(command).then((started) => {
      // Refused (bad cwd, too many running…): give the command back unless something new was typed.
      if (!started) setInput((current) => current || command);
    });
  };

  /** ↑ (-1) / ↓ (+1) through history; returns whether the input changed. */
  const navigateHistory = (direction: -1 | 1): boolean => {
    const entries = commandHistory.entriesRef.current;
    const current = historyIndexRef.current ?? entries.length;
    const next = Math.min(Math.max(current + direction, 0), entries.length);
    if (next === current) return false;
    if (historyIndexRef.current === null) draftRef.current = input;
    historyIndexRef.current = next === entries.length ? null : next;
    const value = next === entries.length ? draftRef.current : entries[next];
    setInput(value);
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(value.length, value.length));
    return true;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const el = event.currentTarget;
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (event.key === "Enter" && plain) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase();
      if (key === "l") {
        event.preventDefault();
        clearScreen();
      } else if (key === "c") {
        if (el.selectionStart !== el.selectionEnd || hasTextSelection()) return; // Let copy happen.
        event.preventDefault();
        if (!interrupt()) {
          setInput("");
          resetHistoryNav();
        }
      }
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain && el.selectionStart === el.selectionEnd) {
      const up = event.key === "ArrowUp";
      // Multi-line input: only the first/last line hands ↑/↓ to history; elsewhere they move the caret.
      const onEdgeLine = up
        ? !el.value.slice(0, el.selectionStart).includes("\n")
        : !el.value.slice(el.selectionEnd).includes("\n");
      if (onEdgeLine && navigateHistory(up ? -1 : 1)) event.preventDefault();
    }
  };

  // Ctrl+C / Ctrl+L also work while focus is elsewhere on the page (a block's button, the log).
  // Other text fields and open dialogs keep their own keys; a text selection keeps Ctrl+C as copy.
  const shortcutsRef = useRef({ clearScreen, interrupt });
  shortcutsRef.current = { clearScreen, interrupt };
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target) || isModalOpen()) return;
      const key = event.key.toLowerCase();
      if (key === "l") {
        event.preventDefault();
        shortcutsRef.current.clearScreen();
      } else if (key === "c" && !hasTextSelection() && shortcutsRef.current.interrupt()) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, []);

  /** Clicking the log focuses the command line, unless the click ended a text selection. */
  const onLogClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (hasTextSelection() || (event.target as Element).closest("button, a")) return;
    // Phones: only taps on blank space, so reading back doesn't keep popping the keyboard.
    const blank = event.target === event.currentTarget || (event.target as HTMLElement).dataset.filler !== undefined;
    if (blank || window.matchMedia("(pointer: fine)").matches) focusInput();
  };

  const copyAll = () => {
    if (!session || session.blocks.length === 0) {
      toast("Nothing to copy yet");
      return;
    }
    const text = session.blocks
      .map((b) => blockToText(b, session.output[b.id] ?? NO_RUNS, b.cancelled || cancelling.has(b.id)))
      .join("\n\n");
    void copyText(text, "Copied terminal output");
    refocusOnDesktop();
  };

  const pickSuggestion = (command: string) => {
    setInput(command);
    resetHistoryNav();
    focusInput();
  };

  const hasInput = input.trim().length > 0;

  return (
    <section
      aria-label="Terminal"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card font-mono shadow-sm transition-[border-color,box-shadow] duration-200 ease-(--ease-out-smooth) has-[textarea:focus-visible]:border-ring/60 has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-ring/15 motion-reduce:transition-none dark:bg-[color-mix(in_oklch,var(--background),black_30%)]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/40 pr-1.5 pl-3 md:h-10 md:pl-4 dark:bg-white/[0.03]">
        <SquareTerminalIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        {/* RTL truncation keeps the end of a long path (the current folder) visible. */}
        <span
          title={session?.cwd}
          className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground [direction:rtl]"
        >
          <bdi>{cwdLabel}</bdi>
        </span>
        <ConnectionIndicator status={connection} />
        <SessionStatus blocks={blocks} />
        <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
        <div className="flex shrink-0 items-center font-sans">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy all output"
                onClick={copyAll}
                className="pressable-icon size-11 text-muted-foreground hover:text-foreground md:size-7"
              >
                <CopyIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy all output</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Clear screen"
                onClick={() => {
                  clearScreen();
                  refocusOnDesktop();
                }}
                className="pressable-icon size-11 text-muted-foreground hover:text-foreground md:size-7"
              >
                <EraserIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Clear screen
              <KbdGroup>
                <Kbd>Ctrl</Kbd>
                <Kbd>L</Kbd>
              </KbdGroup>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-label="Terminal output"
          aria-busy={!session}
          tabIndex={0}
          onScroll={onScroll}
          onClick={onLogClick}
          className="flex h-full flex-col overflow-y-auto overscroll-contain text-[13px] leading-[1.6] scrollbar-subtle selection:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset md:text-sm"
        >
          {!session ? (
            <LoadingState />
          ) : blocks.length === 0 ? (
            <EmptyState cwd={cwdLabel} onPick={pickSuggestion} />
          ) : (
            <div className="divide-y divide-border/60 py-1">
              {blocks.map((block) => (
                <BlockView
                  key={block.id}
                  block={block}
                  runs={session.output[block.id] ?? NO_RUNS}
                  skipped={session.skipped[block.id] ?? 0}
                  home={home}
                  interrupted={block.cancelled || cancelling.has(block.id)}
                  onCancel={cancel}
                />
              ))}
            </div>
          )}
          <div aria-hidden="true" data-filler="" className="min-h-3 flex-1" />
        </div>

        {showJump && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              className="pointer-events-auto inline-flex h-11 items-center gap-1.5 rounded-full border bg-background/90 px-4 font-sans text-xs font-medium text-foreground shadow-diffuse backdrop-blur-md transition-[background-color,scale] duration-150 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 ease-(--ease-out-smooth) hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-95 motion-reduce:animate-none motion-reduce:transition-none md:h-8 md:px-3.5"
            >
              <ArrowDownIcon aria-hidden="true" className="size-3.5" />
              Jump to latest
            </button>
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex shrink-0 items-start gap-2 border-t bg-muted/30 py-1 pr-1 pl-3 md:pr-1.5 md:pl-4 dark:bg-white/[0.02]"
      >
        <span aria-hidden="true" className="shrink-0 py-2.5 text-base leading-6 font-bold text-primary select-none md:py-1.5 md:text-sm md:leading-5">
          ❯
        </span>
        {/* 16px on phones: iOS zooms into smaller text fields on focus. 44px tall to line up with Run. */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            historyIndexRef.current = null;
          }}
          onKeyDown={onKeyDown}
          aria-label="Command"
          placeholder={runningCount > 0 ? "Run another command…" : "Type a command…"}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          inputMode="text"
          className="max-h-[10.25rem] min-w-0 flex-1 resize-none bg-transparent py-2.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 md:max-h-[8.25rem] md:py-1.5 md:text-sm md:leading-5"
        />
        <Button
          type="submit"
          size="icon"
          variant={hasInput ? "default" : "ghost"}
          disabled={!hasInput}
          aria-label="Run command"
          className="size-11 shrink-0 self-end rounded-lg transition-[background-color,color,scale] duration-150 active:scale-95 motion-reduce:transition-none md:size-7"
        >
          <CornerDownLeftIcon aria-hidden="true" />
        </Button>
      </form>
    </section>
  );
}
