// New cards from free text. The card exists the moment the user creates it: in In progress with
// its run started, titled from the text as typed (lib/card-draft.ts). The user never waits and
// can keep adding cards.
import type { AgentManager } from "@/lib/agent/types";
import { BRIEF_FILE, cardFromText } from "@/lib/card-draft";
import type { Repository } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { writeTextFile } from "@/lib/files";
import type { Board, Task } from "@/lib/types";

/**
 * Create a card from `text` and start its agent. A text too long for the description is kept
 * whole as `BRIEF_FILE` among the card's files; if that write fails the card is removed again.
 */
export async function createCardFromText(input: {
  repo: Repository;
  manager: AgentManager;
  board: Board;
  text: string;
  position?: number;
  /** Scheduler whose run creates this card (lib/scheduler.ts); default null. */
  schedulerId?: string | null;
  /** Whether the card's runs start omp without agentmemory; default false. */
  ignoreMemory?: boolean;
}): Promise<Task> {
  const { repo, manager, board, position } = input;
  const text = input.text.trim();
  const card = cardFromText(text);
  const task = await repo.createTask({
    boardId: board.id,
    title: card.title,
    description: card.description,
    status: "in_progress",
    position,
    schedulerId: input.schedulerId ?? null,
    ignoreMemory: input.ignoreMemory ?? false,
  });
  if (card.attached) {
    try {
      await writeTextFile("tasks", task.id, BRIEF_FILE, `${text}\n`);
    } catch (err) {
      await repo.deleteTask(task.id);
      throw err;
    }
  }
  publish({ type: "task.updated", task });
  return manager.start(task.id);
}
