"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import type { ServerEvent, SubagentSnapshot } from "@/lib/types";
import { type Activity, describeActivity } from "./game";

/** What the Visualize floor knows live about one running card, beyond the dashboard snapshot. */
export interface LiveWorker {
  runId?: string;
  /** Start of the current run: the worker's shift clock. */
  startedAt?: string;
  /** Latest thing the agent did; unknown until its first event after the page opened. */
  activity?: Activity;
  /** Subagents of the current run by id, latest snapshot each. */
  helpers: Record<string, SubagentSnapshot>;
}

type LiveMap = Record<string, LiveWorker>;

const EMPTY: LiveWorker = { helpers: {} };

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
 * The running run of `taskId` and what its log says so far: latest activity and subagents. Lets
 * the floor show the right state right after a reload instead of waiting for the next event.
 */
async function replayRun(taskId: string) {
  const run = (await api.tasks.runs(taskId)).find((r) => r.status === "running");
  if (!run) return null;
  let activity: Activity | undefined;
  const helpers: Record<string, SubagentSnapshot> = {};
  for (let after = 0; ; ) {
    const page = await api.runs.events(run.id, after, EVENTS_PAGE);
    for (const event of page) {
      if (event.kind === "agent") {
        const snapshot = parseSnapshot(event.text);
        if (snapshot) helpers[snapshot.id] = snapshot;
      } else {
        activity = describeActivity(event.kind, event.text) ?? activity;
      }
    }
    if (page.length < EVENTS_PAGE) break;
    after = page[page.length - 1].seq;
  }
  return { run, activity, helpers };
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
          const { run, activity, helpers } = replay;
          // Live events that arrived meanwhile are newer than the replay and win.
          patch(taskId, (w) =>
            w.runId && w.runId !== run.id
              ? null
              : {
                  runId: run.id,
                  startedAt: run.startedAt,
                  activity: w.activity ?? activity,
                  helpers: { ...helpers, ...w.helpers },
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
            return { helpers: {}, runId: run.id, startedAt: run.startedAt };
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
          if (activity) patch(e.taskId, (w) => ({ ...w, activity }));
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
