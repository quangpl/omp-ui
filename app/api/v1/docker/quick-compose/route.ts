import { jobResponse, parseQuickCompose, quickCompose } from "@/lib/docker";
import { readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * One-click compose `up` from a `QuickComposeSpec` (template id, pasted YAML or URL) into a new
 * AgentMan project with a free name; busy host ports move to free ones. Streams NDJSON
 * `DockerJobEvent`s; `done.id` is the project name.
 */
export const POST = withApi(async ({ req }) => {
  const plan = parseQuickCompose(await readJson(req));
  return jobResponse((send) => quickCompose(plan, send));
});
