import { buildRunArgs, jobResponse, runContainer } from "@/lib/docker";
import { readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** `docker run -d` from a `RunContainerSpec` (pulls when missing). Streams NDJSON `DockerJobEvent`s. */
export const POST = withApi(async ({ req }) => {
  const { args } = buildRunArgs(await readJson(req));
  return jobResponse((send) => runContainer(args, send));
}, { admin: true });
