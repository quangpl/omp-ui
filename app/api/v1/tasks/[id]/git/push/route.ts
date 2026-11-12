import { runTaskGitAction } from "@/lib/server/git-actions";
import { withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Commit the task's changes and push straight to each repo's default branch. */
export const POST = withApi<{ id: string }>((ctx) => runTaskGitAction(ctx, "push"));
