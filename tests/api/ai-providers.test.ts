import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api, freshEnv, setupAdmin, teardown } from "./helpers";

import * as aiProvidersRoute from "@/app/api/v1/settings/ai-providers/route";
import * as aiProviderTestRoute from "@/app/api/v1/settings/ai-providers/test/route";
import {
  AI_PROVIDER_ENV_VARS,
  AI_PROVIDER_IDS,
  type AiProviderState,
  type AiProvidersResponse,
  type AiProviderTestResponse,
} from "@/lib/ai-providers";
import { childEnv, setProviderEnv } from "@/lib/child-env";
import { getRepo } from "@/lib/db";
import { loadAiProviderEnv } from "@/lib/server/ai-providers";

const OPENAI_KEY = "sk-test-openai-4f9c2b7e1a";
const GROQ_ENV_KEY = "gsk_env_8d3a5c1f0b";
const GROQ_SAVED_KEY = "gsk_saved_2e7b9d4c6a";
const MISTRAL_KEY = "mistral-test-key-7c1e5a9f3d";

// The developer's own provider keys must not leak into these assertions (nor reach the fake omp).
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  for (const envVar of AI_PROVIDER_ENV_VARS) {
    savedEnv.set(envVar, process.env[envVar]);
    delete process.env[envVar];
  }
});

afterAll(async () => {
  await teardown();
  setProviderEnv({});
  for (const [envVar, value] of savedEnv) {
    if (value === undefined) delete process.env[envVar];
    else process.env[envVar] = value;
  }
});

beforeEach(async () => {
  await freshEnv();
  await setupAdmin();
  // The child-env overlay lives on globalThis and outlives the previous suite's database.
  setProviderEnv({});
});

