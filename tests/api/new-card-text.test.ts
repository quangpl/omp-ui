import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, env, freshEnv, readOmpLog, setupAdmin, teardown, tempDir, waitFor } from "./helpers";

import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import * as taskStopRoute from "@/app/api/v1/tasks/[id]/stop/route";
import * as taskCommentsRoute from "@/app/api/v1/tasks/[id]/comments/route";
import { BRIEF_FILE, BRIEF_NOTE, DESCRIPTION_MAX } from "@/lib/card-draft";
import type { Board, Comment, Task } from "@/lib/types";

let board: Board;

beforeAll(async () => {
  await freshEnv();
  await setupAdmin();
  // autoRun off: cards from text start anyway.
  const res = await api<Board>(boardsRoute, "POST", "/boards", {
    body: { name: "Shop", workdir: tempDir("shop"), autoRun: false },
  });
  board = res.body;
});

afterAll(async () => {
  await teardown();
});

function createFromText(body: Record<string, unknown>) {
  return api<Task>(boardTasksRoute, "POST", `/boards/${board.id}/tasks`, { body, params: { id: board.id } });
}

async function getCard(id: string): Promise<{ task: Task; comments: Comment[] }> {
  return (await api<{ task: Task; comments: Comment[] }>(taskRoute, "GET", `/tasks/${id}`, { params: { id } })).body;
}

/** The first card run prompt (not a helper prompt) that contains `needle`. */
function runPrompt(needle: string): string | undefined {
  for (const e of readOmpLog()) {
    const message = e.kind === "command" && e.command?.type === "prompt" ? String(e.command.message ?? "") : "";
    if (message.includes(needle)) return message;
  }
  return undefined;
}

describe("POST /boards/:id/tasks with text", () => {
  it("creates a single line as typed in In progress and starts its run at once", async () => {
    const res = await createFromText({ text: "  Rename the save button  " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: "Rename the save button",
      description: "",
      status: "in_progress",
    });
    expect(["queued", "running"]).toContain(res.body.agentState);
    await waitFor(async () => (await getCard(res.body.id)).task.status === "done");
  });

  it("keeps multi-line text as typed: the first line titles it, the text is its description", async () => {
    const text = "the cart page overflows on phones\n- check the checkout too\n- and the wishlist";
    const res = await createFromText({ text });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "the cart page overflows on phones", description: text, status: "in_progress" });
    expect((await getCard(res.body.id)).task.description).toBe(text);
    await waitFor(async () => (await getCard(res.body.id)).task.status === "done");
  });

  it("sends the card text to omp as typed, with no parallel-subagent or report instructions of its own", async () => {
    const res = await createFromText({ text: "tidy the footer links" });
    expect(res.status).toBe(201);
    await waitFor(async () => (await getCard(res.body.id)).task.status === "done");
    const prompt = runPrompt("tidy the footer links") ?? "";
    expect(prompt).not.toContain("parallel subagents");
    expect(prompt).not.toContain("## Report");
    expect(prompt).not.toMatch(/scannable summary/);
  }, 60_000);

  it("steers a comment into the running session word for word", async () => {
    const res = await createFromText({ text: "[fake:slow] steer me" });
    expect(res.status).toBe(201);
    await waitFor(async () => (await getCard(res.body.id)).task.agentState === "running");
    const note = "Also check the footer:\n- one\n- two\n- three\n- four";
    const posted = await api<Comment>(taskCommentsRoute, "POST", `/tasks/${res.body.id}/comments`, {
      body: { body: note },
      params: { id: res.body.id },
    });
    expect(posted.status).toBe(201);
    await waitFor(async () => (await getCard(res.body.id)).task.status === "done");
    const steer = readOmpLog().find((e) => e.kind === "steer" && String(e.message ?? "").includes("Also check the footer"));
    expect(steer?.message).toBe(note);
  }, 60_000);

  it("attaches text past the description limit as brief.md", async () => {
    const text = `Rework the importer\n${"Keep every column exactly as it is today. ".repeat(1000)}`;
    expect(text.length).toBeGreaterThan(DESCRIPTION_MAX);
    const res = await createFromText({ text });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Rework the importer");
    expect(res.body.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(res.body.description.endsWith(`\n\n${BRIEF_NOTE}`)).toBe(true);
    const brief = path.join(env().dataDir, "files", "tasks", res.body.id, BRIEF_FILE);
    expect(readFileSync(brief, "utf8")).toBe(`${text.trim()}\n`);
    await api(taskStopRoute, "POST", `/tasks/${res.body.id}/stop`, { params: { id: res.body.id } });
  });

  it("validates the text and the project", async () => {
    expect((await createFromText({ text: "  " })).status).toBe(400);
    expect((await createFromText({})).status).toBe(400);
    expect(
      (await api(boardTasksRoute, "POST", "/boards/nope/tasks", { body: { text: "x" }, params: { id: "nope" } })).status,
    ).toBe(404);
  });
});
