// Pure logic of the Visualize page's agent hub: merging live progress into the server's roster,
// filtering, ordering, the parent/child tree and the aggregates in the header.
import type { AgentHubActivity, AgentHubActivityKind, AgentHubAgent, SubagentSnapshot, SubagentStatus } from "@/lib/types";
import type { LiveAgent } from "./use-live-agents";

/** omp's Agent Hub calls a finished subagent whose transcript is kept "parked". */
export const HUB_STATUS_LABEL: Record<SubagentStatus, string> = {
  running: "Running",
  pending: "Queued",
  completed: "Parked",
  failed: "Failed",
  aborted: "Aborted",
};

/** Operational order: what needs eyes first. */
const STATUS_RANK: Record<SubagentStatus, number> = { running: 0, pending: 1, failed: 2, aborted: 3, completed: 4 };

/** The card a live subagent belongs to (from the dashboard queue). */
export interface HubCard {
  boardId: string;
  boardName: string;
  title: string;
}

/** Last snapshot seen per agent key, to date live changes. Mutated by `mergeLive`. */
export type SeenSnapshots = Map<string, { json: string; at: string }>;

/**
 * `agents` with the live snapshots of running cards laid over them (they are newer than what was
 * persisted) plus subagents the server has not listed yet. A live change is dated `nowIso`.
 */
export function mergeLive(
  agents: readonly AgentHubAgent[],
  live: Readonly<Record<string, LiveAgent>>,
  cards: ReadonlyMap<string, HubCard>,
  seen: SeenSnapshots,
  nowIso: string,
): { agents: AgentHubAgent[]; liveKeys: Set<string> } {
  const byKey = new Map(agents.map((agent) => [agent.key, agent]));
  const liveKeys = new Set<string>();
  for (const [taskId, entry] of Object.entries(live)) {
    if (!entry.runId) continue;
    const card = cards.get(taskId);
    for (const snapshot of Object.values(entry.helpers)) {
      const key = `${entry.runId}:${snapshot.id}`;
      const json = JSON.stringify(snapshot);
      const known = seen.get(key);
      const server = byKey.get(key);
      // First sight keeps the server's date; later changes are dated now.
      const at = known ? (known.json === json ? known.at : nowIso) : (server?.lastActivityAt ?? nowIso);
      seen.set(key, { json, at });
      if (!server && !card) continue;
      liveKeys.add(key);
      const dot = snapshot.id.lastIndexOf(".");
      byKey.set(key, {
        key,
        runId: entry.runId,
        taskId,
        boardId: server?.boardId ?? card?.boardId ?? "",
        boardName: server?.boardName ?? card?.boardName ?? "",
        taskTitle: server?.taskTitle ?? card?.title ?? taskId,
        runStatus: "running",
        parentId: dot > 0 ? snapshot.id.slice(0, dot) : null,
        snapshot,
        startedAt: server?.startedAt ?? nowIso,
        lastActivityAt: at,
      });
    }
  }
  return { agents: [...byKey.values()], liveKeys };
}

/**
 * Tool calls the live agents started since `prev` (agent key → tool call last seen), as activity
 * lines, plus the new `prev`. The server cannot log these: only status changes are persisted.
 */
export function toolActivity(
  prev: ReadonlyMap<string, string>,
  agents: readonly AgentHubAgent[],
  liveKeys: ReadonlySet<string>,
  atIso: string,
): { next: Map<string, string>; lines: AgentHubActivity[] } {
  const next = new Map<string, string>();
  const lines: AgentHubActivity[] = [];
  for (const agent of agents) {
    if (!liveKeys.has(agent.key)) continue;
    const { currentTool, currentToolDetail } = agent.snapshot;
    if (!currentTool) continue;
    const call = currentToolDetail ? `${currentTool}: ${currentToolDetail}` : currentTool;
    next.set(agent.key, call);
    if (prev.get(agent.key) === call) continue;
    lines.push({
      id: `${agent.key}:tool:${atIso}:${lines.length}`,
      at: atIso,
      agentKey: agent.key,
      agentId: agent.snapshot.id,
      kind: "tool",
      text: call,
    });
  }
  return { next, lines };
}

