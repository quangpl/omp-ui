// Server-side aggregate for the home dashboard (GET /api/v1/dashboard).
import type { AgentManager } from "@/lib/agent/types";
import type { Repository } from "@/lib/db/types";
import type {
  AttentionReason,
  Dashboard,
  DashboardBoard,
  DashboardCard,
  Task,
  TaskStatus,
} from "@/lib/types";

const ATTENTION_LIMIT = 12;
const FINISHED_LIMIT = 6;

/** Why `task` needs the user, or null when it doesn't. */
export function attentionReason(task: Task): AttentionReason | null {
  if (task.agentState === "error") return "failed";
  if (task.status === "in_progress" && task.agentState === "idle") return "stalled";
  return null;
}

function toCard(task: Task, boardName: string): DashboardCard {
  return {
    id: task.id,
    boardId: task.boardId,
    boardName,
    title: task.title,
    status: task.status,
    agentState: task.agentState,
    agentError: task.agentError,
    commentCount: task.commentCount,
    openCommentCount: task.openCommentCount,
    lastRunId: task.lastRunId,
    updatedAt: task.updatedAt,
  };
}

const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) =>
  b.updatedAt.localeCompare(a.updatedAt);

export async function buildDashboard(repo: Repository, manager: AgentManager): Promise<Dashboard> {
  const [boards, queue] = await Promise.all([repo.listBoards(), manager.queueSnapshot()]);
  const tasksByBoard = await Promise.all(boards.map((board) => repo.listTasks(board.id)));

  const totals: Record<TaskStatus, number> = { todo: 0, in_progress: 0, done: 0 };
  const failed: (DashboardCard & { reason: AttentionReason })[] = [];
  const stalled: (DashboardCard & { reason: AttentionReason })[] = [];
  const finished: DashboardCard[] = [];
  const setup = { hasCard: false, hasRun: false, hasDone: false };

  const dashboardBoards: DashboardBoard[] = boards.map((board, i) => {
    let lastActivityAt = board.updatedAt;
    let attentionCount = 0;
    for (const task of tasksByBoard[i]) {
      totals[task.status] += 1;
      setup.hasCard = true;
      if (task.lastRunId) setup.hasRun = true;
      if (task.status === "done") setup.hasDone = true;
      if (task.updatedAt > lastActivityAt) lastActivityAt = task.updatedAt;
      const reason = attentionReason(task);
      if (reason) {
        attentionCount += 1;
        (reason === "failed" ? failed : stalled).push({ ...toCard(task, board.name), reason });
      } else if (task.status === "done" && task.lastRunId) {
        finished.push(toCard(task, board.name));
      }
    }
    return { ...board, lastActivityAt, attentionCount };
  });

  dashboardBoards.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  return {
    generatedAt: new Date().toISOString(),
    boards: dashboardBoards,
    totals,
    attention: [...failed.sort(newestFirst), ...stalled.sort(newestFirst)].slice(0, ATTENTION_LIMIT),
    finished: finished.sort(newestFirst).slice(0, FINISHED_LIMIT),
    queue,
    setup,
  };
}
