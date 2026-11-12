import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, env, freshEnv, readOmpLog, setupAdmin, teardown, tempDir, waitFor } from "./helpers";

import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import * as taskStopRoute from "@/app/api/v1/tasks/[id]/stop/route";
import * as queueRoute from "@/app/api/v1/queue/route";
import { BRIEF_NOTE, ORCHESTRATE_LINE } from "@/lib/card-draft";
import type { Board, Comment, QueueSnapshot, Task } from "@/lib/types";

let board: Board;
let blocker: Task;

beforeAll(async () => {
  await freshEnv({ FAKE_OMP_MODEL_ROLES: JSON.stringify({ smol: "fake/fast-model" }) });
  await setupAdmin();
  // autoRun off: cards from text start anyway.
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

function createFromText(body: Record<string, unknown>) {
  return api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, { body, params: { id: board.id } });
}

async function getCard(id: string): Promise<{ task: Task; comments: Comment[] }> {
  return (await api<{ task: Task; comments: Comment[] }>(taskRoute, "GET", `/tasks/${id}`, { params: { id } })).body;
}

async function queue(): Promise<QueueSnapshot> {
  return (await api<QueueSnapshot>(queueRoute, "GET", "/queue")).body;
}

/**
 * Card writer calls, oldest first: their worker's argv, the prompt and the steers it got. Workers
 * are pooled, so one pid may serve several calls; a call's steers are those before its worker's
 * next prompt.
 */
function cardWriterRuns(): { pid: number; argv: string[]; prompt: string; steers: string[]; index: number }[] {
  const log = readOmpLog();
  return log.flatMap((e, index) => {
    if (e.kind !== "helper" || !String(e.prompt).startsWith("You are the card writer")) return [];
    const next = log.findIndex((n, i) => i > index && n.kind === "helper" && n.pid === e.pid);
    const calls = log.slice(index + 1, next === -1 ? undefined : next);
    return [
      {
        pid: e.pid,
        argv: e.argv ?? [],
        prompt: String(e.prompt),
        steers: calls.filter((s) => s.kind === "steer" && s.pid === e.pid).map((s) => s.message ?? ""),
        index,
      },
    ];
  });
}

/** Card run prompts (not helper prompts), oldest first, with their log position. */
function cardRunPrompts(): { message: string; index: number }[] {
  return readOmpLog().flatMap((e, index) =>
    e.kind === "command" && e.command?.type === "prompt" ? [{ message: String(e.command.message ?? ""), index }] : [],
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("POST /boards/:id/tasks with text", () => {
  it("creates the card in In progress right away, then writes it in the background, holding the run", async () => {
    const text = ["the cart page overflows on phones", `do it after ${blocker.id} is done, in parallel where you can`].join(
      "\n",
    );
    const res = await createFromText({ text });
    expect(res.status).toBe(201);
    // Titled from the text as typed; queued even though the board has autoRun off.
    expect(res.body).toMatchObject({
      title: "the cart page overflows on phones",
      description: text,
      status: "in_progress",
      agentState: "queued",
    });

    const card = await waitFor(async () => {
      const { task } = await getCard(res.body.id);
      return task.description.startsWith("## Goal") ? task : null;
    });
    expect(card).toMatchObject({
      title: "the cart page overflows on phones",
      description: `## Goal\n\n${text}\n\n${ORCHESTRATE_LINE}`,
      blockedBy: [blocker.id],
      agentState: "queued",
    });
    // Its blocker is not done: it waits for it, no longer for the card writer.
    const entry = await waitFor(async () => {
      const found = (await queue()).queued.find((e) => e.taskId === card.id);
      return found && !found.drafting ? found : null;
    });
    expect(entry.waitingFor).toEqual([blocker.id]);

    // A read-only omp in the project, over RPC, that sees the request and the other open cards.
    const run = cardWriterRuns().at(-1);
    expect(run?.argv).toEqual(expect.arrayContaining(["--mode", "rpc", "--tools", "read,grep,glob", "--model", "@smol"]));
    expect(run?.argv[run.argv.indexOf("--cwd") + 1]).toBe(board.workdir);
    expect(run?.prompt).toContain(`<request>\n${text}\n</request>`);
    expect(run?.prompt).toContain(`- ${blocker.id} — To do — Build the API`);
    expect(run?.prompt).not.toContain(`- ${card.id} —`);
    expect(run?.steers).toEqual([]);
    await api(taskStopRoute, "POST", `/tasks/${card.id}/stop`, { params: { id: card.id } });
  });

  it("starts the run once the card is written, with the brief the card writer wrote", async () => {
    const text = "tidy the footer links\nkeep the order";
    const res = await createFromText({ text });
    const prompt = await waitFor(() => cardRunPrompts().find((p) => p.message.includes(`## Goal\n\n${text}`)));
    const writer = cardWriterRuns().find((r) => r.prompt.includes(`<request>\n${text}\n</request>`));
    expect(writer && writer.index < prompt.index).toBe(true);
    await waitFor(async () => (await getCard(res.body.id)).task.status === "done");
  });

  it("starts a short single line right away, without the card writer", async () => {
    const before = cardWriterRuns().length;
    const res = await createFromText({ text: "  Rename the save button  " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "Rename the save button", description: "", status: "in_progress" });
    expect(["queued", "running"]).toContain(res.body.agentState);
    await waitFor(async () => (await getCard(res.body.id)).task.status === "done");
    expect(cardWriterRuns()).toHaveLength(before);
  });

  it("steers a card agent that keeps looking around to answer with what it found", async () => {
    const res = await createFromText({ text: "[fake-draft:lookaround] tidy the settings page\ngroup the toggles" });
    await waitFor(async () => (await getCard(res.body.id)).task.description.startsWith("## Goal"));
    const run = cardWriterRuns().at(-1);
    expect(run?.steers).toHaveLength(1);
    expect(run?.steers[0]).toMatch(/Reply now with only the card JSON/);
  });

  it("turns omp's own keyword into parallel subagents without passing it to the card agent", async () => {
    const res = await createFromText({ text: "orchestrate: rework the board page\nsplit it up" });
    const card = await waitFor(async () => {
      const { task } = await getCard(res.body.id);
      return task.description.startsWith("## Goal") ? task : null;
    });
    expect(card.description.endsWith(ORCHESTRATE_LINE)).toBe(true);
    expect(cardWriterRuns().at(-1)?.prompt).toContain("<request>\nparallelize: rework the board page\nsplit it up\n</request>");
  });

  it("runs the text as typed, with a note on the card, when the card agent fails", async () => {
    const text = "[fake-draft:fail] fix the login redirect\nit loops";
    const res = await createFromText({ text });
    await waitFor(() => cardRunPrompts().find((p) => p.message.includes(text)));
    const { task, comments } = await getCard(res.body.id);
    expect(task).toMatchObject({ title: "[fake-draft:fail] fix the login redirect", description: text });
    expect(comments.find((c) => c.author === "agent")?.body).toMatch(/card agent couldn't write this card/);
  });

  it("attaches a long request as brief.md and hands it to the card agent as a file", async () => {
    const text = `Rework the importer\n${"Keep every column exactly as it is today. ".repeat(2000)}`;
    expect(text.length).toBeGreaterThan(60_000);
    const res = await createFromText({ text });
    expect(res.body.title).toBe("Rework the importer");
    expect(res.body.description.endsWith(BRIEF_NOTE)).toBe(true);
    const brief = path.join(env().dataDir, "files", "tasks", res.body.id, "brief.md");
    expect(readFileSync(brief, "utf8")).toBe(`${text.trim()}\n`);

    const card = await waitFor(async () => {
      const { task } = await getCard(res.body.id);
      return task.description.startsWith("## Goal") ? task : null;
    });
    expect(card.description.endsWith(`\n\n${BRIEF_NOTE}`)).toBe(true);
    const prompt = cardWriterRuns().at(-1)?.prompt ?? "";
    expect(prompt).not.toContain("<request>");
    const file = /is saved in (\S+?)\.(?=\s)/.exec(prompt)?.[1];
    expect(file?.startsWith(path.join(env().dataDir, "runtime", "drafts"))).toBe(true);
    await waitFor(() => !existsSync(file as string));
    await api(taskStopRoute, "POST", `/tasks/${card.id}/stop`, { params: { id: card.id } });
  });

  it("holds the run while the card is written; stopping the card stops its card writer", async () => {
    const res = await createFromText({ text: "[fake-draft:slow] rework the CSV importer\nkeep the old columns" });
    const run = await waitFor(() => cardWriterRuns().find((r) => r.prompt.includes("rework the CSV importer")));
    expect((await queue()).queued.find((e) => e.taskId === res.body.id)).toMatchObject({ drafting: true });

    const stopped = await api<Task>(taskStopRoute, "POST", `/tasks/${res.body.id}/stop`, { params: { id: res.body.id } });
    expect(stopped.body.agentState).toBe("idle");
    await waitFor(() => !alive(run.pid));
    expect((await getCard(res.body.id)).task).toMatchObject({
      title: "[fake-draft:slow] rework the CSV importer",
      status: "in_progress",
    });
    expect(cardRunPrompts().some((p) => p.message.includes("rework the CSV importer"))).toBe(false);
  });

  it("validates the text and the project", async () => {
    expect((await createFromText({ text: "  " })).status).toBe(400);
    expect((await createFromText({})).status).toBe(400);
    expect(
      (await api(boardTasksRoute, "POST", "/boards/nope/tasks", { body: { text: "x" }, params: { id: "nope" } })).status,
    ).toBe(404);
  });
});