/** Agents matching `query` on id, description, agent type, model or card title. */
export function filterAgents(agents: readonly AgentHubAgent[], query: string): AgentHubAgent[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...agents];
  return agents.filter(({ snapshot, taskTitle }) =>
    [snapshot.id, snapshot.description, snapshot.agent, snapshot.model, taskTitle].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

export function compareAgents(a: AgentHubAgent, b: AgentHubAgent): number {
  return (
    STATUS_RANK[a.snapshot.status] - STATUS_RANK[b.snapshot.status] ||
    b.lastActivityAt.localeCompare(a.lastActivityAt) ||
    a.snapshot.id.localeCompare(b.snapshot.id)
  );
}

export interface HubRow {
  agent: AgentHubAgent;
  /** Nesting under its spawning subagent (tree view); 0 in the flat view. */
  depth: number;
}

export interface HubGroup {
  runId: string;
  taskId: string;
  boardId: string;
  boardName: string;
  title: string;
  rows: HubRow[];
}

/** The flat roster in operational order. */
export function flatRows(agents: readonly AgentHubAgent[]): HubRow[] {
  return [...agents].sort(compareAgents).map((agent) => ({ agent, depth: 0 }));
}

/**
 * The tree: one group per run (the card, its parent), subagents nested under the subagent that
 * spawned them. A subagent whose spawner is not in `agents` (filtered out) sits at the top.
 * Groups with the most urgent agent first.
 */
export function treeGroups(agents: readonly AgentHubAgent[]): HubGroup[] {
  const byRun = new Map<string, AgentHubAgent[]>();
  for (const agent of agents) {
    const list = byRun.get(agent.runId);
    if (list) list.push(agent);
    else byRun.set(agent.runId, [agent]);
  }
  const groups: HubGroup[] = [];
  for (const list of byRun.values()) {
    const ids = new Set(list.map((agent) => agent.snapshot.id));
    const children = new Map<string | null, AgentHubAgent[]>();
    for (const agent of list) {
      const parent = agent.parentId !== null && ids.has(agent.parentId) ? agent.parentId : null;
      const siblings = children.get(parent);
      if (siblings) siblings.push(agent);
      else children.set(parent, [agent]);
    }
    const rows: HubRow[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const agent of (children.get(parent) ?? []).sort(compareAgents)) {
        rows.push({ agent, depth });
        walk(agent.snapshot.id, depth + 1);
      }
    };
    walk(null, 0);
    const [first] = list;
    groups.push({
      runId: first.runId,
      taskId: first.taskId,
      boardId: first.boardId,
      boardName: first.boardName,
      title: first.taskTitle,
      rows,
    });
  }
  return groups.sort((a, b) => compareAgents(a.rows[0].agent, b.rows[0].agent));
}

/** Direct children of `agent` among `agents`. */
export function childrenOf(agents: readonly AgentHubAgent[], agent: AgentHubAgent): AgentHubAgent[] {
  return agents.filter((other) => other.runId === agent.runId && other.parentId === agent.snapshot.id).sort(compareAgents);
}

/** Keys of `agent` and every subagent below it. */
export function subtreeKeys(agents: readonly AgentHubAgent[], agent: AgentHubAgent): Set<string> {
  const prefix = `${agent.snapshot.id}.`;
  const keys = new Set([agent.key]);
  for (const other of agents) {
    if (other.runId === agent.runId && other.snapshot.id.startsWith(prefix)) keys.add(other.key);
  }
  return keys;
}

export interface HubTotals {
  counts: Record<SubagentStatus, number>;
  cost: number;
  tokens: number;
  requests: number;
  toolCalls: number;
  durationMs: number;
  /** Agents that reported usage; the rest read "—" in their row. */
  measured: number;
}

/** Status counts and usage summed across `agents` (only those that reported a figure add to it). */
export function totals(agents: readonly AgentHubAgent[]): HubTotals {
  const sum: HubTotals = {
    counts: { running: 0, pending: 0, completed: 0, failed: 0, aborted: 0 },
    cost: 0,
    tokens: 0,
    requests: 0,
    toolCalls: 0,
    durationMs: 0,
    measured: 0,
  };
  for (const { snapshot: s } of agents) {
    sum.counts[s.status] += 1;
    sum.cost += s.cost ?? 0;
    sum.tokens += s.tokens ?? 0;
    sum.requests += s.requests ?? 0;
    sum.toolCalls += s.toolCount ?? 0;
    sum.durationMs += s.durationMs ?? 0;
    if (hasUsage(s)) sum.measured += 1;
  }
  return sum;
}

/** True when omp reported any usage figure for the subagent. */
export function hasUsage(s: SubagentSnapshot): boolean {
  return [s.cost, s.tokens, s.requests, s.toolCount, s.durationMs].some((value) => value !== undefined);
}

export const ACTIVITY_FILTERS: readonly { id: "all" | "errors" | "responses" | "tools"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "errors", label: "Errors" },
  { id: "responses", label: "Responses" },
  { id: "tools", label: "Tools" },
];

export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]["id"];

const FILTER_KINDS: Record<ActivityFilter, readonly AgentHubActivityKind[] | null> = {
  all: null,
  errors: ["error"],
  responses: ["response"],
  tools: ["tool"],
};

/** Activity lines of the kind `filter` allows, matching `query`, within `scope` (null = every agent). */
export function filterActivity(
  lines: readonly AgentHubActivity[],
  filter: ActivityFilter,
  query: string,
  scope: ReadonlySet<string> | null,
): AgentHubActivity[] {
  const kinds = FILTER_KINDS[filter];
  const needle = query.trim().toLowerCase();
  return lines.filter(
    (line) =>
      (!kinds || kinds.includes(line.kind)) &&
      (!scope || scope.has(line.agentKey)) &&
      (!needle || line.text.toLowerCase().includes(needle) || line.agentId.toLowerCase().includes(needle)),
  );
}
