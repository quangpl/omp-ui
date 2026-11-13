"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { OutputRun } from "@/components/terminal/ansi";
import { api } from "@/lib/api-client";
import {
  TERMINAL_MAX_BLOCKS,
  TERMINAL_MAX_COMMAND_LENGTH,
  type TerminalBlock,
  type TerminalStreamEvent,
} from "@/lib/terminal-types";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

/** The attached session as shown on screen; replaced wholesale by every `snapshot`. */
export interface TerminalSession {
  /** Oldest first. */
  blocks: TerminalBlock[];
  /** Block id → its output, split into runs (see RUN_SPLIT_AT). */
  output: Record<string, OutputRun[]>;
  /** Block id → bytes dropped from the start of its replayed output. */
  skipped: Record<string, number>;
  /** Where the next command starts. */
  cwd: string;
  home: string;
}

const HISTORY_KEY = "omp-ui:terminal-history";
const MAX_HISTORY = 200;
/**
 * Output is kept as runs of about this many characters, split after a newline, so a long stream
 * re-parses only its newest stretch per frame; whole lines stay together so `\r` overwrites never
 * straddle two runs.
 */
const RUN_SPLIT_AT = 8192;

function appendOutput(runs: readonly OutputRun[], data: string): OutputRun[] {
  const next = runs.slice();
  const last = next[next.length - 1];
  let text = data;
  if (last && !(last.text.length >= RUN_SPLIT_AT && last.text.endsWith("\n"))) {
    next.pop();
    text = last.text + data;
  }
  while (text.length > RUN_SPLIT_AT) {
    const nl = text.indexOf("\n", RUN_SPLIT_AT - 1);
    if (nl < 0 || nl === text.length - 1) break;
    next.push({ text: text.slice(0, nl + 1) });
    text = text.slice(nl + 1);
  }
  next.push({ text });
  return next;
}

/**
 * Inserts or updates `block` by id, keeping start order. A finished block never goes back to running
 * (the `execute` response can arrive after the stream already reported a fast command's exit), and
 * the oldest finished blocks beyond TERMINAL_MAX_BLOCKS are dropped, as the server prunes them.
 */
