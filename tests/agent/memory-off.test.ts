import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { memoryOffSettings } from "@/lib/server/agentmemory";

const AGENT_DIR = path.join(os.homedir(), ".omp", "agent");

describe("memoryOffSettings", () => {
  it("drops the agentmemory extension dir and keeps the rest in order", () => {
    const result = memoryOffSettings(
      ["/opt/ext/one", path.join(AGENT_DIR, "agentmemory"), "/opt/ext/two"],
      [],
    );
    expect(result.extensions).toEqual(["/opt/ext/one", "/opt/ext/two"]);
  });

  it("matches a ~ path with a trailing slash and the npm package", () => {
    const result = memoryOffSettings(
      ["~/.omp/agent/agentmemory/", "node_modules/@agentmemory/agentmemory/omp", "~/ext/other"],
      [],
    );
    expect(result.extensions).toEqual(["~/ext/other"]);
  });

  it("adds no extensions key when nothing matched", () => {
    const result = memoryOffSettings(["/opt/ext/one", "/opt/agentmemory-notes"], []);
    expect(result).toEqual({ disabledExtensions: ["mcp:agentmemory"] });
    expect("extensions" in result).toBe(false);
  });

  it("keeps existing disabledExtensions and dedupes mcp:agentmemory", () => {
    expect(memoryOffSettings([], ["skill:foo", "mcp:agentmemory"]).disabledExtensions).toEqual([
      "skill:foo",
      "mcp:agentmemory",
    ]);
    expect(memoryOffSettings([], ["skill:foo"]).disabledExtensions).toEqual(["skill:foo", "mcp:agentmemory"]);
  });
});
