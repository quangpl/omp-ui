import { runTaskGitAction } from "@/lib/server/git-actions";
import { withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Commit the task's changes to a new branch, push it, and open a PR (GitHub) / MR (GitLab). */
export const POST = withApi<{ id: string }>((ctx) => runTaskGitAction(ctx, "pr"));
