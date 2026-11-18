import { describe, expect, it, vi } from "vitest";

import { fetchDeepSeekBalance, mapDeepSeekBalance } from "@/lib/ai-balance";

const BALANCE = {
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
  ],
};

describe("mapDeepSeekBalance", () => {
  it("maps the balance body, parsing string amounts and availability", () => {
    expect(mapDeepSeekBalance(BALANCE)).toEqual({
      provider: "deepseek",
      currency: "CNY",
      total: 110,
      granted: 10,
      toppedUp: 100,
      available: true,
    });
  });

  it("reads numeric amounts and a missing availability", () => {
    expect(
      mapDeepSeekBalance({ balance_infos: [{ currency: "USD", total_balance: 4.5 }] }),
    ).toEqual({ provider: "deepseek", currency: "USD", total: 4.5, granted: null, toppedUp: null, available: null });
  });

  it("returns null when there is no balance or the total is unreadable", () => {
    expect(mapDeepSeekBalance({})).toBeNull();
    expect(mapDeepSeekBalance({ balance_infos: [] })).toBeNull();
    expect(mapDeepSeekBalance({ balance_infos: [{ currency: "CNY" }] })).toBeNull();
    expect(mapDeepSeekBalance("not an object")).toBeNull();
  });
});

describe("fetchDeepSeekBalance", () => {
  it("returns null without an API key and never calls fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchDeepSeekBalance({}, fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the bearer key and maps a successful response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(BALANCE), { status: 200 }),
    );
    await expect(fetchDeepSeekBalance({ DEEPSEEK_API_KEY: "sk-test" }, fetchImpl)).resolves.toEqual({
      provider: "deepseek",
      currency: "CNY",
      total: 110,
      granted: 10,
      toppedUp: 100,
      available: true,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/user/balance");
    expect(new Headers(init?.headers as HeadersInit).get("authorization")).toBe("Bearer sk-test");
  });

  it("returns null on a non-ok response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(fetchDeepSeekBalance({ DEEPSEEK_API_KEY: "sk-test" }, fetchImpl)).resolves.toBeNull();
  });

  it("returns null when the request fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("network"));
    await expect(fetchDeepSeekBalance({ DEEPSEEK_API_KEY: "sk-test" }, fetchImpl)).resolves.toBeNull();
  });
});
