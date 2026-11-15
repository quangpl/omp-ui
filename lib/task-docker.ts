// Names for the Docker resources an agent starts only for one card's task (docs/TASK-CLEANUP.md). The
// agent marks them with these names, so AgentMan can remove what is left when the card moves to Done or
// is deleted without touching containers of the user or of other cards.

/** Label on containers, images, volumes and networks an agent created for a card; the value is the card id. */
export const TASK_DOCKER_LABEL = "agentman.task";

/** Compose project name for a card's temporary stacks (compose labels their resources with it). */
export function taskComposeProject(taskId: string): string {
  return `task-${taskId.toLowerCase().replace(/[^a-z0-9_-]/g, "")}`;
}

/** What `removeTaskDockerResources` removed, plus one message per resource it could not remove. */
export interface TaskDockerCleanup {
  containers: number;
  networks: number;
  volumes: number;
  images: number;
  errors: string[];
}
