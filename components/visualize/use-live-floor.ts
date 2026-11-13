"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { parseToolCall } from "@/lib/run-log";
import type { RunEvent, ServerEvent, SubagentSnapshot } from "@/lib/types";
import { boardContact } from "./factory";
import { type Activity, describeActivity } from "./game";

/** One board interaction of a worker with other cards (a board_* tool call). */
export interface Contact {
  kind: "message" | "wait" | "inspect";
  /** Cards it messaged, waited for or read. */
  cardIds: string[];
  /** When the tool call started (ISO). */
  at: string;
}

/** What the Visualize floor knows live about one running card, beyond the dashboard snapshot. */
export interface LiveWorker {
  runId?: string;
  /** Start of the current run: the worker's shift clock. */
  startedAt?: string;
  /** Latest thing the agent did; unknown until its first event after the page opened. */
  activity?: Activity;
  /** Subagents of the current run by id, latest snapshot each. */
  helpers: Record<string, SubagentSnapshot>;
  /** Recent board interactions with other cards (newest last, at most 12). */
  contacts: Contact[];
}

type LiveMap = Record<string, LiveWorker>;

const EMPTY: LiveWorker = { helpers: {}, contacts: [] };

/** Board contacts kept per worker. */
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
 * The running run of `taskId` and what its log says so far: latest activity, subagents and board
 * contacts. Lets the floor show the right state right after a reload instead of waiting for the
 * next event.
 */
async function replayRun(taskId: string) {
  const run = (await api.tasks.runs(taskId)).find((r) => r.status === "running");
  if (!run) return null;
  let activity: Activity | undefined;
  const helpers: Record<string, SubagentSnapshot> = {};
  const contacts: Contact[] = [];
  for (let after = 0; ; ) {
    const page = await api.runs.events(run.id, after, EVENTS_PAGE);
    for (const event of page) {
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
  return { run, activity, helpers, contacts: contacts.slice(-MAX_CONTACTS) };
}

/**
 * Per-card live state for the agents on the floor, fed by the page's event stream (`onEvent`).
 * Cards in `runningIds` the page has not seen yet get their run's log replayed once.
 */
export function useLiveFloor(runningIds: readonly string[]) {
  const [live, setLive] = useState<LiveMap>({});
  const fetched = useRef(new Set<string>());

  const patch = useCallback((taskId: string, update: (worker: LiveWorker) => LiveWorker | null) => {
    setLive((prev) => {
      const next = update(prev[taskId] ?? EMPTY);
      return next === null ? prev : { ...prev, [taskId]: next };
    });
  }, []);

  const runningKey = runningIds.join(",");
  useEffect(() => {
    const running = new Set(runningKey ? runningKey.split(",") : []);
    // Drop workers that left the floor so a later run starts fresh.
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
          const { run, activity, helpers, contacts } = replay;
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
          // Same run (or the run this worker's live events already belong to): just learn the
          // start time. A new run of the card starts with a clean slate.
          patch(run.taskId, (w) => {
            if (w.runId === run.id) return w.startedAt ? null : { ...w, startedAt: run.startedAt };
            if (!w.runId) return { ...w, runId: run.id, startedAt: run.startedAt };
            return { helpers: {}, contacts: [], runId: run.id, startedAt: run.startedAt };
          });
          return;
        }
        case "run.event": {
          const { event: e } = event;
          if (e.kind === "agent") {
            const snapshot = parseSnapshot(e.text);
            if (snapshot) patch(e.taskId, (w) => ({ ...w, helpers: { ...w.helpers, [snapshot.id]: snapshot } }));
            return;
          }
          const activity = describeActivity(e.kind, e.text);
          const contact = contactOf(e);
          if (!activity && !contact) return;
          patch(e.taskId, (w) => ({
            ...w,
            activity: activity ?? w.activity,
            contacts: contact ? mergeContacts(w.contacts, [contact]) : w.contacts,
          }));
          return;
        }
        case "run.agent":
          patch(event.taskId, (w) => ({ ...w, helpers: { ...w.helpers, [event.agent.id]: event.agent } }));
          return;
        case "run.delta": {
          // Deltas stream many times a second; only a change of kind changes the worker.
          const activity = describeActivity(event.kind, event.text);
          if (!activity) return;
          patch(event.taskId, (w) => (w.activity?.icon === activity.icon ? null : { ...w, activity }));
          return;
        }
      }
    },
    [patch],
  );

  return { live, onEvent };
}
