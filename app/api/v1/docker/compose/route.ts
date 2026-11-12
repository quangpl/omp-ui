import { deployCompose, jobResponse, parseComposeDeploy } from "@/lib/docker";
import { readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Create or redeploy an OMP UI compose project `{ name, yaml, env? }`: writes
 * DATA_DIR/compose/<name>/compose.yaml (+ .env), validates it, then `up -d`. Streams NDJSON.
 */
export const POST = withApi(async ({ req }) => {
  const spec = await parseComposeDeploy(await readJson(req));
  return jobResponse((send) => deployCompose(spec, send));
});
