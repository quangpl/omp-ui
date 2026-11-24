// Server-side roster behind the Visualize page's agent hub (GET /api/v1/agent-hub): the
// subagents of the most recent runs and a combined activity log, folded from the `agent` run
// events (see lib/agent/manager.ts trackSubagent: a new subagent, a status change and a final
// report are persisted; token counts and tool calls in between are live-only).
import { isTerminalSubagent } from "@/lib/agent/subagents";
import type { Repository } from "@/lib/db/types";
import type {
  AgentHubActivity,
  AgentHubAgent,
  AgentHubData,
  Run,
  SubagentSnapshot,
  SubagentStatus,
} from "@/lib/types";

/** Newest runs scanned for subagents. */
const RUN_LIMIT = 60;
const AGENT_LIMIT = 400;
const ACTIVITY_LIMIT = 300;
const EVENT_PAGE = 1000;
const TEXT_MAX = 240;
/** Folded runs kept in memory (finished runs never change, so they are read once). */
const CACHE_MAX = 200;

interface TrackedAgent {
  snapshot: SubagentSnapshot;
  startedAt: string;
  lastActivityAt: string;
  /** Activity lines emitted so far (makes the activity ids unique). */
  lines: number;
}

/** What the `agent` events of one run add up to. */
export interface RunFold {
  /** Last event seq read (the `after` cursor). */
  after: number;
  agents: Map<string, TrackedAgent>;
  /** Oldest first. */
  activity: AgentHubActivity[];
  /** True once read after the run ended: nothing more will come. */
  final: boolean;
  /** Serializes reads so concurrent requests never apply an event twice. */
  sync: Promise<unknown>;
}

const g = globalThis as unknown as { __ompAgentHubFolds?: Map<string, RunFold> };
const folds = (g.__ompAgentHubFolds ??= new Map());

export function newRunFold(): RunFold {
  return { after: 0, agents: new Map(), activity: [], final: false, sync: Promise.resolve() };
}

const clip = (text: string, max = TEXT_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const STATUS_VERB: Record<SubagentStatus, string> = {
  pending: "Queued",
  running: "Started",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
};

function parseSnapshot(text: string): SubagentSnapshot | null {
  try {
    const value = JSON.parse(text) as Partial<SubagentSnapshot> | null;
    if (!value || typeof value.id !== "string" || typeof value.status !== "string") return null;
    return { ...value, id: value.id, agent: value.agent ?? "task", status: value.status };
  } catch {
    return null;
  }
}

/** Fold one persisted `agent` event (`text` = JSON snapshot) into `fold`. */
export function foldAgentEvent(fold: RunFold, runId: string, event: { text: string; createdAt: string }): void {
  const snapshot = parseSnapshot(event.text);
  if (!snapshot) return;
  const prev = fold.agents.get(snapshot.id);
  const key = `${runId}:${snapshot.id}`;
  const tracked: TrackedAgent = prev ?? { snapshot, startedAt: event.createdAt, lastActivityAt: event.createdAt, lines: 0 };
  const line = (kind: AgentHubActivity["kind"], text: string) => {
    fold.activity.push({
      id: `${key}:${tracked.lines++}`,
      at: event.createdAt,
      agentKey: key,
      agentId: snapshot.id,
      kind,
      text,
    });
  };
  if (!prev || prev.snapshot.status !== snapshot.status) {
    const about = oneLine(snapshot.description ?? snapshot.task ?? "");
    line("lifecycle", about && !prev ? `${STATUS_VERB[snapshot.status]}: ${clip(about)}` : STATUS_VERB[snapshot.status]);
  }
  if (snapshot.output && snapshot.output !== prev?.snapshot.output) line("response", clip(oneLine(snapshot.output)));
  if (snapshot.error && snapshot.error !== prev?.snapshot.error) line("error", clip(oneLine(snapshot.error)));
  tracked.snapshot = snapshot;
  tracked.lastActivityAt = event.createdAt;
  fold.agents.set(snapshot.id, tracked);
}

/** Read the events `fold` has not seen yet. `ended`: the run is over, so this read is the last. */
async function syncFold(repo: Repository, runId: string, fold: RunFold, ended: boolean): Promise<void> {
  const next = fold.sync.then(async () => {
    if (fold.final) return;
    for (;;) {
      const events = await repo.listRunEvents(runId, fold.after, EVENT_PAGE);
      for (const event of events) {
        fold.after = event.seq;
        if (event.kind === "agent") foldAgentEvent(fold, runId, event);
      }
      if (events.length < EVENT_PAGE) break;
    }
    fold.final = ended;
  });
  fold.sync = next.catch(() => undefined);
  return next;
}

/** Parent of a dot-qualified subagent id (`Parent.Child`); null for a top-level one. */
export function parentOf(id: string): string | null {
  const dot = id.lastIndexOf(".");
  return dot > 0 ? id.slice(0, dot) : null;
}

/** A subagent still working when its run is over died with the run. */
function settled(snapshot: SubagentSnapshot, run: Run): SubagentSnapshot {
  return run.status === "running" || isTerminalSubagent(snapshot.status) ? snapshot : { ...snapshot, status: "aborted" };
}

export async function buildAgentHub(repo: Repository): Promise<AgentHubData> {
  const runs = await repo.listRecentRuns(RUN_LIMIT);
  const runFolds = await Promise.all(
    runs.map(async (run) => {
      let fold = folds.get(run.id);
      if (!fold) {
        fold = newRunFold();
        folds.set(run.id, fold);
      }
      await syncFold(repo, run.id, fold, run.status !== "running");
      return fold;
    }),
  );
  while (folds.size > CACHE_MAX) folds.delete(folds.keys().next().value as string);

  const taskIds = [...new Set(runs.filter((_, i) => runFolds[i].agents.size > 0).map((run) => run.taskId))];
  const [tasks, boards] = await Promise.all([Promise.all(taskIds.map((id) => repo.getTask(id))), repo.listBoards()]);
  const taskById = new Map(tasks.flatMap((task) => (task ? [[task.id, task] as const] : [])));
  const boardName = new Map(boards.map((board) => [board.id, board.name]));

  const agents: AgentHubAgent[] = [];
  const activity: AgentHubActivity[] = [];
  runs.forEach((run, i) => {
    const task = taskById.get(run.taskId);
    if (!task) return;
    for (const [id, tracked] of runFolds[i].agents) {
      agents.push({
        key: `${run.id}:${id}`,
        runId: run.id,
        taskId: task.id,
        boardId: task.boardId,
        boardName: boardName.get(task.boardId) ?? "",
        taskTitle: task.title,
        runStatus: run.status,
        parentId: parentOf(id),
        snapshot: settled(tracked.snapshot, run),
        startedAt: tracked.startedAt,
        lastActivityAt: tracked.lastActivityAt,
      });
    }
    activity.push(...runFolds[i].activity);
  });
  agents.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  activity.sort((a, b) => b.at.localeCompare(a.at));
  const kept = agents.slice(0, AGENT_LIMIT);
  const keptKeys = new Set(kept.map((agent) => agent.key));
  return {
    generatedAt: new Date().toISOString(),
    agents: kept,
    activity: activity.filter((line) => keptKeys.has(line.agentKey)).slice(0, ACTIVITY_LIMIT),
  };
}
