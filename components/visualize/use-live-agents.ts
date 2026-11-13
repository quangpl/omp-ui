"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { parseToolCall, parseToolFailure } from "@/lib/run-log";
import type { ContextUsage, RunEvent, RunEventKind, ServerEvent, SubagentSnapshot } from "@/lib/types";
import { boardContact } from "./agent-map";
import { type Activity, describeActivity } from "./activity";

/** One board interaction of an agent with other cards (a board_* tool call). */
export interface Contact {
  kind: "message" | "wait" | "inspect";
  /** Cards it messaged, waited for or read. */
  cardIds: string[];
  /** When the tool call started (ISO). */
  at: string;
}

/** Running tallies of one run, the raw material of the agent's mood (see ./mood). */
export interface AgentStats {
  toolCount: number;
  errorCount: number;
  /** Model request retries ("Retrying …" status lines) over the whole run. */
  retryCount: number;
  /** Newest last, at most 12. */
  recentTools: { tool: string; at: string; error?: boolean }[];
  /** Errors since the last sign of progress (successful tool / text reply). */
  unresolvedErrors: number;
  lastProgressAt?: string;
  lastErrorAt?: string;
  /** Start of the current uninterrupted thinking stretch; cleared by any non-thinking event. */
  thinkingSince?: string;
  lastEventAt?: string;
}

/** What the Visualize page knows live about one running card, beyond the dashboard snapshot. */
export interface LiveAgent {
  runId?: string;
  /** Start of the current run. */
  startedAt?: string;
  /** Latest thing the agent did; unknown until its first event after the page opened. */
  activity?: Activity;
  /** Subagents of the current run by id, latest snapshot each. */
  helpers: Record<string, SubagentSnapshot>;
  /** Recent board interactions with other cards (newest last, at most 12). */
  contacts: Contact[];
  /** Tallies of the current run (zeros before its first event). */
  stats: AgentStats;
  /** Latest context fill of the current run ("run.context" events). */
  context?: ContextUsage;
}

type LiveMap = Record<string, LiveAgent>;

/** Stats of a run with no events yet. */
export const EMPTY_STATS: AgentStats = { toolCount: 0, errorCount: 0, retryCount: 0, recentTools: [], unresolvedErrors: 0 };

const EMPTY: LiveAgent = { helpers: {}, contacts: [], stats: EMPTY_STATS };

/** Tool calls kept in `AgentStats.recentTools`. */
const MAX_RECENT_TOOLS = 12;

/** `stats` without a thinking stretch. */
function stopThinking(stats: AgentStats): AgentStats {
  if (!stats.thinkingSince) return stats;
  const { thinkingSince: _, ...rest } = stats;
  return rest;
}

/**
 * `stats` after one run event of `kind` at `at` (ISO). A tool call whose previous call went fine
 * counts as progress and clears unresolved errors, unless it goes back to the tool that failed
 * last; a text reply always does. Thinking starts a stretch, anything else ends it.
 */
export function applyEvent(stats: AgentStats, kind: RunEventKind, text: string, at: string): AgentStats {
  const next: AgentStats = { ...stats, lastEventAt: at };
  switch (kind) {
    case "tool": {
      const tool = parseToolCall(text).name;
      const prev = stats.recentTools[stats.recentTools.length - 1];
      if (!prev?.error) {
        next.lastProgressAt = at;
        const failing = stats.recentTools.findLast((t) => t.error)?.tool;
        if (tool !== failing || prev?.tool === failing) next.unresolvedErrors = 0;
      }
      next.toolCount = stats.toolCount + 1;
      next.recentTools = [...stats.recentTools, { tool, at }].slice(-MAX_RECENT_TOOLS);
      return stopThinking(next);
    }
    case "error": {
      next.errorCount = stats.errorCount + 1;
      next.unresolvedErrors = stats.unresolvedErrors + 1;
      next.lastErrorAt = at;
      const failed = /^✗ (\S+) failed/.exec(text)?.[1];
      if (failed) {
        const index = stats.recentTools.findLastIndex((t) => t.tool === failed);
        if (index !== -1) next.recentTools = stats.recentTools.with(index, { ...stats.recentTools[index], error: true });
      }
      return stopThinking(next);
    }
    case "status":
      if (text.startsWith("Retrying")) next.retryCount = stats.retryCount + 1;
      else if (text.startsWith("Retry succeeded")) next.unresolvedErrors = 0;
      return stopThinking(next);
    case "text":
      next.lastProgressAt = at;
      next.unresolvedErrors = 0;
      return stopThinking(next);
    case "thinking":
      next.thinkingSince = stats.thinkingSince ?? at;
      return next;
    case "agent":
      // Subagent snapshots are a sign of life, not of the agent's own work.
      return next;
  }
}

