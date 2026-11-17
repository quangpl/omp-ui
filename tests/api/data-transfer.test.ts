import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { api, call, env, freshEnv, loginAs, setupAdmin, teardown, useToken } from "./helpers";

import * as backupRoute from "@/app/api/v1/data-transfer/backups/[name]/route";
import * as exportRoute from "@/app/api/v1/data-transfer/export/route";
import * as importRoute from "@/app/api/v1/data-transfer/import/route";
import * as statusRoute from "@/app/api/v1/data-transfer/route";
import { getRepo } from "@/lib/db";
import type { DataImportResult, DataTransferStatus } from "@/lib/types";

afterAll(teardown);

const OLD_PASSWORD = "old-server-password";
const NEW_PASSWORD = "new-server-password";

async function download(): Promise<Uint8Array<ArrayBuffer>> {
  const res = await call(exportRoute, "GET", "/data-transfer/export");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/gzip");
  return new Uint8Array(await res.arrayBuffer());
}

function importArchive(archive: Uint8Array<ArrayBuffer>, query = "?confirm=replace") {
  return api<DataImportResult & { error?: string }>(importRoute, "POST", `/data-transfer/import${query}`, {
    rawBody: archive,
    headers: { "content-type": "application/gzip" },
  });
}

describe("data transfer", () => {
  it("moves every row, the shared files and the credentials key to another server", async () => {
    // --- The old server.
    await freshEnv();
    await setupAdmin(OLD_PASSWORD);
    const oldKey = `${randomBytes(32).toString("base64")}\n`;
    writeFileSync(path.join(env().dataDir, "credentials.key"), oldKey);
    const oldRepo = await getRepo();
    const board = await oldRepo.createBoard({ name: "Moved project", workdir: env().root });
    const task = await oldRepo.createTask({ boardId: board.id, title: "Working card", status: "in_progress" });
    const run = await oldRepo.createRun({ taskId: task.id, prompt: "do it" });
    await oldRepo.appendRunEvent({ runId: run.id, taskId: task.id, kind: "text", text: "halfway" });
    await oldRepo.updateTask(task.id, { agentState: "running", lastRunId: run.id });
    await oldRepo.addComment({ taskId: task.id, author: "user", body: "feedback" });
    const cardFiles = path.join(env().dataDir, "files", "tasks", task.id);
    mkdirSync(cardFiles, { recursive: true });
    writeFileSync(path.join(cardFiles, "report.md"), "# Report");
    const archive = await download();

    // --- The new server, with data of its own.
    await freshEnv();
    await setupAdmin(NEW_PASSWORD);
    const newRepo = await getRepo();
    const local = await newRepo.createBoard({ name: "Local project", workdir: env().root });

    expect((await importArchive(archive, "")).status).toBe(400);
    const garbage = await importArchive(new TextEncoder().encode("not a tarball"));
    expect(garbage.status).toBe(400);
    expect(await newRepo.getBoard(local.id)).not.toBeNull();

    const res = await importArchive(archive);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      counts: { boards: 1, tasks: 1, runs: 1, run_events: 1, comments: 1, users: 1 },
      files: 1,
      skipped: 0,
      interrupted: 1,
      credentialsKey: "restored",
      // The old server's token secret replaced this one's.
      signedOut: true,
    });

    expect(await newRepo.getBoard(local.id)).toBeNull();
    expect((await newRepo.getBoard(board.id))?.name).toBe("Moved project");
    const moved = await newRepo.getTask(task.id);
    expect(moved).toMatchObject({ title: "Working card", agentState: "error", commentCount: 1 });
    expect((await newRepo.getRun(run.id))?.status).toBe("aborted");
    expect((await newRepo.listRunEvents(run.id)).map((e) => e.text)).toEqual(["halfway"]);
    expect(readFileSync(path.join(env().dataDir, "files", "tasks", task.id, "report.md"), "utf8")).toBe("# Report");
    expect(readFileSync(path.join(env().dataDir, "credentials.key"), "utf8")).toBe(oldKey);

    // The old server's account signs in here; this server's previous password no longer does.
    useToken(await loginAs("admin", OLD_PASSWORD));
    await expect(loginAs("admin", NEW_PASSWORD)).rejects.toThrow();

    // The automatic backup holds the data from before the import, and importing it brings it back.
    const status = await api<DataTransferStatus>(statusRoute, "GET", "/data-transfer");
    expect(status.body.backups.map((b) => b.name)).toEqual([res.body.backup.name]);
    expect(existsSync(path.join(env().dataDir, "backups", res.body.backup.name))).toBe(true);
    const backup = await call(backupRoute, "GET", `/data-transfer/backups/${res.body.backup.name}`, {
      params: { name: res.body.backup.name },
    });
    expect(backup.status).toBe(200);
    const restored = await importArchive(new Uint8Array(await backup.arrayBuffer()));
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect((await newRepo.getBoard(local.id))?.name).toBe("Local project");
    expect(await newRepo.getBoard(board.id)).toBeNull();
    await loginAs("admin", NEW_PASSWORD);
  });
});
