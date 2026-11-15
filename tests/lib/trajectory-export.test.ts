import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Trajectory } from "@/lib/agent/trajectory";
import { HttpError } from "@/lib/server/http";
import {
  acquireExportSlot,
  MAX_CONCURRENT_EXPORTS,
  ndjsonStream,
  readSessionFile,
} from "@/lib/server/trajectory-export";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "omp-ui-trajectory-export-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function trajectory(taskId: string): Trajectory {
  return { conversations: [{ from: "human", value: "hi" }], timestamp: "2026-01-01T00:00:00.000Z", model: null, completed: true, taskId, runId: null };
}

describe("readSessionFile", () => {
  it("reads a regular .jsonl file within the cap", async () => {
    const file = path.join(dir, "ok.jsonl");
    writeFileSync(file, '{"type":"session"}\n');
    expect(await readSessionFile(file, 1_000)).toEqual({ kind: "ok", text: '{"type":"session"}\n', bytes: 19 });
    expect(await readSessionFile(file, 19)).toEqual({ kind: "ok", text: '{"type":"session"}\n', bytes: 19 });
  });

  it("reports a file over the cap as too-large with its size, without reading it", async () => {
    const file = path.join(dir, "big.jsonl");
    writeFileSync(file, "x".repeat(100));
    expect(await readSessionFile(file, 99)).toEqual({ kind: "too-large", bytes: 100 });
  });

  it("reports missing files, other suffixes and non-regular paths as missing", async () => {
    const other = path.join(dir, "notes.txt");
    writeFileSync(other, "{}\n");
    const directory = path.join(dir, "x.jsonl");
    mkdirSync(directory);
    expect(await readSessionFile(null, 1_000)).toEqual({ kind: "missing" });
    expect(await readSessionFile(path.join(dir, "absent.jsonl"), 1_000)).toEqual({ kind: "missing" });
    expect(await readSessionFile(other, 1_000)).toEqual({ kind: "missing" });
    expect(await readSessionFile(directory, 1_000)).toEqual({ kind: "missing" });
  });
});

describe("acquireExportSlot", () => {
  it("allows MAX_CONCURRENT_EXPORTS exports, refuses the next with 429 and frees a slot on release", () => {
    const releases = Array.from({ length: MAX_CONCURRENT_EXPORTS }, () => acquireExportSlot());
    try {
      expect(() => acquireExportSlot()).toThrow(HttpError);
      try {
        acquireExportSlot();
      } catch (err) {
        expect((err as HttpError).status).toBe(429);
      }
      releases[0]();
      releases[0](); // idempotent: frees one slot only
      releases[0] = acquireExportSlot();
      expect(() => acquireExportSlot()).toThrow(HttpError);
    } finally {
      for (const release of releases) release();
    }
  });
});

describe("ndjsonStream", () => {
  /** Slots still free (acquires them all, then gives them back). */
  function freeSlots(): number {
    const taken: (() => void)[] = [];
    try {
      for (;;) taken.push(acquireExportSlot());
    } catch {
      // all taken
    } finally {
      for (const release of taken) release();
    }
    return taken.length;
  }

  it("streams one line per trajectory on demand and frees its slot at the end", async () => {
    const release = acquireExportSlot();
    const queue = [trajectory("a"), trajectory("b")];
    let calls = 0;
    const res = ndjsonStream(new Request("http://x/"), "t.jsonl", release, async () => {
      calls++;
      return queue.shift() ?? null;
    });
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="t.jsonl"');
    await Promise.resolve();
    expect(calls).toBe(0); // nothing built before the client reads
    const lines = (await res.text()).split("\n");
    expect(lines).toEqual([JSON.stringify(trajectory("a")), JSON.stringify(trajectory("b")), ""]);
    expect(freeSlots()).toBe(MAX_CONCURRENT_EXPORTS);
  });

  it("frees its slot when the client cancels", async () => {
    const release = acquireExportSlot();
    const res = ndjsonStream(new Request("http://x/"), "t.jsonl", release, async () => trajectory("a"));
    const reader = res.body!.getReader();
    await reader.read();
    expect(freeSlots()).toBe(MAX_CONCURRENT_EXPORTS - 1);
    await reader.cancel();
    expect(freeSlots()).toBe(MAX_CONCURRENT_EXPORTS);
  });

  it("frees its slot and ends the stream when the request is aborted", async () => {
    const release = acquireExportSlot();
    const abort = new AbortController();
    let calls = 0;
    const res = ndjsonStream(new Request("http://x/", { signal: abort.signal }), "t.jsonl", release, async () => {
      calls++;
      return trajectory("a");
    });
    const reader = res.body!.getReader();
    await reader.read();
    abort.abort();
    expect(freeSlots()).toBe(MAX_CONCURRENT_EXPORTS);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(calls).toBe(1);
  });

  it("frees its slot when building a trajectory fails", async () => {
    const release = acquireExportSlot();
    const res = ndjsonStream(new Request("http://x/"), "t.jsonl", release, async () => {
      throw new Error("boom");
    });
    await expect(res.body!.getReader().read()).rejects.toThrow("boom");
    expect(freeSlots()).toBe(MAX_CONCURRENT_EXPORTS);
  });
});
