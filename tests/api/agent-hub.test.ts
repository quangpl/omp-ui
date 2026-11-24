import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, createUser, freshEnv, loginAs, setupAdmin, teardown, tempDir } from "./helpers";

import * as agentHubRoute from "@/app/api/v1/agent-hub/route";
import * as boardTasksRoute from "@/app/api/v1/boards/[id]/tasks/route";
import * as boardsRoute from "@/app/api/v1/boards/route";
import { getRepo } from "@/lib/db";
import type { AgentHubData, Board, SubagentSnapshot, Task } from "@/lib/types";

async function cardWithRun(token: string | undefined, name: string) {
  const board = await api<Board>(boardsRoute, "POST", "/boards", { body: { name, workdir: tempDir(name) }, token });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  const task = await api<Task>(boardTasksRoute, "POST", `/boards/${board.body.id}/tasks`, {
    body: { title: `${name} card` },
    params: { id: board.body.id },
    token,
  });
  expect(task.status, JSON.stringify(task.body)).toBe(201);
  const repo = await getRepo();
  const run = await repo.createRun({ taskId: task.body.id, prompt: "go" });
  const spawn = (snapshot: SubagentSnapshot) =>
    repo.appendRunEvent({ runId: run.id, taskId: task.body.id, kind: "agent", text: JSON.stringify(snapshot) });
  return { repo, run, task: task.body, spawn };
}

describe("GET /agent-hub", () => {
  let userToken: string;

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
    await createUser({ username: "alice", password: "alice-password-1" });
    userToken = await loginAs("alice", "alice-password-1");
  });
  afterAll(teardown);

  it("lists the subagents of recent runs, reads new events incrementally and keeps users apart", async () => {
    const { repo, run, task, spawn } = await cardWithRun(undefined, "Hub");
    await spawn({ id: "Lead", agent: "task", status: "running", description: "Plan the work" });
    await spawn({ id: "Lead.Scout", agent: "scout", status: "running", model: "anthropic/claude-sonnet" });

    let hub = await api<AgentHubData>(agentHubRoute, "GET", "/agent-hub");
    expect(hub.status).toBe(200);
    expect(hub.body.agents.map((a) => [a.snapshot.id, a.parentId, a.snapshot.status, a.taskId])).toEqual(
      expect.arrayContaining([
        ["Lead", null, "running", task.id],
        ["Lead.Scout", "Lead", "running", task.id],
      ]),
    );
    expect(hub.body.agents).toHaveLength(2);
    expect(hub.body.agents[0]).toMatchObject({ taskTitle: "Hub card", boardName: "Hub", runStatus: "running" });
    expect(hub.body.activity.map((l) => l.text)).toContain("Started: Plan the work");

    // New events are folded in without re-reading (or double counting) the old ones.
    await spawn({ id: "Lead.Scout", agent: "scout", status: "completed", output: "All mapped" });
    hub = await api<AgentHubData>(agentHubRoute, "GET", "/agent-hub");
    expect(hub.body.agents.find((a) => a.snapshot.id === "Lead.Scout")?.snapshot.status).toBe("completed");
    expect(hub.body.activity.filter((l) => l.agentId === "Lead.Scout" && l.kind === "lifecycle")).toHaveLength(2);
    expect(hub.body.activity.some((l) => l.kind === "response" && l.text === "All mapped")).toBe(true);

    // The run ended while "Lead" was still working: it died with the run.
    await repo.updateRun(run.id, { status: "failed", endedAt: new Date().toISOString(), error: "crash" });
    hub = await api<AgentHubData>(agentHubRoute, "GET", "/agent-hub");
    expect(hub.body.agents.find((a) => a.snapshot.id === "Lead")?.snapshot.status).toBe("aborted");

    // Another user's runs are not shown.
    const own = await api<AgentHubData>(agentHubRoute, "GET", "/agent-hub", { token: userToken });
    expect(own.body.agents).toEqual([]);
  });
});
