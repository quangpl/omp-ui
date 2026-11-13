import { describe, expect, it } from "vitest";

import { describeToolStart } from "@/lib/agent/manager";

const CARD = "3f1c2a9e-8b7d-4c6e-9a10-2b3c4d5e6f70";

function start(toolName: string, args: Record<string, unknown>, intent?: string): string {
  return describeToolStart({ type: "tool_execution_start", toolName, args, ...(intent ? { intent } : {}) });
}

describe("describeToolStart", () => {
  it("keeps board tool args as the detail, card id first, intent on the second line", () => {
    expect(start("board_message_card", { message: "hi", cardId: CARD, intent: "Telling Cog" })).toBe(
      `▸ board_message_card: {"cardId":"${CARD}","message":"hi"}\nTelling Cog`,
    );
    const long = start("board_message_card", { message: "x".repeat(400), cardId: CARD });
    expect(long.startsWith(`▸ board_message_card: {"cardId":"${CARD}"`)).toBe(true);
    expect(long.endsWith("…")).toBe(true);
  });

  it("logs a write to an xd:// device as the device tool with its JSON args", () => {
    const line = start(
      "write",
      { path: "xd://board_wait_for_cards", content: JSON.stringify({ cardIds: [CARD] }) },
      "Waiting",
    );
    expect(line).toBe(`▸ board_wait_for_cards: {"cardIds":["${CARD}"]}\nWaiting`);
    // Content that is not a JSON object falls back to the plain write line.
    expect(start("write", { path: "xd://board_read_card", content: "not json" })).toBe("▸ write: xd://board_read_card");
  });

  it("leaves other tools' lines unchanged", () => {
    expect(start("bash", { command: "npm test" }, "Running the tests")).toBe("▸ bash: npm test\nRunning the tests");
    expect(start("read", { path: "README.md" })).toBe("▸ read: README.md");
    expect(start("grep", { pattern: "foo", intent: "Finding callers" })).toBe("▸ grep: Finding callers");
    expect(start("write", { path: "notes.txt", content: "{}" }, "Saving notes")).toBe("▸ write: Saving notes");
    expect(start("todo", {})).toBe("▸ todo");
  });
});
