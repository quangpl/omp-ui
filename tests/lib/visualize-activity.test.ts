import { describe, expect, it } from "vitest";
import { describeActivity } from "@/components/visualize/activity";

describe("describeActivity", () => {
  it("turns the agent log's tool line into a label and detail", () => {
    expect(describeActivity("tool", "▸ bash: pnpm test -- --run")).toEqual({
      icon: "terminal",
      label: "Running a command",
      detail: "pnpm test -- --run",
      tool: "bash",
    });
    expect(describeActivity("tool", "▸ board_message_card: ping")).toMatchObject({ icon: "team", detail: "ping" });
    // A recorded intent reads better than the raw command.
    expect(describeActivity("tool", "▸ bash: pnpm test\nRunning the tests")).toMatchObject({ detail: "Running the tests" });
    expect(describeActivity("tool", "▸ mystery")).toEqual({ icon: "tool", label: "Using mystery", detail: undefined, tool: "mystery" });
  });

  it("ignores subagent snapshots and empty status lines", () => {
    expect(describeActivity("agent", "{}")).toBeNull();
    expect(describeActivity("status", "")).toBeNull();
  });
});
