import { jobResponse, parseQuickRun, quickRun } from "@/lib/docker";
import { readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * `docker run -d` with smart defaults from a `QuickRunSpec`: pulls when missing, publishes the
 * image's EXPOSEd ports (or the given ones) on free host ports, picks an unused name. Streams
 * NDJSON `DockerJobEvent`s; `done.id` is the container id.
 */
export const POST = withApi(async ({ req }) => {
  const plan = parseQuickRun(await readJson(req));
  return jobResponse((send) => quickRun(plan, send));
}, { admin: true });
