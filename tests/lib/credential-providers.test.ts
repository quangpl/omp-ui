import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_PROVIDERS,
  getCredentialProvider,
  isCredentialProviderId,
  maskSecret,
  mcpConfigSnippet,
  validateCredentialFields,
  validateCredentialInput,
} from "@/lib/credential-providers";
import { CREDENTIAL_PROVIDER_IDS, type CredentialProvider } from "@/lib/credential-types";

function provider(id: string): CredentialProvider {
  const found = getCredentialProvider(id);
  if (!found) throw new Error(`missing provider ${id}`);
  return found;
}

const GITHUB_TOKEN = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";

describe("CREDENTIAL_PROVIDERS", () => {
  it("covers every provider id exactly once, in order", () => {
    expect(CREDENTIAL_PROVIDERS.map((p) => p.id)).toEqual([...CREDENTIAL_PROVIDER_IDS]);
  });

  it.each(CREDENTIAL_PROVIDERS.map((p) => [p.id, p] as const))("%s is well formed", (_id, p) => {
    expect(p.fields.some((field) => field.kind === "secret")).toBe(true);
    expect(p.monogram).toHaveLength(2);
    expect(p.brandColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(p.healthCheck).not.toBe("");
    expect(new Set(p.fields.map((field) => field.key)).size).toBe(p.fields.length);
    for (const field of p.fields) {
      if (field.required) expect(field.label.trim()).not.toBe("");
      if (field.pattern) expect(() => new RegExp(field.pattern!)).not.toThrow();
    }
  });

  it("looks providers up by id", () => {
    expect(getCredentialProvider("github")?.name).toBe("GitHub");
    expect(getCredentialProvider("nope")).toBeUndefined();
    expect(isCredentialProviderId("mcp-http")).toBe(true);
    expect(isCredentialProviderId("nope")).toBe(false);
    expect(isCredentialProviderId(42)).toBe(false);
  });
});

describe("validateCredentialFields", () => {
  it("accepts a valid GitHub token", () => {
    expect(validateCredentialFields(provider("github"), { token: GITHUB_TOKEN })).toEqual({});
  });

  it("requires required fields", () => {
    expect(validateCredentialFields(provider("github"), { token: "   " })).toHaveProperty("token");
    expect(validateCredentialFields(provider("github"), {})).toHaveProperty("token");
  });

  it("reports the pattern hint for a malformed value", () => {
    const github = provider("github");
    const errors = validateCredentialFields(github, { token: "not-a-token" });
    expect(errors.token).toBe(github.fields.find((field) => field.key === "token")?.patternHint);
  });

  it("keeps a stored secret when the required secret is left empty", () => {
    expect(validateCredentialFields(provider("github"), { token: "" }, { existingSecrets: ["token"] })).toEqual({});
    expect(validateCredentialFields(provider("github"), {}, { existingSecrets: new Set(["token"]) })).toEqual({});
  });

  it("rejects invalid and non-http URLs", () => {
    expect(validateCredentialFields(provider("mcp-http"), { url: "not a url" })).toHaveProperty("url");
    expect(validateCredentialFields(provider("mcp-http"), { url: "ftp://example.com/mcp" })).toHaveProperty("url");
    expect(validateCredentialFields(provider("mcp-http"), { url: "https://example.com/mcp" })).toEqual({});
  });

  it("rejects unknown field keys", () => {
    expect(validateCredentialFields(provider("github"), { token: GITHUB_TOKEN, bogus: "x" })).toEqual({
      bogus: "Unknown field",
    });
  });

  it("checks AWS key formats", () => {
    const aws = provider("aws");
    const valid = {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    };
    expect(validateCredentialFields(aws, valid)).toEqual({});
    expect(validateCredentialFields(aws, { ...valid, accessKeyId: "AKIA123" })).toHaveProperty("accessKeyId");
    expect(validateCredentialFields(aws, { ...valid, region: "mars" })).toHaveProperty("region");
  });
});

describe("validateCredentialInput", () => {
  it("requires a name", () => {
    expect(validateCredentialInput({ name: "  ", fields: { token: GITHUB_TOKEN } }, provider("github"))).toHaveProperty(
      "name",
    );
    expect(validateCredentialInput({ fields: { token: GITHUB_TOKEN } }, provider("github"))).toHaveProperty("name");
  });

  it("limits the name length", () => {
    const errors = validateCredentialInput({ name: "x".repeat(81), fields: { token: GITHUB_TOKEN } }, provider("github"));
    expect(errors).toHaveProperty("name");
  });

  it("validates expiresAt", () => {
    const base = { name: "Work", fields: { token: GITHUB_TOKEN } };
    expect(validateCredentialInput({ ...base, expiresAt: null }, provider("github"))).toEqual({});
    expect(validateCredentialInput({ ...base, expiresAt: "" }, provider("github"))).toEqual({});
    expect(validateCredentialInput({ ...base, expiresAt: "2027-01-31" }, provider("github"))).toEqual({});
    expect(validateCredentialInput({ ...base, expiresAt: "someday" }, provider("github"))).toHaveProperty("expiresAt");
  });
});

describe("maskSecret", () => {
  it("hides short values completely", () => {
    expect(maskSecret("short")).toBe("••••••••");
    expect(maskSecret("12345678901")).toBe("••••••••");
  });

  it("keeps four characters at each end of long values", () => {
    expect(maskSecret("sk-ant-api03-abcdefWXYZ")).toBe("sk-a••••WXYZ");
  });
});

describe("mcpConfigSnippet", () => {
  it("returns null for providers without an MCP server", () => {
    expect(mcpConfigSnippet(provider("custom-api"))).toBeNull();
  });

  it("uses env placeholders for stdio secrets and inlines other values", () => {
    const fields = {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: "session-token-value-1234567890",
      region: "eu-west-2",
    };
    const snippet = mcpConfigSnippet(provider("aws"), fields)!;
    expect(snippet).not.toContain(fields.secretAccessKey);
    expect(snippet).not.toContain(fields.sessionToken);
    const server = JSON.parse(snippet).mcpServers.aws;
    expect(server.command).toBe("uvx");
    expect(server.env).toEqual({
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "${AWS_SECRET_ACCESS_KEY}",
      AWS_SESSION_TOKEN: "${AWS_SESSION_TOKEN}",
      AWS_REGION: "eu-west-2",
    });
  });

  it("puts http secrets in a bearer header placeholder", () => {
    const snippet = mcpConfigSnippet(provider("github"), { token: GITHUB_TOKEN })!;
    expect(snippet).not.toContain(GITHUB_TOKEN);
    expect(JSON.parse(snippet).mcpServers.github).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
    });
  });

  it("inlines the custom MCP server URL and honours the header name", () => {
    const token = "custom-secret-token-0123456789";
    const snippet = mcpConfigSnippet(provider("mcp-http"), {
      url: "https://mcp.example.com/mcp",
      token,
      headerName: "X-Api-Key",
    })!;
    expect(snippet).not.toContain(token);
    expect(JSON.parse(snippet).mcpServers["mcp-http"]).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Api-Key": "${MCP_SERVER_TOKEN}" },
    });
  });
});
