import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emptyUsage, SessionUsageScanner, usageBeyond } from "@/lib/agent/session-usage";

const usage = (input: number, output: number, cacheRead: number, cost: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  cost: { total: cost },
});
const assistant = (u: object) =>
  JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage: u } });
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

describe("SessionUsageScanner", () => {
  let dir: string;
  let session: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "session-usage-"));
    session = path.join(dir, "2026-01-01_abc.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sums the main session, side requests and every subagent's file once", async () => {
    await writeFile(
      session,
      [
        line({ type: "session", id: "abc" }),
        `${assistant(usage(10, 100, 1000, 0.5))}\n`,
        line({ type: "model_usage", purpose: "title", usage: usage(5, 5, 0, 0.01) }),
        // A finished sync `task` result repeats its subagent's usage: counted from the subagent's file.
        line({ type: "message", message: { role: "toolResult", toolName: "task", details: { usage: usage(1, 1, 1, 9) } } }),
        line({ type: "message", message: { role: "user", content: "hi" } }),
      ].join(""),
    );
    await mkdir(path.join(dir, "2026-01-01_abc", "Child"), { recursive: true });
    await writeFile(path.join(dir, "2026-01-01_abc", "Scout.jsonl"), `${assistant(usage(20, 200, 0, 0.25))}\n`);
    await writeFile(path.join(dir, "2026-01-01_abc", "Child", "Nested.jsonl"), `${assistant(usage(1, 2, 3, 0.04))}\n`);
    await writeFile(path.join(dir, "2026-01-01_abc", "1.bash.log"), "usage: not a session\n");

    expect(await new SessionUsageScanner(session).scan()).toEqual({
      costUsd: 0.8,
      totalTokens: 1110 + 10 + 220 + 6,
      inputTokens: 36,
      outputTokens: 307,
      cacheReadTokens: 1003,
      cacheWriteTokens: 0,
      requests: 4,
    });
  });

  it("reads appended lines incrementally and waits for a line to be complete", async () => {
    await writeFile(session, `${assistant(usage(1, 1, 0, 0.1))}\n`);
    const scanner = new SessionUsageScanner(session);
    expect((await scanner.scan())!.requests).toBe(1);

    const next = assistant(usage(2, 2, 0, 0.2));
    await appendFile(session, next.slice(0, 20));
    expect((await scanner.scan())!.requests).toBe(1);
    await appendFile(session, `${next.slice(20)}\n`);
    const sums = (await scanner.scan())!;
    expect(sums.requests).toBe(2);
    expect(sums.costUsd).toBeCloseTo(0.3);
    expect(sums.totalTokens).toBe(6);
  });

  it("returns null while the session file does not exist", async () => {
    expect(await new SessionUsageScanner(session).scan()).toBeNull();
  });
});

describe("usageBeyond", () => {
  it("keeps what stored usage counts beyond the current session, never negative", () => {
    const stored = { ...emptyUsage(), costUsd: 2, requests: 10, totalTokens: 500 };
    const session = { ...emptyUsage(), costUsd: 0.5, requests: 12, totalTokens: 100 };
    expect(usageBeyond(stored, session)).toEqual({ ...emptyUsage(), costUsd: 1.5, requests: 0, totalTokens: 400 });
  });
});