async function list(query = "?refresh=1"): Promise<AiProvidersResponse> {
  const res = await api<AiProvidersResponse>(aiProvidersRoute, "GET", `/settings/ai-providers${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function patch(body: unknown): Promise<AiProvidersResponse> {
  const res = await api<AiProvidersResponse>(aiProvidersRoute, "PATCH", "/settings/ai-providers", { body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function provider(response: AiProvidersResponse, id: string): AiProviderState {
  const state = response.providers.find((p) => p.id === id);
  if (!state) throw new Error(`provider ${id} missing`);
  return state;
}

describe("GET /settings/ai-providers", () => {
  it("lists every catalog provider in order, not configured without keys", async () => {
    const body = await list();
    expect(body.providers.map((p) => p.id)).toEqual([...AI_PROVIDER_IDS]);
    expect(body.providers).toHaveLength(11);
    for (const state of body.providers) {
      expect(state.status, state.id).toBe("not-configured");
      expect(state.models).toEqual([]);
      expect(state.lastTest).toBeNull();
    }
  });

  it("requires authentication", async () => {
    const res = await api(aiProvidersRoute, "GET", "/settings/ai-providers", { token: null });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /settings/ai-providers", () => {
  it("saves a key sealed, masks it and applies it to omp children without a restart", async () => {
    const body = await patch({ providerId: "openai", values: { OPENAI_API_KEY: OPENAI_KEY } });
    const openai = provider(body, "openai");
    expect(openai.status).toBe("authenticated");
    expect(openai.models).toEqual([
      { selector: "openai/gpt-fake", name: "GPT Fake" },
      { selector: "openai/gpt-fake-mini", name: "GPT Fake Mini" },
    ]);
    const field = openai.fields.OPENAI_API_KEY;
    expect(field.source).toBe("settings");
    expect(field.value).toBeTruthy();
    expect(field.value).not.toBe(OPENAI_KEY);
    expect(field.value).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(body)).not.toContain(OPENAI_KEY);

    const raw = await (await getRepo()).getSetting("ai_providers");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(OPENAI_KEY);

    expect(childEnv().OPENAI_API_KEY).toBe(OPENAI_KEY);
    // Other providers stay untouched.
    expect(provider(body, "groq").status).toBe("not-configured");
  });

  it("lets a saved value override the server environment until it is cleared", async () => {
    process.env.GROQ_API_KEY = GROQ_ENV_KEY;
    try {
      const before = provider(await list(), "groq");
      expect(before.fields.GROQ_API_KEY.source).toBe("environment");
      expect(before.fields.GROQ_API_KEY.overridesEnvironment).toBe(false);
      expect(before.status).toBe("authenticated");

      const saved = provider(await patch({ providerId: "groq", values: { GROQ_API_KEY: GROQ_SAVED_KEY } }), "groq");
      expect(saved.fields.GROQ_API_KEY.source).toBe("settings");
      expect(saved.fields.GROQ_API_KEY.overridesEnvironment).toBe(true);
      expect(childEnv().GROQ_API_KEY).toBe(GROQ_SAVED_KEY);

      const cleared = provider(await patch({ providerId: "groq", clear: ["GROQ_API_KEY"] }), "groq");
      expect(cleared.fields.GROQ_API_KEY.source).toBe("environment");
      expect(cleared.fields.GROQ_API_KEY.overridesEnvironment).toBe(false);
      expect(childEnv().GROQ_API_KEY).toBe(GROQ_ENV_KEY);
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });

  it("rejects bad formats, foreign env vars and unknown providers", async () => {
    const badFormat = await api<{ error: string; fields: Record<string, string> }>(
      aiProvidersRoute,
      "PATCH",
      "/settings/ai-providers",
      { body: { providerId: "openai", values: { OPENAI_API_KEY: "nope" } } },
    );
    expect(badFormat.status).toBe(400);
    expect(badFormat.body.fields.OPENAI_API_KEY).toBeTruthy();

    const foreign = await api<{ error: string; fields: Record<string, string> }>(
      aiProvidersRoute,
      "PATCH",
      "/settings/ai-providers",
      { body: { providerId: "openai", values: { LD_PRELOAD: "x" } } },
    );
    expect(foreign.status).toBe(400);
    expect(foreign.body.fields.LD_PRELOAD).toBeTruthy();
    expect(childEnv().LD_PRELOAD).toBe(process.env.LD_PRELOAD);
    expect(childEnv().LD_PRELOAD).not.toBe("x");

    const unknown = await api(aiProvidersRoute, "PATCH", "/settings/ai-providers", {
      body: { providerId: "not-a-provider", values: {} },
    });
    expect(unknown.status).toBe(400);

    // Nothing was saved.
    expect(await (await getRepo()).getSetting("ai_providers")).toBeNull();
    expect(provider(await list(), "openai").status).toBe("not-configured");
  });
});

describe("POST /settings/ai-providers/test", () => {
  it("answers 400 when there is nothing to test", async () => {
    const res = await api(aiProviderTestRoute, "POST", "/settings/ai-providers/test", {
      body: { providerId: "mistral" },
    });
    expect(res.status).toBe(400);
  });

  it("probes the provider with the saved key and keeps the failed result until the key changes", async () => {
    await patch({ providerId: "mistral", values: { MISTRAL_API_KEY: MISTRAL_KEY } });

    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Unauthorized", request_id: "fake" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    let tested: AiProviderTestResponse;
    try {
      const res = await api<AiProviderTestResponse>(aiProviderTestRoute, "POST", "/settings/ai-providers/test", {
        body: { providerId: "mistral" },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      tested = res.body;
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchMock).toHaveBeenCalled();
    expect(tested.result.ok).toBe(false);
    expect(tested.result.message).toBeTruthy();
    expect(tested.result.message).not.toContain(MISTRAL_KEY);
    expect(tested.provider.status).toBe("error");
    expect(tested.provider.lastTest).toEqual(tested.result);

    const after = provider(await list(), "mistral");
    expect(after.lastTest).toEqual(tested.result);
    expect(after.status).toBe("error");

    const changed = provider(
      await patch({ providerId: "mistral", values: { MISTRAL_API_KEY: `${MISTRAL_KEY}-rotated` } }),
      "mistral",
    );
    expect(changed.lastTest).toBeNull();
  });
});

describe("boot", () => {
  it("decrypts the saved values into the child environment", async () => {
    await patch({ providerId: "openai", values: { OPENAI_API_KEY: OPENAI_KEY } });
    setProviderEnv({});
    expect(childEnv().OPENAI_API_KEY).toBeUndefined();

    await loadAiProviderEnv(await getRepo());
    expect(childEnv().OPENAI_API_KEY).toBe(OPENAI_KEY);
  });
});