/**
 * Replayed stats of a run plus what live events taught meanwhile: counts are lower bounds, so
 * the larger wins; the side that saw the latest event decides the current stretch and errors.
 */
function mergeStats(replay: AgentStats, live: AgentStats): AgentStats {
  const liveLatest = live.lastEventAt ?? live.thinkingSince;
  if (!liveLatest) return replay;
  const newer = liveLatest > (replay.lastEventAt ?? "") ? live : replay;
  const later = (a?: string, b?: string) => (a && b ? (a > b ? a : b) : (a ?? b));
  const seen = new Set(replay.recentTools.map((t) => `${t.at}|${t.tool}`));
  const recentTools = [...replay.recentTools, ...live.recentTools.filter((t) => !seen.has(`${t.at}|${t.tool}`))]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-MAX_RECENT_TOOLS);
  return {
    toolCount: Math.max(replay.toolCount, live.toolCount),
    errorCount: Math.max(replay.errorCount, live.errorCount),
    retryCount: Math.max(replay.retryCount, live.retryCount),
    recentTools,
    unresolvedErrors: newer.unresolvedErrors,
    lastProgressAt: later(replay.lastProgressAt, live.lastProgressAt),
    lastErrorAt: later(replay.lastErrorAt, live.lastErrorAt),
    thinkingSince: newer.thinkingSince,
    lastEventAt: later(replay.lastEventAt, live.lastEventAt),
  };
}

/** Board contacts kept per agent. */
const MAX_CONTACTS = 12;

/** A persisted tool event → the board contact it records; null for anything else. */
function contactOf(event: RunEvent): Contact | null {
  if (event.kind !== "tool") return null;
  const { name, detail } = parseToolCall(event.text);
  const contact = boardContact(name, detail);
  return contact && { ...contact, at: event.createdAt };
}

/**
 * `contacts` plus the new ones in `more` (same time, kind and cards = same contact): oldest
 * first, the newest MAX_CONTACTS.
 */
function mergeContacts(contacts: Contact[], more: Contact[]): Contact[] {
  const key = (c: Contact) => `${c.at}|${c.kind}|${c.cardIds.join(",")}`;
  const merged = [...contacts];
  const seen = new Set(merged.map(key));
  for (const contact of more) {
    if (seen.has(key(contact))) continue;
    seen.add(key(contact));
    merged.push(contact);
  }
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return merged.slice(-MAX_CONTACTS);
}

