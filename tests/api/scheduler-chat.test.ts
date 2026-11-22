// "Create with Agent" (POST /api/v1/schedulers/chat, driven through the fake omp's scheduler
// assistant, which calls the host tools a message lists as `<calls>[…]</calls>`) and the
// Telegram/Discord chat assistant's scheduler tools (runChatTool).

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, call, env, freshEnv, setupAdmin, teardown, tempDir } from "./helpers";

import * as boardsRoute from "@/app/api/v1/boards/route";
import * as schedulerChatRoute from "@/app/api/v1/schedulers/chat/route";
import * as schedulersRoute from "@/app/api/v1/schedulers/route";
import { getAgentManager } from "@/lib/agent/manager";
import { getRepo } from "@/lib/db";
import { runChatTool } from "@/lib/server/chat/assistant";
import type { Board, Scheduler, SchedulerChatEvent, SchedulerChatRequest, SchedulerDraft } from "@/lib/types";

/** Fires on January 1st only, so the background due check never fires a test scheduler. */
const NEW_YEAR = "0 0 1 1 *";

let shop: Board;
let blog: Board;

async function createBoard(name: string): Promise<Board> {
  const res = await api<Board>(boardsRoute, "POST", "/boards", {
    body: { name, workdir: tempDir(name.toLowerCase()), autoRun: false },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** A user message asking the fake assistant to call these tools. */
function calls(...list: { toolName: string; arguments: Record<string, unknown> }[]): string {
  return `<calls>${JSON.stringify(list)}</calls>`;
}

/** POST one turn and read the NDJSON stream to its end. */
async function chatTurn(body: Partial<SchedulerChatRequest> & { text?: string }): Promise<SchedulerChatEvent[]> {
  const { text, ...rest } = body;
  const res = await call(schedulerChatRoute, "POST", "/schedulers/chat", {
    body: { timezone: "Europe/Berlin", boardId: shop.id, messages: [{ role: "user", text }], ...rest },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  return (await res.text())
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SchedulerChatEvent);
}

interface ToolResult {
  toolName: string;
  isError: boolean;
  text: string;
}

/** The `done` event and the tool results the fake assistant reported in its reply. */
function doneOf(events: SchedulerChatEvent[]): { draft: SchedulerDraft | null; results: ToolResult[] } {
  const done = events.at(-1);
  if (done?.type !== "done") throw new Error(`expected a done event, got ${JSON.stringify(events)}`);
  const match = /^Chat reply: (\[[\s\S]*\])$/.exec(done.reply);
  return { draft: done.draft, results: match ? (JSON.parse(match[1]) as ToolResult[]) : [] };
}

const propose = (args: Record<string, unknown>) =>
  calls({ toolName: "omp_ui_propose_scheduler", arguments: { prompt: "Update the dependencies", cron: NEW_YEAR, ...args } });

beforeAll(async () => {
  await freshEnv();
  await setupAdmin();
  shop = await createBoard("Shop");
  blog = await createBoard("Blog");
});

afterAll(teardown);

describe("POST /schedulers/chat", () => {
  it("validates the conversation", async () => {
    for (const body of [
      { timezone: "UTC", messages: [] },
      { timezone: "UTC", messages: [{ role: "assistant", text: "Hi" }] },
      { timezone: "UTC", messages: [{ role: "user", text: "   " }] },
      { timezone: "Mars/Olympus_Mons", messages: [{ role: "user", text: "Hi" }] },
      { timezone: "UTC", messages: [{ role: "user", text: "Hi" }], draft: { cron: 1 } },
    ]) {
      const res = await api(schedulerChatRoute, "POST", "/schedulers/chat", { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("returns the validated draft with the user's time zone and the default project, saving nothing", async () => {
    const events = await chatTurn({ text: propose({ name: "Weekly deps", maxRuns: 3 }) });
    expect(events.some((event) => event.type === "activity")).toBe(true);
    const { draft, results } = doneOf(events);
    expect(results).toHaveLength(1);
    expect(results[0].isError, results[0].text).toBe(false);
    expect(JSON.parse(results[0].text).proposed).toMatchObject({
      name: "Weekly deps",
      project: "Shop",
      schedule: "At 00:00 on January 1",
      timezone: "Europe/Berlin",
      repeats: "3 more runs",
    });
    expect(draft).toEqual({
      boardId: shop.id,
      name: "Weekly deps",
      prompt: "Update the dependencies",
      cron: NEW_YEAR,
      timezone: "Europe/Berlin",
      enabled: true,
      maxRuns: 3,
      model: null,
    });
    expect((await api<Scheduler[]>(schedulersRoute, "GET", "/schedulers")).body).toEqual([]);
  });

  it("resolves a named project and defaults the name to the prompt's first line", async () => {
    const { draft } = doneOf(await chatTurn({ text: propose({ project: "blog", timezone: "UTC" }) }));
    expect(draft).toMatchObject({ boardId: blog.id, name: "Update the dependencies", timezone: "UTC", maxRuns: null });
  });

  it("hands invalid drafts back to the agent as tool errors, with no draft", async () => {
    for (const [args, error] of [
      [{ cron: "61 * * * *" }, /cron/],
      [{ cron: "0 0 30 2 *" }, /never matches/],
      [{ timezone: "Mars/Olympus_Mons" }, /timezone/],
      [{ project: "Nope" }, /No board matches "Nope"/],
      [{ prompt: " " }, /prompt is required/],
    ] as const) {
      const { draft, results } = doneOf(await chatTurn({ text: propose(args) }));
      expect(results[0], JSON.stringify(args)).toMatchObject({ isError: true });
      expect(results[0].text).toMatch(error);
      expect(draft).toBeNull();
    }
  });

  it("tells the assistant the projects, the time zone and the current draft", async () => {
    const current: SchedulerDraft = {
      boardId: blog.id,
      name: "Nightly tests",
      prompt: "Run the tests",
      cron: "0 2 * * *",
      timezone: "Asia/Tokyo",
      enabled: true,
      maxRuns: null,
      model: null,
    };
    const { draft } = doneOf(
      await chatTurn({
        messages: [
          { role: "user", text: "Run the tests every night" },
          { role: "assistant", text: "Here is a draft." },
          { role: "user", text: "make it 3:00" },
        ],
        draft: current,
      }),
    );
    // Only answered (no tool call): no new draft this turn.
    expect(draft).toBeNull();
    const prompt = readFileSync(env().ompLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; prompt?: string })
      .filter((entry) => entry.kind === "helper" && entry.prompt?.includes("make it 3:00"))
      .at(-1)?.prompt;
    expect(prompt).toMatch(/^You are OMP-UI's scheduler assistant/);
    expect(prompt).toContain("the user's time zone: Europe/Berlin");
    expect(prompt).toContain(`Default project: Shop (${shop.id.slice(0, 8)})`);
    expect(prompt).toContain(`Blog (${blog.id.slice(0, 8)}, ${blog.workdir})`);
    expect(prompt).toContain('"project":"Blog"');
    expect(prompt).toContain("User: Run the tests every night");
    expect(prompt).toContain("You: Here is a draft.");
  });

  it("streams an error event when the assistant fails", async () => {
    const events = await chatTurn({ text: "[fake-chat:fail]" });
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});

describe("chat assistant scheduler tools", () => {
  const ctx = { platform: "telegram" as const, chatId: "7", userId: "7" };
  const run = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(
      await runChatTool(
        { repo: await getRepo(), manager: await getAgentManager() },
        ctx,
        name,
        args,
        new AbortController().signal,
      ),
    ) as Record<string, Record<string, unknown>>;

  it("creates, updates (pause, reschedule) and lists schedulers, echoing the schedule", async () => {
    const { created } = await run("omp_ui_create_scheduler", {
      prompt: "Triage new issues",
      cron: NEW_YEAR,
      timezone: "Europe/Berlin",
      board: "Blog",
      name: "",
    });
    expect(created).toMatchObject({
      name: "Triage new issues",
      project: "Blog",
      schedule: "At 00:00 on January 1",
      timezone: "Europe/Berlin",
      enabled: true,
    });
    expect(created.nextRuns).toHaveLength(3);
    const id = created.id as string;

    const { updated } = await run("omp_ui_update_scheduler", { schedulerId: id.slice(0, 8), enabled: false, cron: "0 9 1 1 *" });
    expect(updated).toMatchObject({ id, enabled: false, cron: "0 9 1 1 *", schedule: "At 09:00 on January 1" });
    const saved = await (await getRepo()).getScheduler(id);
    expect(saved).toMatchObject({ enabled: false, nextRunAt: null });

    // By exact name too.
    const { updated: resumed } = await run("omp_ui_update_scheduler", { schedulerId: "triage new issues", enabled: true });
    expect(resumed).toMatchObject({ enabled: true });

    const { schedulers } = (await run("omp_ui_list_schedulers", { board: "Blog" })) as unknown as {
      schedulers: Record<string, unknown>[];
    };
    expect(schedulers.map((s) => s.id)).toEqual([id]);
  });

  it("refuses schedules that never fire and unknown schedulers", async () => {
    await expect(run("omp_ui_create_scheduler", { prompt: "x", cron: "0 0 30 2 *" })).rejects.toThrow(/never matches/);
    await expect(run("omp_ui_update_scheduler", { schedulerId: "nope-nope", enabled: false })).rejects.toThrow(
      /No scheduler matches/,
    );
  });
});
