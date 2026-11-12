// New cards from free text. The card exists the moment the user creates it: in In progress with
// its run queued, titled from the text as typed. The card writer (lib/agent/draft.ts) turns the
// text into its title and brief in the background (the run is held meanwhile), then the run
// starts. The user never waits for it and can keep adding cards.
import { draftCard } from "@/lib/agent/draft";
import type { AgentManager } from "@/lib/agent/types";
import {
  ATTACH_BRIEF_MIN,
  BRIEF_FILE,
  type CardFields,
  draftToCard,
  fallbackDraft,
  isPlainTitle,
} from "@/lib/card-draft";
import type { Repository } from "@/lib/db/types";
import { publish } from "@/lib/events";
import { writeTextFile } from "@/lib/files";
import { getAppSettings } from "@/lib/settings";
import type { Board, Task } from "@/lib/types";

/**
 * Create a card from `text` and start its agent. A short single line is the title as typed and
 * starts right away; anything longer starts once the card writer has written the card. Its
 * failure leaves the text as typed (noted on the card); a title or description the user edits
 * meanwhile is kept.
 */
export async function createCardFromText(input: {
  repo: Repository;
  manager: AgentManager;
  board: Board;
  text: string;
  position?: number;
}): Promise<Task> {
  const { repo, manager, board, position } = input;
  const text = input.text.trim();
  if (isPlainTitle(text)) {
    const task = await repo.createTask({ boardId: board.id, title: text, status: "in_progress", position });
    publish({ type: "task.updated", task });
    return manager.start(task.id);
  }

  const attached = text.length >= ATTACH_BRIEF_MIN;
  const typed = draftToCard(fallbackDraft(text), attached);
  const task = await repo.createTask({
    boardId: board.id,
    title: typed.title,
    description: typed.description,
    status: "in_progress",
    position,
  });
  if (attached) {
    try {
      await writeTextFile("tasks", task.id, BRIEF_FILE, `${text}\n`);
    } catch (err) {
      await repo.deleteTask(task.id);
      throw err;
    }
  }
  publish({ type: "task.updated", task });
  return manager.startPrepared(task.id, (signal) => writeCard({ repo, board, task, text, attached, signal }));
}

/** Run the card writer on the card's text and apply what it wrote to the fields the user left alone. */
async function writeCard(input: {
  repo: Repository;
  board: Board;
  /** The card as created from the text as typed. */
  task: Task;
  text: string;
  attached: boolean;
  signal: AbortSignal;
}): Promise<void> {
  const { repo, board, task, text, attached, signal } = input;
  const [settings, tasks] = await Promise.all([getAppSettings(repo), repo.listTasks(board.id)]);
  let written: CardFields;
  try {
    const { draft } = await draftCard({
      text,
      board,
      tasks: tasks.filter((t) => t.id !== task.id),
      settings,
      signal,
      onActivity: (line) => publish({ type: "task.activity", taskId: task.id, boardId: board.id, text: line }),
    });
    written = draftToCard(draft, attached);
  } catch (err) {
    if (signal.aborted) return;
    const reason = err instanceof Error ? err.message : String(err);
    const comment = await repo.addComment({
      taskId: task.id,
      author: "agent",
      body: `The card agent couldn't write this card (${reason}). The agent works from your text as typed.`,
      resolved: true,
    });
    publish({ type: "comment.added", comment, boardId: board.id });
    return;
  }
  if (signal.aborted) return;
  const current = await repo.getTask(task.id);
  if (!current) return;
  const updated = await repo.updateTask(task.id, {
    ...(current.title === task.title ? { title: written.title } : {}),
    ...(current.description === task.description ? { description: written.description } : {}),
    blockedBy: [...new Set([...current.blockedBy, ...written.blockedBy])],
  });
  if (updated) publish({ type: "task.updated", task: updated });
}
