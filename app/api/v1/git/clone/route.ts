import { cloneRepo } from "@/lib/git";
import { HttpError, json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
  return value.trim() || null;
}

/** Clone a repository into WORKSPACE_DIR/<name>. */
export const POST = withApi(async ({ req }) => {
  const body = await readJson(req);
  if (typeof body.url !== "string" || !body.url.trim()) {
    throw new HttpError(400, "Please enter the repository address to clone.");
  }
  const result = await cloneRepo({
    url: body.url,
    name: optionalString(body.name, "name"),
    branch: optionalString(body.branch, "branch"),
  });
  return json(result, { status: 201 });
});
