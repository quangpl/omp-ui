import { execFile } from "node:child_process";
import { childEnv } from "@/lib/child-env";
import { json, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";
import type { OmpSkill } from "@/lib/types";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 60_000;

const g = globalThis as unknown as {
  __ompUiSkills?: { path: string; at: number; skills: Promise<OmpSkill[]> };
};

/** One entry of `omp skill list --json`, narrowed at runtime; null when it isn't a skill. */
function parseSkill(entry: unknown): OmpSkill | null {
  if (!entry || typeof entry !== "object") return null;
  const name = "name" in entry && typeof entry.name === "string" ? entry.name : null;
  if (!name) return null;
  if ("hide" in entry && entry.hide === true) return null;
  const description =
    "description" in entry && typeof entry.description === "string" ? entry.description : "";
  const source = "source" in entry && typeof entry.source === "string" ? entry.source : "";
  return { name, description, source };
}

/** `omp skill list --json` output → skills: `{ skills: [{ name, description, hide, … }] }`. */
function parseSkillList(output: string): OmpSkill[] {
  const start = output.indexOf("{");
  if (start === -1) return [];
  let data: unknown;
  try {
    data = JSON.parse(output.slice(start));
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || !("skills" in data) || !Array.isArray(data.skills)) {
    return [];
  }
  return data.skills.map(parseSkill).filter((skill): skill is OmpSkill => skill !== null);
}

/** Installed omp skills; empty when omp is missing or `skill list` fails. */
function listSkills(ompPath: string): Promise<OmpSkill[]> {
  const { promise, resolve } = Promise.withResolvers<OmpSkill[]>();
  execFile(
    ompPath,
    ["skill", "list", "--json"],
    { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: childEnv(), windowsHide: true },
    (err, stdout) => resolve(err ? [] : parseSkillList(stdout)),
  );
  return promise;
}

/** The omp skills a card can pick with "/" in the composer (cached for a minute). */
export const GET = withApi(async ({ req, repo }) => {
  const { ompPath } = await getAppSettings(repo);
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const cached = g.__ompUiSkills;
  if (refresh || !cached || cached.path !== ompPath || Date.now() - cached.at > CACHE_TTL_MS) {
    g.__ompUiSkills = { path: ompPath, at: Date.now(), skills: listSkills(ompPath) };
  }
  return json({ skills: await g.__ompUiSkills!.skills });
});
