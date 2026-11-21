import { describe, expect, it } from "vitest";

import { chooseModel } from "@/lib/agent/model-select";
import type { ProviderPick } from "@/lib/provider-priority";

const main: ProviderPick = {
  entry: { provider: "anthropic", model: "anthropic/claude-sonnet" },
  index: 0,
  skipped: [],
  allOut: false,
  fallbacks: [],
};

const input = (overrides: Partial<Parameters<typeof chooseModel>[0]> = {}) => ({
  board: { model: null },
  settings: { defaultModel: "" },
  isResume: false,
  ...overrides,
});

describe("chooseModel", () => {
  it("leaves the choice to omp when nothing is configured", () => {
    expect(chooseModel(input())).toEqual({ model: null, source: "default" });
  });

  it("uses the settings default model when set", () => {
    expect(chooseModel(input({ settings: { defaultModel: " base " } }))).toEqual({ model: "base", source: "default" });
  });

  it("lets the board's pinned model win over everything", () => {
    expect(
      chooseModel(input({ board: { model: " pinned " }, settings: { defaultModel: "base" }, provider: main })),
    ).toEqual({ model: "pinned", source: "board" });
  });

  it("keeps the resumed session's model unless the board pins one", () => {
    const resumed = input({ isResume: true, settings: { defaultModel: "base" } });
    expect(chooseModel(resumed)).toEqual({ model: null, source: "session" });
    expect(chooseModel({ ...resumed, board: { model: "pinned" } })).toEqual({ model: "pinned", source: "board" });
  });

  describe("with a provider priority", () => {
    it("runs the active provider's model instead of the default model", () => {
      expect(chooseModel(input({ provider: main, settings: { defaultModel: "base" } }))).toEqual({
        model: "anthropic/claude-sonnet",
        source: "provider",
      });
    });

    it("switches a resumed session only when the retried run ran out of quota", () => {
      const resumed = input({ provider: main, isResume: true });
      expect(chooseModel(resumed)).toEqual({ model: null, source: "session" });
      expect(chooseModel({ ...resumed, quotaRetry: true })).toEqual({
        model: "anthropic/claude-sonnet",
        source: "provider",
      });
    });
  });
});
