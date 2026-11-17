import { describe, expect, it } from "vitest";

import { parseProviderPriority, pickProvider, quotaBlocks, type ProviderPriorityEntry } from "@/lib/provider-priority";
import type { AiProviderQuota, AiQuotaLimit } from "@/lib/types";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const HOUR = 3_600_000;

const PRIORITY: ProviderPriorityEntry[] = [
  { provider: "anthropic", model: "anthropic/claude-sonnet-4-5" },
  { provider: "openai-codex", model: "openai-codex/gpt-5" },
  { provider: "github-copilot", model: "github-copilot/claude-sonnet-4.5" },
];

function limit(patch: Partial<AiQuotaLimit>): AiQuotaLimit {
  return {
    id: "l",
    label: "5 Hour",
    windowLabel: "5 Hour",
    resetsAt: null,
    used: null,
    limit: null,
    usedFraction: null,
    unit: "percent",
    status: "ok",
    ...patch,
  };
}

function report(provider: string, limits: AiQuotaLimit[]): AiProviderQuota {
  return { provider, account: null, fetchedAt: null, limits };
}

describe("pickProvider", () => {
  it("stays on Main while it has quota, with the others as its in-run fallbacks", () => {
    expect(pickProvider(PRIORITY, new Map(), NOW)).toEqual({
      entry: PRIORITY[0],
      index: 0,
      skipped: [],
      allOut: false,
      fallbacks: ["openai-codex/gpt-5", "github-copilot/claude-sonnet-4.5"],
    });
  });

  it("moves to the next provider with quota while Main is out, and back once Main resets", () => {
    const out = new Map([["anthropic", NOW + HOUR]]);
    expect(pickProvider(PRIORITY, out, NOW)).toMatchObject({
      entry: PRIORITY[1],
      index: 1,
      skipped: [{ provider: "anthropic", until: NOW + HOUR }],
      fallbacks: ["github-copilot/claude-sonnet-4.5"],
    });
    expect(pickProvider(PRIORITY, out, NOW + HOUR)).toMatchObject({ index: 0, skipped: [] });
  });

  it("leaves providers without quota out of the fallbacks", () => {
    const pick = pickProvider(PRIORITY, new Map([["openai-codex", NOW + HOUR]]), NOW);
    expect(pick).toMatchObject({ index: 0, fallbacks: ["github-copilot/claude-sonnet-4.5"] });
  });

  it("uses Main without fallbacks when every provider is out of quota, and nothing for an empty list", () => {
    const out = new Map(PRIORITY.map((entry) => [entry.provider, NOW + HOUR]));
    expect(pickProvider(PRIORITY, out, NOW)).toEqual({ entry: PRIORITY[0], index: 0, skipped: [], allOut: true, fallbacks: [] });
    expect(pickProvider([], out, NOW)).toBeNull();
  });
});

describe("quotaBlocks", () => {
  it("blocks a provider until its latest exhausted limit resets", () => {
    const blocks = quotaBlocks(
      [
        report("anthropic", [
          limit({ status: "exhausted", resetsAt: new Date(NOW + HOUR).toISOString() }),
          limit({ usedFraction: 1, status: "warning", resetsAt: new Date(NOW + 3 * HOUR).toISOString() }),
          limit({ usedFraction: 0.5, resetsAt: new Date(NOW + 9 * HOUR).toISOString() }),
        ]),
        report("openai-codex", [limit({ usedFraction: 0.99, status: "warning", resetsAt: new Date(NOW + HOUR).toISOString() })]),
      ],
      NOW,
    );
    expect([...blocks]).toEqual([["anthropic", NOW + 3 * HOUR]]);
  });

  it("ignores exhausted limits whose reset passed or is unknown", () => {
    const blocks = quotaBlocks(
      [
        report("anthropic", [limit({ status: "exhausted", resetsAt: new Date(NOW - 1).toISOString() })]),
        report("openai-codex", [limit({ status: "exhausted", resetsAt: null })]),
      ],
      NOW,
    );
    expect(blocks.size).toBe(0);
  });
});

describe("parseProviderPriority", () => {
  it("accepts unique providers each with one of its own models", () => {
    expect(parseProviderPriority([{ provider: " anthropic ", model: " anthropic/claude-x:high " }])).toEqual({
      ok: true,
      entries: [{ provider: "anthropic", model: "anthropic/claude-x:high" }],
    });
  });

  it.each([
    ["not an array", { provider: "anthropic" }],
    ["a model of another provider", [{ provider: "anthropic", model: "openai/gpt-5" }]],
    ["a role instead of a model", [{ provider: "anthropic", model: "@slow" }]],
    ["a provider listed twice", [PRIORITY[0], { provider: "anthropic", model: "anthropic/claude-opus-4" }]],
    ["a missing provider", [{ model: "anthropic/claude-x" }]],
  ])("rejects %s", (_, value) => {
    expect(parseProviderPriority(value).ok).toBe(false);
  });
});
