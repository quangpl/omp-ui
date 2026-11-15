import path from "node:path";
import { describe, expect, it } from "vitest";

import { runConfigOverlay } from "@/lib/agent/manager";
import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/types";

const TASK_FILES = path.join("/data", "files", "tasks", "card-1");

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe("runConfigOverlay", () => {
  it("holds only the browser section with every orchestration setting off", () => {
    expect(runConfigOverlay(settings({ browser: "off" }), TASK_FILES, null)).toEqual({ browser: { enabled: false } });
    expect(runConfigOverlay(settings({ browser: "headless" }), TASK_FILES, 3)).toEqual({
      browser: {
        enabled: true,
        headless: true,
        relay: false,
        screenshotDir: path.join(TASK_FILES, "screenshots"),
      },
    });
  });

  it("caps subagents at the run's share, their depth and runtime when subagent limits are on", () => {
    const overlay = runConfigOverlay(
      settings({ subagentLimits: true, subagentMaxConcurrency: 8, subagentMaxDepth: 2, subagentTimeoutMinutes: 30 }),
      TASK_FILES,
      3,
    );
    expect(overlay.task).toEqual({ maxConcurrency: 3, maxRecursionDepth: 2, maxRuntimeMs: 30 * 60_000 });
    expect(overlay).not.toHaveProperty("compaction");
  });

  it("uses the ceiling when the run's share is unknown and omits the runtime at 0 (no limit)", () => {
    const overlay = runConfigOverlay(
      settings({ subagentLimits: true, subagentMaxConcurrency: 5, subagentMaxDepth: 1, subagentTimeoutMinutes: 0 }),
      TASK_FILES,
      null,
    );
    expect(overlay.task).toEqual({ maxConcurrency: 5, maxRecursionDepth: 1 });
  });

  it("sets the compaction threshold when context compaction is on", () => {
    const overlay = runConfigOverlay(settings({ contextCompaction: true, contextCompactPercent: 50 }), TASK_FILES, 4);
    expect(overlay.compaction).toEqual({ thresholdPercent: 50 });
    expect(overlay).not.toHaveProperty("task");
  });

  it("ignores the subagent share while subagent limits are off", () => {
    expect(runConfigOverlay(settings({ subagentLimits: false }), TASK_FILES, 2)).not.toHaveProperty("task");
  });
});