function parseSnapshot(text: string): SubagentSnapshot | null {
  try {
    const value = JSON.parse(text) as SubagentSnapshot;
    return value && typeof value.id === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Events per page when replaying a run's log. */
const EVENTS_PAGE = 1000;

/**
 * The running run of `taskId` and what its log says so far: latest activity, subagents, board
 * contacts and stats. Lets the page show the right state right after a reload instead of
 * waiting for the next event.
 */
async function replayRun(taskId: string) {
  const run = (await api.tasks.runs(taskId)).find((r) => r.status === "running");
  if (!run) return null;
  let activity: Activity | undefined;
  const helpers: Record<string, SubagentSnapshot> = {};
  const contacts: Contact[] = [];
  let stats = EMPTY_STATS;
  for (let after = 0; ; ) {
    const page = await api.runs.events(run.id, after, EVENTS_PAGE);
    for (const event of page) {
      stats = applyEvent(stats, event.kind, event.text, event.createdAt);
      if (event.kind === "agent") {
        const snapshot = parseSnapshot(event.text);
        if (snapshot) helpers[snapshot.id] = snapshot;
      } else {
        activity = describeActivity(event.kind, event.text) ?? activity;
        const contact = contactOf(event);
        if (contact) contacts.push(contact);
      }
    }
    if (page.length < EVENTS_PAGE) break;
    after = page[page.length - 1].seq;
  }
  return { run, activity, helpers, contacts: contacts.slice(-MAX_CONTACTS), stats };
}

/**
 * Per-card live state for the running agents, fed by the page's event stream (`onEvent`).
 * Cards in `runningIds` the page has not seen yet get their run's log replayed once.
 */
export function useLiveAgents(runningIds: readonly string[]) {
  const [live, setLive] = useState<LiveMap>({});
  const fetched = useRef(new Set<string>());

  const patch = useCallback((taskId: string, update: (agent: LiveAgent) => LiveAgent | null) => {
    setLive((prev) => {
      const next = update(prev[taskId] ?? EMPTY);
      return next === null ? prev : { ...prev, [taskId]: next };
    });
  }, []);

  const runningKey = runningIds.join(",");
  useEffect(() => {
    const running = new Set(runningKey ? runningKey.split(",") : []);
    // Drop agents that stopped running so a later run starts fresh.
    setLive((prev) => {
      const gone = Object.keys(prev).filter((id) => !running.has(id));
      if (gone.length === 0) return prev;
      const next = { ...prev };
      for (const id of gone) delete next[id];
      return next;
    });
    for (const id of fetched.current) if (!running.has(id)) fetched.current.delete(id);
    for (const taskId of running) {
      if (fetched.current.has(taskId)) continue;
      fetched.current.add(taskId);
      replayRun(taskId)
        .then((replay) => {
          if (!replay) return;
          const { run, activity, helpers, contacts, stats } = replay;
          // Live events that arrived meanwhile are newer than the replay and win.
          patch(taskId, (w) =>
            w.runId && w.runId !== run.id
              ? null
              : {
                  runId: run.id,
                  startedAt: run.startedAt,
                  activity: w.activity ?? activity,
                  helpers: { ...helpers, ...w.helpers },
                  contacts: mergeContacts(contacts, w.contacts),
                  stats: mergeStats(stats, w.stats),
                  context: w.context,
                },
          );
        })
        .catch(() => fetched.current.delete(taskId));
    }
  }, [runningKey, patch]);

  const onEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "run.updated": {
          const { run } = event;
          if (run.status !== "running") return;
          // Same run (or the run this agent's live events already belong to): just learn the
          // start time. A new run of the card starts with a clean slate.
          patch(run.taskId, (w) => {
            if (w.runId === run.id) return w.startedAt ? null : { ...w, startedAt: run.startedAt };
            if (!w.runId) return { ...w, runId: run.id, startedAt: run.startedAt };
            return { helpers: {}, contacts: [], stats: EMPTY_STATS, runId: run.id, startedAt: run.startedAt };
          });
          return;
        }
        case "run.event": {
          const { event: e } = event;
          if (e.kind === "agent") {
            const snapshot = parseSnapshot(e.text);
            if (snapshot) {
              patch(e.taskId, (w) => ({
                ...w,
                helpers: { ...w.helpers, [snapshot.id]: snapshot },
                stats: applyEvent(w.stats, e.kind, e.text, e.createdAt),
              }));
            }
            return;
          }
          const activity = describeActivity(e.kind, e.text);
          const contact = contactOf(e);
          patch(e.taskId, (w) => ({
            ...w,
            activity: activity ?? w.activity,
            contacts: contact ? mergeContacts(w.contacts, [contact]) : w.contacts,
            stats: applyEvent(w.stats, e.kind, e.text, e.createdAt),
          }));
          return;
        }
        case "run.agent":
          patch(event.taskId, (w) => ({ ...w, helpers: { ...w.helpers, [event.agent.id]: event.agent } }));
          return;
        case "run.context": {
          const { context } = event;
          patch(event.taskId, (w) =>
            (w.runId && w.runId !== event.runId) ||
            (w.context?.tokens === context.tokens && w.context.contextWindow === context.contextWindow)
              ? null
              : { ...w, context },
          );
          return;
        }
        case "run.delta": {
          // Deltas stream many times a second: patch only when the kind of activity changes or a
          // thinking stretch starts or ends (deltas carry no time, so it is stamped now).
          const activity = describeActivity(event.kind, event.text);
          if (!activity) return;
          const thinking = event.kind === "thinking";
          patch(event.taskId, (w) => {
            const stretchChanges = thinking !== Boolean(w.stats.thinkingSince);
            if (w.activity?.icon === activity.icon && !stretchChanges) return null;
            if (!stretchChanges) return { ...w, activity };
            const stats = thinking ? { ...w.stats, thinkingSince: new Date().toISOString() } : stopThinking(w.stats);
            return { ...w, activity, stats };
          });
          return;
        }
      }
    },
    [patch],
  );

  return { live, onEvent };
}
