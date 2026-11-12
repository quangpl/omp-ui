import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, call, env, freshEnv, readOmpLog, setupAdmin, teardown, tempDir, waitFor } from "./helpers";

import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as draftRoute from "@/app/api/v1/boards/[id]/tasks/draft/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import type { Board, DraftStreamEvent, Task } from "@/lib/types";

let board: Board;
let blocker: Task;

beforeAll(async () => {
  await freshEnv({ FAKE_OMP_MODEL_ROLES: JSON.stringify({ smol: "fake/fast-model" }) });
  await setupAdmin();
  const res = await api<Board>(boardsRoute, "POST", "/boards", {
    body: { name: "Shop", workdir: tempDir("shop"), autoRun: false },
  });
  board = res.body;
  blocker = (
    await api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
      body: { title: "Build the API" },
      params: { id: board.id },
    })
  ).body;
});

afterAll(async () => {
  delete process.env.FAKE_OMP_MODEL_ROLES;
  await teardown();
});

function postDraft(text: unknown, signal?: AbortSignal): Promise<Response> {
  return call(draftRoute, "POST", `/boards/${board.id}/tasks/draft`, {
    body: { text },
    params: { id: board.id },
    signal,
  });
}

/** Every NDJSON event of a finished draft stream. */
async function events(res: Response): Promise<DraftStreamEvent[]> {
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DraftStreamEvent);
}

/** Card writer processes, oldest first: their argv and the prompt they were sent. */
function cardWriterRuns(): { pid: number; argv: string[]; prompt: string; steers: string[] }[] {
  const log = readOmpLog();
  return log
    .filter((e) => e.kind === "command" && e.command?.type === "prompt" && String(e.command.message).startsWith("You are the card writer"))
    .map((e) => ({
      pid: e.pid,
      argv: log.find((a) => a.kind === "argv" && a.pid === e.pid)?.argv ?? [],
      prompt: String(e.command?.message),
      steers: log.filter((s) => s.kind === "steer" && s.pid === e.pid).map((s) => s.message ?? ""),
    }));
}

describe("POST /boards/:id/tasks/draft", () => {
  it("streams the card agent's progress, then the card it wrote from the free text", async () => {
    const text = [
      "the cart page overflows on phones",
      `do it after ${blocker.id} is done, in parallel where you can`,
    ].join("\n");
    const res = await postDraft(text);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const all = await events(res);
    expect(all.slice(0, -1).map((e) => e.type)).toEqual(["activity", "activity"]);
    expect(all[0]).toEqual({ type: "activity", text: "Card agent started (@smol)" });
    expect(all[1]).toEqual({ type: "activity", text: "Finding the files involved" });
    expect(all.at(-1)).toEqual({
      type: "draft",
      model: "@smol",
      draft: {
        title: "the cart page overflows on phones",
        description: `## Goal\n\n${text}`,
        orchestrate: true,
        waitFor: [{ id: blocker.id, title: "Build the API" }],
      },
    });

    // A read-only omp in the project, over RPC, that sees the request and the open cards.
    const run = cardWriterRuns().at(-1);
    expect(run?.argv).toEqual(expect.arrayContaining(["--mode", "rpc", "--tools", "read,grep,glob", "--model", "@smol"]));
    expect(run?.argv[run.argv.indexOf("--cwd") + 1]).toBe(board.workdir);
    expect(run?.prompt).toContain(`<request>\n${text}\n</request>`);
    expect(run?.prompt).toContain(`- ${blocker.id} — To do — Build the API`);
    expect(run?.steers).toEqual([]);
  });

  it("steers a card agent that keeps looking around to answer with what it found", async () => {
    const all = await events(await postDraft("[fake-draft:lookaround] tidy the settings page\ngroup the toggles"));
    expect(all).toContainEqual({ type: "activity", text: "Enough looking around: writing the card…" });
    expect(all.at(-1)).toMatchObject({ type: "draft", draft: { title: "tidy the settings page" } });
    const run = cardWriterRuns().at(-1);
    expect(run?.steers).toHaveLength(1);
    expect(run?.steers[0]).toMatch(/Reply now with only the card JSON/);
    // The budget is 8 lookups; a few more may land while the steer is on its way.
    const lookups = all.filter((e) => e.type === "activity" && /^(Finding the files involved|Lookup \d+)$/.test(e.text));
    expect(lookups.length).toBeGreaterThanOrEqual(8);
    expect(lookups.length).toBeLessThan(20);
  });

  it("turns omp's own keyword into parallel subagents without passing it to the card agent", async () => {
    const all = await events(await postDraft("orchestrate: rework the board page\nsplit it up"));
    expect(all.at(-1)).toMatchObject({ type: "draft", draft: { orchestrate: true } });
    expect(cardWriterRuns().at(-1)?.prompt).toContain("<request>\nparallelize: rework the board page\nsplit it up\n</request>");
  });

  it("ends the stream with an error when the card agent fails", async () => {
    const all = await events(await postDraft("[fake-draft:fail] fix the login redirect\nit loops"));
    expect(all.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/card agent/i) });
  });

  it("hands a very long request over as a file and removes it afterwards", async () => {
    const text = `Rework the importer\n${"Keep every column exactly as it is today. ".repeat(2000)}`;
    expect(text.length).toBeGreaterThan(60_000);
    const all = await events(await postDraft(text));
    expect(all.at(-1)).toMatchObject({ type: "draft", draft: { title: "Rework the importer" } });

    const prompt = cardWriterRuns().at(-1)?.prompt ?? "";
    expect(prompt).not.toContain("<request>");
    const file = /is saved in (\S+?)\.(?=\s)/.exec(prompt)?.[1];
    expect(file?.startsWith(path.join(env().dataDir, "runtime", "drafts"))).toBe(true);
    expect(existsSync(file as string)).toBe(false);
  });

  it("stops the card agent when the client goes away", async () => {
    const before = cardWriterRuns().length;
    const abort = new AbortController();
    const res = await postDraft("[fake-draft:slow] rework the CSV importer\nkeep the old columns", abort.signal);
    const run = await waitFor(() => cardWriterRuns()[before]);
    expect(() => process.kill(run.pid, 0)).not.toThrow();
    abort.abort();
    await res.text().catch(() => undefined);
    await waitFor(() => {
      try {
        process.kill(run.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it("validates the text and the project", async () => {
    expect((await api(draftRoute, "POST", `/boards/${board.id}/tasks/draft`, { body: { text: "  " }, params: { id: board.id } })).status).toBe(400);
    expect((await api(draftRoute, "POST", `/boards/${board.id}/tasks/draft`, { body: {}, params: { id: board.id } })).status).toBe(400);
    expect((await api(draftRoute, "POST", "/boards/nope/tasks/draft", { body: { text: "x" }, params: { id: "nope" } })).status).toBe(404);
  });
});

describe("POST /boards/:id/tasks with brief", () => {
  it("saves the original text as brief.md and points the description to it", async () => {
    const brief = "word ".repeat(1000).trim();
    const res = await api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, {
      body: { title: "Long one", description: "## Goal\n\nDo it.", brief },
      params: { id: board.id },
    });
    expect(res.status).toBe(201);
    expect(res.body.description).toBe(
      "## Goal\n\nDo it.\n\nThe user's full original request, word for word, is in brief.md among this card's files.",
    );
    expect(readFileSync(path.join(env().dataDir, "files", "tasks", res.body.id, "brief.md"), "utf8")).toBe(`${brief}\n`);
  });
});
