import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as resultsRoute from "@/app/api/v1/artifacts/[boardId]/route";
import * as projectsRoute from "@/app/api/v1/artifacts/route";
import { getRepo } from "@/lib/db";
import { resolveFile, writeTextFile } from "@/lib/files";
import type { ArtifactProject, ArtifactProjectResults, Task } from "@/lib/types";

const MARCH = "2026-03-10T10:00:00.000Z";
const FEBRUARY = "2026-02-01T09:00:00.000Z";
const APRIL = "2026-04-01T08:00:00.000Z";
const MAY = "2026-05-01T00:00:00.000Z";

let alpha: string;
let beta: string;
let report: Task;
let fallback: Task;
let reportSummary: string;
let reportRunId: string;
let fallbackRunId: string;

async function finishRun(task: Task, status: "succeeded" | "failed", summary: string | null, endedAt: string) {
  const repo = await getRepo();
  const run = await repo.createRun({ taskId: task.id, prompt: "work" });
  await repo.updateRun(run.id, { status, summary, endedAt, error: status === "failed" ? "boom" : null });
  return run.id;
}

function query(period: { from?: string; to?: string }): string {
  const qs = new URLSearchParams(period).toString();
  return qs ? `?${qs}` : "";
}

async function projects(period: { from?: string; to?: string } = {}): Promise<ArtifactProject[]> {
  const res = await api<ArtifactProject[]>(projectsRoute, "GET", `/artifacts${query(period)}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function results(boardId: string, period: { from?: string; to?: string } = {}): Promise<ArtifactProjectResults> {
  const res = await api<ArtifactProjectResults>(resultsRoute, "GET", `/artifacts/${boardId}${query(period)}`, {
    params: { boardId },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

afterAll(teardown);

describe("/artifacts", () => {
  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    const repo = await getRepo();

    const alphaBoard = await repo.createBoard({ name: "Alpha", workdir: tempDir("alpha"), autoRun: false });
    const betaBoard = await repo.createBoard({ name: "Beta", workdir: tempDir("beta"), autoRun: false });
    await repo.createBoard({ name: "Gamma", workdir: tempDir("gamma"), autoRun: false });
    const zeta = await repo.createBoard({ name: "Zeta", workdir: tempDir("zeta"), autoRun: false });
    await repo.updateBoard(zeta.id, { pinned: true });
    alpha = alphaBoard.id;
    beta = betaBoard.id;

    report = await repo.createTask({ boardId: alpha, title: "Write the report" });
    fallback = await repo.createTask({ boardId: alpha, title: "Retry after failure" });
    const neverSucceeded = await repo.createTask({ boardId: alpha, title: "Only failures" });
    const blankSummary = await repo.createTask({ boardId: alpha, title: "Empty summary" });
    await repo.createTask({ boardId: alpha, title: "Never run" });
    const betaTask = await repo.createTask({ boardId: beta, title: "Beta result" });

    // Shared files: only those linked from the final summary are artifacts.
    await writeTextFile("tasks", report.id, "report.md", "# Report\n");
    const chart = resolveFile("tasks", report.id, "charts/chart 1.png");
    await fs.mkdir(path.dirname(chart), { recursive: true });
    await fs.writeFile(chart, "png-bytes");
    await writeTextFile("tasks", report.id, "wip.png", "work in progress");
    await writeTextFile("tasks", report.id, "notes.md", "scratch notes");
    await writeTextFile("tasks", fallback.id, "t2.md", "fallback deliverable");

    const own = `/api/v1/tasks/${report.id}/files`;
    reportSummary = [
      "Did the work.",
      "",
      "## Report",
      "",
      `- Full report: [report.md](${own}/report.md)`,
      `- ![chart](${own}/charts/chart%201.png)`,
      `- Download again: ${own}/report.md?download=1`,
      `- Related: [their file](/api/v1/tasks/${fallback.id}/files/t2.md)`,
      `- Gone: [old.pdf](${own}/old.pdf)`,
      `- Escape: [secret](${own}/../secret.txt)`,
      "",
      `\`${own}/notes.md\``,
    ].join("\n");
    reportRunId = await finishRun(report, "succeeded", reportSummary, MARCH);

    fallbackRunId = await finishRun(
      fallback,
      "succeeded",
      `Done: [t2.md](/api/v1/tasks/${fallback.id}/files/t2.md)`,
      FEBRUARY,
    );
    const failedId = await finishRun(fallback, "failed", null, APRIL);
    await repo.updateTask(fallback.id, { lastRunId: failedId });

    await finishRun(neverSucceeded, "failed", null, MARCH);
    await finishRun(blankSummary, "succeeded", "   ", MARCH);
    await finishRun(betaTask, "succeeded", "No files this time.", MAY);
  });

  it("lists every project, those with results first, then pinned, then by name", async () => {
    const list = await projects();
    expect(list.map((p) => p.name)).toEqual(["Beta", "Alpha", "Zeta", "Gamma"]);
    const [b, a, z, g] = list;
    expect(b).toMatchObject({ boardId: beta, resultCount: 1, attachmentCount: 0, latestAt: MAY, pinned: false });
    expect(a).toMatchObject({ boardId: alpha, resultCount: 2, attachmentCount: 4, latestAt: MARCH });
    expect(typeof a.workdir).toBe("string");
    expect(z).toMatchObject({ resultCount: 0, attachmentCount: 0, latestAt: null, pinned: true });
    expect(g).toMatchObject({ resultCount: 0, attachmentCount: 0, latestAt: null, pinned: false });
  });

  it("returns final results newest first with only the card's own linked files", async () => {
    const body = await results(alpha);
    expect(body.board).toEqual({ id: alpha, name: "Alpha", workdir: expect.any(String) });
    expect(body.results.map((r) => r.taskId)).toEqual([report.id, fallback.id]);

    const [first, second] = body.results;
    expect(first).toMatchObject({
      taskId: report.id,
      boardId: alpha,
      title: "Write the report",
      status: report.status,
      runId: reportRunId,
      summary: reportSummary,
      finishedAt: MARCH,
    });
    // Unlinked (wip.png), code-only (notes.md), another card's and escaping paths are excluded;
    // the repeated report.md link counts once; a deleted file stays with null size.
    expect(first.attachments.map(({ name, url, size }) => ({ name, url, size }))).toEqual([
      { name: "report.md", url: `/api/v1/tasks/${report.id}/files/report.md`, size: 9 },
      { name: "charts/chart 1.png", url: `/api/v1/tasks/${report.id}/files/charts/chart%201.png`, size: 9 },
      { name: "old.pdf", url: `/api/v1/tasks/${report.id}/files/old.pdf`, size: null },
    ]);
    expect(first.attachments[0].modifiedAt).toEqual(expect.any(String));
    expect(first.attachments[2].modifiedAt).toBeNull();

    // A failed latest run falls back to the previous succeeded one.
    expect(second).toMatchObject({ taskId: fallback.id, runId: fallbackRunId, finishedAt: FEBRUARY });
    expect(second.attachments.map((f) => f.name)).toEqual(["t2.md"]);
  });

  it("filters by the final run's end time (from inclusive, to exclusive)", async () => {
    const march = { from: "2026-03-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" };
    const list = await projects(march);
    expect(list.map((p) => p.name)).toEqual(["Alpha", "Zeta", "Beta", "Gamma"]);
    expect(list[0]).toMatchObject({ resultCount: 1, attachmentCount: 3, latestAt: MARCH });
    expect(list[2]).toMatchObject({ resultCount: 0, attachmentCount: 0, latestAt: null });
    expect((await results(alpha, march)).results.map((r) => r.taskId)).toEqual([report.id]);

    // The fallback card's failed April run does not move it into April.
    expect((await results(alpha, { from: APRIL })).results).toEqual([]);
    expect((await results(alpha, { from: MARCH })).results.map((r) => r.taskId)).toEqual([report.id]);
    expect((await results(alpha, { to: MARCH })).results.map((r) => r.taskId)).toEqual([fallback.id]);
    expect((await results(beta, { to: MAY })).results).toEqual([]);
  });

  it("rejects an invalid period", async () => {
    const list = await api(projectsRoute, "GET", "/artifacts?from=not-a-date");
    expect(list.status).toBe(400);
    const one = await api(resultsRoute, "GET", `/artifacts/${alpha}?to=nope`, { params: { boardId: alpha } });
    expect(one.status).toBe(400);
  });

  it("answers 404 for an unknown project", async () => {
    const res = await api(resultsRoute, "GET", "/artifacts/missing-board", { params: { boardId: "missing-board" } });
    expect(res.status).toBe(404);
  });
});
