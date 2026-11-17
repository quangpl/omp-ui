import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, env, freshEnv, readOmpLog, setupAdmin, teardown, tempDir, waitFor } from "./helpers";

import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import * as taskRoute from "@/app/api/v1/tasks/[id]/route";
import * as taskCommentsRoute from "@/app/api/v1/tasks/[id]/comments/route";
import * as taskStopRoute from "@/app/api/v1/tasks/[id]/stop/route";
import { BRIEF_FILE, BRIEF_NOTE, DESCRIPTION_MAX } from "@/lib/card-draft";
import { PARALLEL_INSTRUCTION } from "@/lib/agent/prompt";
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

/** The agent's final summary on the card once its run finished. */
async function summaryOf(id: string): Promise<string> {
  return waitFor(async () => {
    const { task, comments } = await getCard(id);
    return task.status === "done" ? comments.find((c) => c.author === "agent")?.body : null;
  });
}

describe("POST /boards/:id/tasks with text", () => {
  it("creates a single line as typed in In progress and starts its run at once", async () => {
    const res = await createFromText({ text: "  Rename the save button  " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: "Rename the save button",
      description: "",
      status: "in_progress",
      parallelize: null,
      ignoreMemory: false,
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

  it("stores parallelize and gates the run's parallel-subagent permission on it", async () => {
    const off = await createFromText({ text: "[fake:parallel] tidy the footer links", parallelize: false });
    expect(off.status).toBe(201);
    expect(off.body.parallelize).toBe(false);
    expect((await getCard(off.body.id)).task.parallelize).toBe(false);
    expect(await summaryOf(off.body.id)).toBe("Fake summary: parallel subagents not allowed.");
    expect(runPrompt("tidy the footer links")).not.toContain(PARALLEL_INSTRUCTION);

    const on = await createFromText({ text: "[fake:parallel] tidy the header links", parallelize: true });
    expect(on.body.parallelize).toBe(true);
    expect(await summaryOf(on.body.id)).toBe("Fake summary: parallel subagents allowed.");
    expect(runPrompt("tidy the header links")).toContain(PARALLEL_INSTRUCTION);

    // No choice made (null) counts as on.
    const unset = await createFromText({ text: "[fake:parallel] tidy the sidebar links" });
    expect(unset.body.parallelize).toBeNull();
    expect(await summaryOf(unset.body.id)).toBe("Fake summary: parallel subagents allowed.");
  });

  it("gates the parallel-subagent permission in steered user comments on parallelize", async () => {
    async function steerOf(text: string, extra: Record<string, unknown>, note: string): Promise<string> {
      const res = await createFromText({ text, ...extra });
      expect(res.status).toBe(201);
      await waitFor(async () => (await getCard(res.body.id)).task.agentState === "running");
      const posted = await api<Comment>(taskCommentsRoute, "POST", `/tasks/${res.body.id}/comments`, {
        body: { body: note },
        params: { id: res.body.id },
      });
      expect(posted.status).toBe(201);
      await waitFor(async () => (await getCard(res.body.id)).task.status === "done");
      const steer = readOmpLog().find((e) => e.kind === "steer" && String(e.message ?? "").includes(note));
      expect(steer).toBeDefined();
      return String(steer?.message);
    }
    expect(await steerOf("[fake:slow] steer off", { parallelize: false }, "Also check the off footer")).not.toContain(
      PARALLEL_INSTRUCTION,
    );
    expect(await steerOf("[fake:slow] steer unset", {}, "Also check the unset footer")).toContain(PARALLEL_INSTRUCTION);
  }, 60_000);

  it("stores parallelize from a { title } create", async () => {
    const res = await createFromText({ title: "Titled card", parallelize: false });
    expect(res.status).toBe(201);
    expect(res.body.parallelize).toBe(false);
    expect((await getCard(res.body.id)).task.parallelize).toBe(false);
  });

  it("stores ignoreMemory on create (both forms) and toggles it with PATCH", async () => {
    const on = await createFromText({ text: "[fake:parallel] tidy the sidebar links", ignoreMemory: true });
    expect(on.status).toBe(201);
    expect(on.body.ignoreMemory).toBe(true);
    expect((await getCard(on.body.id)).task.ignoreMemory).toBe(true);
    await waitFor(async () => (await getCard(on.body.id)).task.status === "done");

    const titled = await createFromText({ title: "Memoryless card", ignoreMemory: true });
    expect(titled.status).toBe(201);
    expect(titled.body.ignoreMemory).toBe(true);

    const unset = await createFromText({ title: "Remembering card" });
    expect(unset.body.ignoreMemory).toBe(false);

    const patch = (body: Record<string, unknown>) =>
      api<Task>(taskRoute, "PATCH", `/tasks/${unset.body.id}`, { body, params: { id: unset.body.id } });
    const toggled = await patch({ ignoreMemory: true });
    expect(toggled.status).toBe(200);
    expect(toggled.body.ignoreMemory).toBe(true);
    expect((await getCard(unset.body.id)).task.ignoreMemory).toBe(true);
    expect((await patch({ ignoreMemory: false })).body.ignoreMemory).toBe(false);
    expect((await patch({ ignoreMemory: "yes" })).status).toBe(400);
    expect((await createFromText({ text: "x", ignoreMemory: "yes" })).status).toBe(400);
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

  it("validates the text, parallelize and the project", async () => {
    expect((await createFromText({ text: "  " })).status).toBe(400);
    expect((await createFromText({})).status).toBe(400);
    expect((await createFromText({ text: "x", parallelize: "yes" })).status).toBe(400);
    expect(
      (await api(boardTasksRoute, "POST", "/boards/nope/tasks", { body: { text: "x" }, params: { id: "nope" } })).status,
    ).toBe(404);
  });
});
