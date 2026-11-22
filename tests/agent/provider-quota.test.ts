import { readFile, rm } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { chooseHelperModel, chooseProvider } from "@/lib/agent/provider-quota";
import { getAiStats } from "@/lib/stats";
import type { AiStats } from "@/lib/types";

vi.mock("@/lib/stats", () => ({ getAiStats: vi.fn() }));

const HOUR = 3_600_000;
const PRIORITY = [{ provider: "anthropic" }, { provider: "openai-codex" }, { provider: "github-copilot" }];
/** omp's model roles: each provider runs the model of a role on it ("default" first). */
const ROLES = {
  smol: "openai-codex/gpt-5-mini",
  default: "anthropic/claude-sonnet-4-5",
  slow: "openai-codex/gpt-5",
  plan: "github-copilot/claude-sonnet-4.5",
};
const SETTINGS = { ompPath: "omp", providerPriority: PRIORITY, defaultModel: "base" };

/** `omp usage` reporting `exhausted` providers out of quota for another hour. */
function usage(...exhausted: string[]): AiStats {
  const resetsAt = new Date(Date.now() + HOUR).toISOString();
  return {
    generatedAt: new Date().toISOString(),
    balances: [],
    quota: {
      available: true,
      error: null,
      providers: exhausted.map((provider) => ({
        provider,
        account: null,
        fetchedAt: null,
        limits: [
          {
            id: "5h",
            label: "5 Hour",
            windowLabel: "5 Hour",
            resetsAt,
            used: 100,
            limit: 100,
            usedFraction: 1,
            unit: "percent",
            status: "exhausted",
          },
        ],
      })),
    },
    usage: { available: false, error: null, totals: null, byModel: [], byAgent: [], series: [] },
  };
}

beforeEach(() => {
  vi.mocked(getAiStats).mockReset();
});

describe("chooseProvider", () => {
  it("picks Main while it has quota", async () => {
    vi.mocked(getAiStats).mockResolvedValue(usage());
    expect(await chooseProvider(SETTINGS, null, ROLES)).toMatchObject({
      entry: { provider: "anthropic", model: "anthropic/claude-sonnet-4-5" },
      index: 0,
    });
  });

  it("picks the first backup with quota while Main is out of quota", async () => {
    vi.mocked(getAiStats).mockResolvedValue(usage("anthropic"));
    expect(await chooseProvider(SETTINGS, " ", ROLES)).toMatchObject({
      entry: { provider: "openai-codex", model: "openai-codex/gpt-5-mini" },
      index: 1,
      fallbacks: ["github-copilot/claude-sonnet-4.5"],
    });
  });

  it("skips a provider no role uses, and picks nothing while omp's roles are unknown", async () => {
    vi.mocked(getAiStats).mockResolvedValue(usage());
    const { default: _unused, ...withoutAnthropic } = ROLES;
    expect(await chooseProvider(SETTINGS, null, withoutAnthropic)).toMatchObject({
      entry: { provider: "openai-codex" },
      index: 0,
      fallbacks: ["github-copilot/claude-sonnet-4.5"],
    });
    expect(await chooseProvider(SETTINGS, null, null)).toBeNull();
  });

  it("leaves a board's pinned model and an empty list alone, without reading omp usage", async () => {
    expect(await chooseProvider(SETTINGS, "anthropic/claude-opus-4", ROLES)).toBeNull();
    expect(await chooseProvider({ ...SETTINGS, providerPriority: [] }, null, ROLES)).toBeNull();
    expect(getAiStats).not.toHaveBeenCalled();
  });
});

describe("chooseHelperModel", () => {
  it("runs a helper on the picked backup, with a config that falls back to the later providers", async () => {
    vi.mocked(getAiStats).mockResolvedValue(usage("anthropic"));
    const choice = await chooseHelperModel({ settings: SETTINGS, pinned: null, roles: [["smol", "anthropic/claude-haiku"]], modelRoles: ROLES });
    expect(choice).toMatchObject({ model: "openai-codex/gpt-5-mini", role: null });
    expect(JSON.parse(await readFile(choice.config!, "utf8"))).toEqual({
      retry: {
        modelFallback: true,
        fallbackOn: "any",
        fallbackRevertPolicy: "cooldown-expiry",
        fallbackChains: { "openai-codex/*": ["github-copilot/claude-sonnet-4.5"] },
      },
    });
    await rm(choice.config!);
  });

  it("keeps a role on the picked provider, and a board pin over both", async () => {
    vi.mocked(getAiStats).mockResolvedValue(usage());
    const roles = [["smol", "anthropic/claude-haiku:low"]] as const;
    const modelRoles = ROLES;
    const onProvider = await chooseHelperModel({ settings: SETTINGS, pinned: null, roles, modelRoles });
    expect(onProvider).toMatchObject({ model: "@smol", role: "smol" });
    await rm(onProvider.config!);
    expect(await chooseHelperModel({ settings: SETTINGS, pinned: "openai/gpt-5", roles, modelRoles })).toEqual({
      model: "openai/gpt-5",
      role: null,
      config: null,
    });
  });

  it("keeps today's role, pin, default order with an empty provider priority", async () => {
    const settings = { ...SETTINGS, providerPriority: [] };
    expect(await chooseHelperModel({ settings, pinned: "pinned", roles: [["smol", "x/fast"]] })).toEqual({
      model: "@smol",
      role: "smol",
      config: null,
    });
    expect(await chooseHelperModel({ settings, pinned: "pinned", roles: [["smol", undefined]] })).toMatchObject({ model: "pinned" });
    expect(await chooseHelperModel({ settings, pinned: null, roles: [] })).toMatchObject({ model: "base" });
  });
});
