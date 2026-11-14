import { describe, expect, it, type Mock, vi } from "vitest";

import { getAiProvider, type AiProviderDefinition } from "@/lib/ai-providers";
import { probeAiProvider } from "@/lib/server/credential-checks";

function provider(id: string): AiProviderDefinition {
  const found = getAiProvider(id);
  if (!found) throw new Error(`Unknown AI provider ${id}`);
  return found;
}

function respond(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });
}

function mockFetch(...responses: Response[]): Mock<typeof fetch> {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response);
  return fetchImpl;
}

function sent(fetchImpl: Mock<typeof fetch>, call = 0) {
  const [input, init] = fetchImpl.mock.calls[call];
  return { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body };
}

describe("probeAiProvider: Bearer-key providers", () => {
  const cases = [
    { id: "groq", envVar: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1/models", key: "gsk_testkey0123456789abcdef" },
    { id: "xai", envVar: "XAI_API_KEY", url: "https://api.x.ai/v1/models", key: "xai-testkey0123456789abcdef" },
    { id: "mistral", envVar: "MISTRAL_API_KEY", url: "https://api.mistral.ai/v1/models", key: "mistralkey0123456789abcdef" },
    { id: "deepseek", envVar: "DEEPSEEK_API_KEY", url: "https://api.deepseek.com/models", key: "sk-deepseek0123456789abcdef" },
    { id: "cerebras", envVar: "CEREBRAS_API_KEY", url: "https://api.cerebras.ai/v1/models", key: "csk-testkey0123456789abcdef" },
  ];

  it.each(cases)("$id: one GET to $url with the trimmed Bearer key, model count on success", async ({ id, envVar, url, key }) => {
    const fetchImpl = mockFetch(respond({ object: "list", data: [{ id: "model-a" }, { id: "model-b" }] }));
    const result = await probeAiProvider(provider(id), { [envVar]: `  ${key}\n` }, { fetchImpl });

    expect(result?.ok).toBe(true);
    expect(result?.message).toContain("2 models");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = sent(fetchImpl);
    expect(request.url).toBe(url);
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
  });

  it.each(cases)("$id: a 401 reports the provider's error without the key", async ({ id, envVar, key }) => {
    const fetchImpl = mockFetch(
      respond(
        { error: { message: `Incorrect API key provided: ${key}`, type: "invalid_request_error" } },
        { status: 401, statusText: "Unauthorized" },
      ),
    );
    const result = await probeAiProvider(provider(id), { [envVar]: key }, { fetchImpl });

    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("Incorrect API key provided");
    expect(result?.message).not.toContain(key);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("probeAiProvider: anthropic", () => {
  const anthropic = provider("anthropic");
  const API_KEY = "sk-ant-api03-testkey0123456789";
  const OAUTH_TOKEN = "sk-ant-oat01-testtoken0123456789";

  it("prefers the OAuth token over the API key", async () => {
    const fetchImpl = mockFetch(respond({ data: [{ id: "claude-a" }] }));
    const result = await probeAiProvider(
      anthropic,
      { ANTHROPIC_API_KEY: API_KEY, ANTHROPIC_OAUTH_TOKEN: OAUTH_TOKEN },
      { fetchImpl },
    );

    expect(result?.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://api.anthropic.com/v1/models");
    expect(request.headers.get("authorization")).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(request.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(request.headers.has("x-api-key")).toBe(false);
  });

  it("sends the API key as x-api-key when it is the only value", async () => {
    const fetchImpl = mockFetch(respond({ data: [{ id: "claude-a" }, { id: "claude-b" }] }));
    const result = await probeAiProvider(anthropic, { ANTHROPIC_API_KEY: API_KEY }, { fetchImpl });

    expect(result?.ok).toBe(true);
    expect(result?.message).toContain("2 models");
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://api.anthropic.com/v1/models");
    expect(request.headers.get("x-api-key")).toBe(API_KEY);
    expect(request.headers.has("authorization")).toBe(false);
  });
});

describe("probeAiProvider: azure", () => {
  const azure = provider("azure");
  const KEY = "azurekey0123456789abcdef0123";

  it("builds the URL from the resource name and sends the api-key header", async () => {
    const fetchImpl = mockFetch(respond({ data: [{ id: "gpt-4o" }] }));
    const result = await probeAiProvider(
      azure,
      { AZURE_OPENAI_API_KEY: KEY, AZURE_OPENAI_RESOURCE_NAME: "my-resource" },
      { fetchImpl },
    );

    expect(result?.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://my-resource.openai.azure.com/openai/models?api-version=2024-10-21");
    expect(request.headers.get("api-key")).toBe(KEY);
    expect(request.headers.has("authorization")).toBe(false);
  });

  it("uses the base URL's origin over the resource name and a custom API version", async () => {
    const fetchImpl = mockFetch(respond({ data: [] }));
    const result = await probeAiProvider(
      azure,
      {
        AZURE_OPENAI_API_KEY: KEY,
        AZURE_OPENAI_RESOURCE_NAME: "ignored-resource",
        AZURE_OPENAI_BASE_URL: "https://ai.example.com/openai/v1",
        AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
      },
      { fetchImpl },
    );

    expect(result?.ok).toBe(true);
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://ai.example.com/openai/models?api-version=2025-04-01-preview");
    expect(request.headers.get("api-key")).toBe(KEY);
  });

  it("is incomplete without a resource name or base URL and makes no request", async () => {
    const fetchImpl = mockFetch();
    const result = await probeAiProvider(azure, { AZURE_OPENAI_API_KEY: KEY }, { fetchImpl });

    expect(result?.ok).toBe(false);
    expect(result?.message.startsWith("Incomplete")).toBe(true);
    expect(result?.message).not.toContain(KEY);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("probeAiProvider: amazon-bedrock", () => {
  const bedrock = provider("amazon-bedrock");
  const ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
  const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
  const SESSION_TOKEN = "FwoGZXIvYXdzEXAMPLESESSIONTOKEN";
  const BEDROCK_API_KEY = "ABSKbedrockapikey0123456789";

  it("signs ListFoundationModels with SigV4 in us-east-1 by default", async () => {
    const fetchImpl = mockFetch(respond({ modelSummaries: [{ modelId: "a" }, { modelId: "b" }, { modelId: "c" }] }));
    const result = await probeAiProvider(
      bedrock,
      { AWS_ACCESS_KEY_ID: ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY },
      { fetchImpl },
    );

    expect(result?.ok).toBe(true);
    expect(result?.message).toContain("3 Bedrock models");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://bedrock.us-east-1.amazonaws.com/foundation-models");
    expect(request.method).toBe("GET");
    const authorization = request.headers.get("authorization") ?? "";
    expect(authorization.startsWith("AWS4-HMAC-SHA256")).toBe(true);
    expect(authorization).toContain(`Credential=${ACCESS_KEY_ID}/`);
    expect(authorization).toContain("/us-east-1/bedrock/aws4_request");
    expect(authorization).not.toContain(SECRET_ACCESS_KEY);
    expect(request.headers.has("x-amz-security-token")).toBe(false);
  });

  it("respects AWS_REGION and sends the session token", async () => {
    const fetchImpl = mockFetch(respond({ modelSummaries: [] }));
    const result = await probeAiProvider(
      bedrock,
      {
        AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: SESSION_TOKEN,
        AWS_REGION: "eu-central-1",
      },
      { fetchImpl },
    );

    expect(result?.ok).toBe(true);
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://bedrock.eu-central-1.amazonaws.com/foundation-models");
    expect(request.headers.get("authorization")).toContain("/eu-central-1/bedrock/aws4_request");
    expect(request.headers.get("x-amz-security-token")).toBe(SESSION_TOKEN);
  });

  it("never echoes the secret access key in a failure", async () => {
    const fetchImpl = mockFetch(
      respond(
        { message: `The request signature we calculated does not match (secret ${SECRET_ACCESS_KEY})` },
        { status: 403, statusText: "Forbidden" },
      ),
    );
    const result = await probeAiProvider(
      bedrock,
      { AWS_ACCESS_KEY_ID: ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY },
      { fetchImpl },
    );

    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("signature");
    expect(result?.message).not.toContain(SECRET_ACCESS_KEY);
  });

  it("sends a Bedrock API key as a Bearer token to the same URL", async () => {
    const fetchImpl = mockFetch(respond({ modelSummaries: [{ modelId: "a" }] }));
    const result = await probeAiProvider(bedrock, { AWS_BEARER_TOKEN_BEDROCK: BEDROCK_API_KEY }, { fetchImpl });

    expect(result?.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://bedrock.us-east-1.amazonaws.com/foundation-models");
    expect(request.headers.get("authorization")).toBe(`Bearer ${BEDROCK_API_KEY}`);
  });

  it("returns null for an AWS profile without making a request", async () => {
    const fetchImpl = mockFetch();
    const result = await probeAiProvider(bedrock, { AWS_PROFILE: "dev" }, { fetchImpl });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("probeAiProvider: incomplete and network failures", () => {
  it("reports missing values without a request", async () => {
    const fetchImpl = mockFetch();
    const result = await probeAiProvider(provider("openai"), {}, { fetchImpl });

    expect(result?.ok).toBe(false);
    expect(result?.message.startsWith("Incomplete")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a rejected fetch into ok:false without the key", async () => {
    const key = "sk-proj-networkfailure0123456789";
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockRejectedValueOnce(
      new TypeError("fetch failed", { cause: new Error(`getaddrinfo ENOTFOUND api.openai.com (key ${key})`) }),
    );

    const result = await probeAiProvider(provider("openai"), { OPENAI_API_KEY: key }, { fetchImpl });

    expect(result?.ok).toBe(false);
    expect(result?.message).toBeTruthy();
    expect(result?.message).not.toContain(key);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
