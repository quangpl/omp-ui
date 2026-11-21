import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TaskDiff } from "@/lib/diff-types";
import { diffSummary } from "@/lib/server/diff-summary";
import type { AppSettings, Board } from "@/lib/types";

const { runOmpHelper } = vi.hoisted(() => ({
  runOmpHelper: vi.fn(async () => {
    throw new Error("the summary agent must not run");
  }),
}));
vi.mock("@/lib/agent/omp-helper", () => ({ runOmpHelper, isDirectory: async () => true }));

const diff: TaskDiff = {
  taskId: "t1",
  repos: [],
  stats: { files: 2, additions: 10, deletions: 3 },
  truncated: false,
  hash: "diff-summary-test-hash",
  generatedAt: "2026-01-01T00:00:00.000Z",
};
const context = { board: {} as Board, task: { title: "Add paging" }, settings: {} as AppSettings };

let dir: string;
const previous = process.env.DATA_DIR;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "diff-summary-"));
  process.env.DATA_DIR = dir;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("diffSummary", () => {
  it("reading a diff without a cached summary answers the file-count line and starts no agent", async () => {
    const answer = await diffSummary(diff, context, { waitMs: 50 });

    expect(answer).toMatchObject({ source: "fallback", pending: false, error: null, hash: diff.hash });
    expect(answer.text).toMatch(/^2 files changed \(\+10 −3\)/);
    expect(runOmpHelper).not.toHaveBeenCalled();
  });

  it("answers a cached summary without starting an agent", async () => {
    const folder = path.join(dir, "runtime", "diff-summaries");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${diff.hash}.json`), JSON.stringify({ text: "Adds paging.", createdAt: "x" }));

    const answer = await diffSummary(diff, context);

    expect(answer).toMatchObject({ text: "Adds paging.", source: "model", pending: false });
    expect(runOmpHelper).not.toHaveBeenCalled();
  });
});
