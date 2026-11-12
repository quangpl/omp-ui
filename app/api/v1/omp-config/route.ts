import { HttpError, json, readJson, withApi } from "@/lib/server/http";
import { getOmpConfig, updateOmpConfigRaw, updateOmpConfigValues } from "@/lib/server/omp-config";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** omp's user config.yml: path, raw text, the structured form's values, omp's defaults and the field schema. */
export const GET = withApi(async ({ repo }) => {
  const { ompPath } = await getAppSettings(repo);
  return json(await getOmpConfig(ompPath));
});

/** `{ values }` (null unsets a key) or `{ raw }` (whole file); optional `version` guards against overwriting newer edits. */
export const PUT = withApi(async ({ req, repo }) => {
  const body = await readJson(req);
  const hasValues = body.values !== undefined;
  const hasRaw = body.raw !== undefined;
  if (hasValues === hasRaw) throw new HttpError(400, "Send either values or raw");
  const { ompPath } = await getAppSettings(repo);
  if (hasRaw) return json(await updateOmpConfigRaw(ompPath, body.raw, body.version));
  const values = body.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new HttpError(400, "values must be an object of setting keys");
  }
  return json(await updateOmpConfigValues(ompPath, values as Record<string, unknown>, body.version));
});