function upsertBlock(session: TerminalSession, block: TerminalBlock): TerminalSession {
  const index = session.blocks.findIndex((b) => b.id === block.id);
  if (index >= 0) {
    const existing = session.blocks[index];
    if (existing.status === "done" && block.status === "running") return session;
    const blocks = session.blocks.slice();
    blocks[index] = block;
    return { ...session, blocks };
  }
  let blocks = [...session.blocks, block];
  if (blocks.length > 1 && blocks[blocks.length - 2].id > block.id) {
    blocks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  let finished = blocks.filter((b) => b.status === "done").length;
  if (finished <= TERMINAL_MAX_BLOCKS) return { ...session, blocks };
  const output = { ...session.output };
  const skipped = { ...session.skipped };
  blocks = blocks.filter((b) => {
    if (finished <= TERMINAL_MAX_BLOCKS || b.status !== "done") return true;
    finished--;
    delete output[b.id];
    delete skipped[b.id];
    return false;
  });
  return { ...session, blocks, output, skipped };
}

/** `ids` without those of `blocks` that have finished (the block's own `cancelled` flag takes over). */
function dropFinished(ids: ReadonlySet<string>, blocks: readonly TerminalBlock[]): ReadonlySet<string> {
  const finished = blocks.filter((b) => b.status === "done" && ids.has(b.id));
  if (finished.length === 0) return ids;
  const next = new Set(ids);
  for (const b of finished) next.delete(b.id);
  return next;
}

/**
 * The server's persistent terminal session (tmux-like: commands keep running while nobody watches).
 * Subscribes to the session stream; every (re)connection starts with an authoritative snapshot.
 * Output is buffered and applied once per animation frame so a chatty command doesn't re-render
 * per chunk.
 */
export function useTerminal() {
  /** Null until the first snapshot arrives. */
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  /** Ids whose cancel was requested: shown as `^C` right away, before the server reports them done. */
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef(new Map<string, string>());
  const frameRef = useRef<number | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  sessionRef.current = session;

  /** Applies buffered output now (also before a block update, so a block's last output lands first). */
  const flush = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending.size === 0) return;
    const chunks = [...pending];
    pending.clear();
    setSession((prev) => {
      if (!prev) return prev;
      const output = { ...prev.output };
      for (const [id, data] of chunks) output[id] = appendOutput(output[id] ?? [], data);
      return { ...prev, output };
    });
  }, []);

  useEffect(() => {
    const onEvent = (event: TerminalStreamEvent) => {
      if (event.type === "output") {
        const pending = pendingRef.current;
        pending.set(event.id, (pending.get(event.id) ?? "") + event.data);
        frameRef.current ??= requestAnimationFrame(() => {
          frameRef.current = null;
          flush();
        });
        return;
      }
      if (event.type === "snapshot") {
        // Authoritative: buffered chunks predate it (they came from the previous connection).
        pendingRef.current.clear();
        if (frameRef.current !== null) {
          cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
        const { blocks, output, skipped, cwd, home } = event.snapshot;
        const runs: Record<string, OutputRun[]> = {};
        for (const [id, text] of Object.entries(output)) if (text) runs[id] = appendOutput([], text);
        setSession({ blocks, output: runs, skipped, cwd, home });
        setCancelling((prev) => dropFinished(prev, blocks));
        setConnection("live");
        return;
      }
      flush();
      setSession((prev) => (prev ? { ...upsertBlock(prev, event.block), cwd: event.cwd } : prev));
      if (event.block.status === "done") setCancelling((prev) => dropFinished(prev, [event.block]));
    };
    const unsubscribe = api.terminal.subscribe(onEvent, { onStatus: setConnection });
    return () => {
      unsubscribe();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [flush]);

  /** Starts `command` in the session cwd; false when the server refused it (reason toasted). */
  const run = useCallback(async (command: string): Promise<boolean> => {
    try {
      if (command.length > TERMINAL_MAX_COMMAND_LENGTH) {
        throw new Error(`Commands are limited to ${TERMINAL_MAX_COMMAND_LENGTH.toLocaleString()} characters`);
      }
      const block = await api.terminal.execute({ command });
      setSession((prev) => (prev ? upsertBlock(prev, block) : prev));
      return true;
    } catch (err) {
      toast.error("Couldn't run the command", {
        description: err instanceof Error && err.message ? err.message : undefined,
      });
      return false;
    }
  }, []);

  /** Asks the server to kill block `id`'s process; the `block` event then reports it cancelled. */
  const cancel = useCallback(async (id: string) => {
    setCancelling((prev) => new Set(prev).add(id));
    try {
      await api.terminal.cancel(id);
    } catch (err) {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast.error("Couldn't stop the command", {
        description: err instanceof Error && err.message ? err.message : undefined,
      });
    }
  }, []);

  /**
   * Ctrl+C: cancels the newest running block not already being cancelled. Returns false when nothing
   * is running (the caller then clears the input, like a shell).
   */
  const interrupt = useCallback((): boolean => {
    const running = sessionRef.current?.blocks.filter((b) => b.status === "running") ?? [];
    if (running.length === 0) return false;
    const target = running.findLast((b) => !cancelling.has(b.id));
    if (target) void cancel(target.id);
    return true;
  }, [cancel, cancelling]);

  /** Clears finished blocks server-side (running ones stay); the stream then sends a fresh snapshot. */
  const clear = useCallback(async () => {
    try {
      await api.terminal.clear();
    } catch (err) {
      toast.error("Couldn't clear the terminal", {
        description: err instanceof Error && err.message ? err.message : undefined,
      });
    }
  }, []);

  return { session, connection, cancelling, run, cancel, interrupt, clear };
}

/**
 * Shell-style command history in localStorage: consecutive duplicates collapse, the newest
 * MAX_HISTORY entries are kept. Read once on mount; the ref is what key handlers navigate.
 */
export function useCommandHistory() {
  const entriesRef = useRef<string[]>([]);

  useEffect(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
      if (Array.isArray(parsed)) {
        entriesRef.current = parsed
          .filter((entry): entry is string => typeof entry === "string")
          .slice(-MAX_HISTORY);
      }
    } catch {
      // Corrupt or unavailable storage: start with an empty history.
    }
  }, []);

  const push = useCallback((command: string) => {
    const entries = entriesRef.current;
    if (entries[entries.length - 1] === command) return;
    entriesRef.current = [...entries, command].slice(-MAX_HISTORY);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entriesRef.current));
    } catch {
      // Storage full or disabled: history still works for this page.
    }
  }, []);

  return { entriesRef, push };
}
