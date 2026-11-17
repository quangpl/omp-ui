// Installed omp skills, from `omp skill list --json`: offered with "/" in the composer. Listing
// spawns omp, so results are cached for a minute.
import { execFile } from "node:child_process";
import { childEnv } from "@/lib/child-env";
import type { OmpSkill } from "@/lib/types";

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

/** Runs `omp skill list --json`; empty when omp is missing or the command fails. */
function runSkillList(ompPath: string): Promise<OmpSkill[]> {
  const { promise, resolve } = Promise.withResolvers<OmpSkill[]>();
  execFile(
    ompPath,
    ["skill", "list", "--json"],
    { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: childEnv(), windowsHide: true },
    (err, stdout) => resolve(err ? [] : parseSkillList(stdout)),
  );
  return promise;
}

/**
 * Installed, non-hidden omp skills (cached for a minute per omp path; `refresh` re-lists).
 * Never rejects: empty when omp is missing or `skill list` fails.
 */
export function listOmpSkills(ompPath: string, options: { refresh?: boolean } = {}): Promise<OmpSkill[]> {
  const cached = g.__ompUiSkills;
  if (options.refresh || !cached || cached.path !== ompPath || Date.now() - cached.at > CACHE_TTL_MS) {
    g.__ompUiSkills = { path: ompPath, at: Date.now(), skills: runSkillList(ompPath) };
  }
  return g.__ompUiSkills!.skills;
}
