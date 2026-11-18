// Health checks for /credentials and Settings → AI Providers: one cheap, read-only, authenticated
// request per provider that never spends credits or mutates data. Server only: the AWS signer uses
// node:crypto, Postgres pg.
import { createHash, createHmac } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import pg from "pg";

import { completeMethod, type AiAuthMethod, type AiProviderDefinition } from "@/lib/ai-providers";
import type { CredentialProvider } from "@/lib/credential-types";

export interface CredentialProbeResult {
  ok: boolean;
  message: string;
}

export interface CredentialProbeOptions {
  /** Budget for the whole check (all requests together). */
  timeoutMs?: number;
  /** Injected by tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 200;
/** Health-check bodies are tiny; stop reading anything bigger (an HTML error page, a stream). */
const MAX_BODY_CHARS = 256 * 1024;
const USER_AGENT = "agentman-credential-check";
/** Field keys that hold secrets even if a provider template forgets to mark them `secret`. */
const SECRET_KEYS = ["apiKey", "token", "apiToken", "secretAccessKey", "sessionToken", "connectionString"];
const MCP_INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentman", version: "1" } },
});

interface ProbeContext {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  timeoutMs: number;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  text: string;
  /** Parsed JSON body, or undefined when the body is not JSON. */
  body: unknown;
}

/** Thrown inside a probe to fail with exactly this message. */
class ProbeFailure extends Error {}

/**
 * Check that `fields` authenticate against `provider`. Never throws: timeouts, network errors and
 * provider errors all come back as `{ ok: false, message }`, and secret values are scrubbed from
 * every message.
 */
export async function probeCredential(
  provider: CredentialProvider,
  fields: Record<string, string>,
  options: CredentialProbeOptions = {},
): Promise<CredentialProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let secrets: string[] = [];
  let result: CredentialProbeResult;
  try {
    secrets = secretValues(provider, fields);
    const ctx: ProbeContext = {
      fetchImpl: options.fetchImpl ?? fetch,
      signal: AbortSignal.timeout(timeoutMs),
      timeoutMs,
    };
    result = await runProbe(provider, fields, ctx);
  } catch (err) {
    result = fail(describeError(err, timeoutMs));
  }
  return { ok: result.ok, message: clean(result.message, secrets) };
}

async function runProbe(
  provider: CredentialProvider,
  fields: Record<string, string>,
  ctx: ProbeContext,
): Promise<CredentialProbeResult> {
  // Single-secret providers: the catalog names the field apiKey, token or apiToken.
  const key = () => need(value(fields, "apiKey", "token", "apiToken"), "API key");
  const id = provider.id;
  switch (id) {
    case "anthropic":
      return probeAnthropic(ctx, key());
    case "openai":
      return probeOpenAi(ctx, key());
    case "google-gemini":
      return probeGemini(ctx, key());
    case "openrouter":
      return probeOpenRouter(ctx, key());
    case "huggingface":
      return probeHuggingFace(ctx, key());
    case "github":
      return probeGitHub(ctx, need(value(fields, "token"), "token"), value(fields, "host"));
    case "gitlab":
      return probeGitLab(ctx, need(value(fields, "token"), "token"), value(fields, "host"));
    case "sentry":
      return probeSentry(ctx, need(value(fields, "token"), "token"), value(fields, "host"));
    case "linear":
      return probeLinear(ctx, key());
    case "atlassian":
      return probeAtlassian(ctx, fields);
    case "figma":
      return probeFigma(ctx, key());
    case "slack":
      return probeSlack(ctx, key());
    case "notion":
      return probeNotion(ctx, key());
    case "aws":
      return probeAws(ctx, fields);
    case "cloudflare":
      return probeCloudflare(ctx, need(value(fields, "apiToken", "token"), "API token"), value(fields, "accountId"));
    case "vercel":
      return probeVercel(ctx, key());
    case "supabase":
      return probeSupabase(ctx, key());
    case "postgres":
      return probePostgres(need(value(fields, "connectionString"), "connection string"), ctx.timeoutMs);
    case "stripe":
      return probeStripe(ctx, key());
    case "brave-search":
      return probeBrave(ctx, key());
    case "tavily":
      return probeTavily(ctx, key());
    case "firecrawl":
      return probeFirecrawl(ctx, key());
    case "mcp-http":
      return probeMcpHttp(ctx, fields);
    case "smtp":
      return probeSmtp(fields, ctx.timeoutMs);
    case "telegram":
      return probeTelegram(ctx, need(value(fields, "token"), "bot token"));
    case "custom-api":
      return probeCustomApi(ctx, fields);
    default: {
      const unknown: never = id;
      return fail(`No health check for ${String(unknown)}`);
    }
  }
}

/**
 * Check that `values` (env var → value) authenticate against an AI provider, using the first
 * complete auth method. Never throws, scrubs every secret value from the message like
 * `probeCredential`. Returns null when the complete method cannot be checked over HTTP (an AWS
 * profile lives in the server's ~/.aws config): the caller falls back to omp's model listing.
 */
export async function probeAiProvider(
  provider: AiProviderDefinition,
  values: Record<string, string>,
  options: CredentialProbeOptions = {},
): Promise<CredentialProbeResult | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let secrets: string[] = [];
  let result: CredentialProbeResult | null;
  try {
    secrets = aiSecretValues(provider, values);
    const trimmed: Record<string, string> = {};
    for (const field of provider.fields) trimmed[field.envVar] = value(values, field.envVar);
    const method = completeMethod(provider, trimmed);
    if (!method) {
      result = fail(incompleteMessage(provider, trimmed));
    } else {
      const ctx: ProbeContext = {
        fetchImpl: options.fetchImpl ?? fetch,
        signal: AbortSignal.timeout(timeoutMs),
        timeoutMs,
      };
      result = await runAiProbe(provider, method, trimmed, ctx);
    }
  } catch (err) {
    result = fail(describeError(err, timeoutMs));
  }
  return result && { ok: result.ok, message: clean(result.message, secrets) };
}

/** "Incomplete: <first method> needs <missing fields>"; an `anyOf` group reads "A or B". */
function incompleteMessage(provider: AiProviderDefinition, values: Record<string, string>): string {
  const method = provider.methods[0];
  if (!method) return "Incomplete: no sign-in method";
  const label = (envVar: string) => provider.fields.find((f) => f.envVar === envVar)?.label ?? envVar;
  const missing = method.required.filter((envVar) => !values[envVar]).map(label);
  if (method.anyOf && !method.anyOf.some((envVar) => values[envVar])) missing.push(method.anyOf.map(label).join(" or "));
  return `Incomplete: ${method.label} needs ${missing.join(", ")}`;
}

async function runAiProbe(
  provider: AiProviderDefinition,
  method: AiAuthMethod,
  values: Record<string, string>,
  ctx: ProbeContext,
): Promise<CredentialProbeResult | null> {
  const env = (envVar: string) =>
    need(value(values, envVar), provider.fields.find((f) => f.envVar === envVar)?.label ?? envVar);
  const id = provider.id;
  switch (id) {
    case "anthropic":
      return method.id === "oauth"
        ? probeAnthropicOAuth(ctx, env("ANTHROPIC_OAUTH_TOKEN"))
        : probeAnthropic(ctx, env("ANTHROPIC_API_KEY"));
    case "openai":
      return probeOpenAi(ctx, env("OPENAI_API_KEY"));
    case "google":
      return probeGemini(ctx, env("GEMINI_API_KEY"));
    case "azure":
      return probeAzureOpenAi(ctx, values);
    case "amazon-bedrock": {
      if (method.id === "profile") return null;
      const auth: BedrockAuth =
        method.id === "bedrock-api-key"
          ? { token: env("AWS_BEARER_TOKEN_BEDROCK") }
          : {
              accessKeyId: env("AWS_ACCESS_KEY_ID"),
              secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
              sessionToken: value(values, "AWS_SESSION_TOKEN"),
            };
      return probeBedrock(ctx, auth, value(values, "AWS_REGION"));
    }
    case "openrouter":
      return probeOpenRouter(ctx, env("OPENROUTER_API_KEY"));
    case "groq":
      return probeBearerModels(ctx, "https://api.groq.com/openai/v1/models", env("GROQ_API_KEY"));
    case "xai":
      return probeBearerModels(ctx, "https://api.x.ai/v1/models", env("XAI_API_KEY"));
    case "mistral":
      return probeBearerModels(ctx, "https://api.mistral.ai/v1/models", env("MISTRAL_API_KEY"));
    case "deepseek":
      return probeBearerModels(ctx, "https://api.deepseek.com/models", env("DEEPSEEK_API_KEY"));
    case "cerebras":
      return probeBearerModels(ctx, "https://api.cerebras.ai/v1/models", env("CEREBRAS_API_KEY"));
    default: {
      const unknown: never = id;
      return fail(`No health check for ${String(unknown)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Providers

async function probeAnthropic(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) return httpFailure(res);
  return pass(`API key accepted${modelCount(get(res.body, "data"))}`);
}

async function probeOpenAi(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.openai.com/v1/models", { headers: bearer(key) });
  if (!res.ok) return httpFailure(res);
  return pass(`API key accepted${modelCount(get(res.body, "data"))}`);
}

/** A Claude subscription token (`claude setup-token`) is a Bearer token behind the OAuth beta header. */
async function probeAnthropicOAuth(ctx: ProbeContext, token: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.anthropic.com/v1/models", {
    headers: { ...bearer(token), "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
  });
  if (!res.ok) return httpFailure(res);
  return pass(`OAuth token accepted${modelCount(get(res.body, "data"))}`);
}

async function probeGemini(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
    headers: { "x-goog-api-key": key },
  });
  // Google answers an invalid key with 400 INVALID_ARGUMENT "API key not valid".
  if (!res.ok) return httpFailure(res, isRejection(res) || /api key/i.test(errorDetail(res)));
  return pass("API key accepted");
}

async function probeOpenRouter(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://openrouter.ai/api/v1/key", { headers: bearer(key) });
  if (!res.ok) return httpFailure(res);
  const label = str(get(res.body, "data", "label"));
  const usage = num(get(res.body, "data", "usage"));
  const limit = num(get(res.body, "data", "limit"));
  const parts: string[] = [];
  if (label) parts.push(`"${label}"`);
  if (usage !== undefined) parts.push(`$${usage.toFixed(2)} used${limit !== undefined ? ` of $${limit.toFixed(2)}` : ""}`);
  return pass(`API key accepted${parts.length ? ` (${parts.join(", ")})` : ""}`);
}

/** OpenAI-compatible `GET /models` with a Bearer key (Groq, xAI, Mistral, DeepSeek, Cerebras). */
async function probeBearerModels(ctx: ProbeContext, url: string, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, url, { headers: bearer(key) });
  if (!res.ok) return httpFailure(res);
  return pass(`API key accepted${modelCount(get(res.body, "data"))}`);
}

async function probeAzureOpenAi(ctx: ProbeContext, values: Record<string, string>): Promise<CredentialProbeResult> {
  const key = need(value(values, "AZURE_OPENAI_API_KEY"), "API key");
  const baseUrl = value(values, "AZURE_OPENAI_BASE_URL");
  const resource = value(values, "AZURE_OPENAI_RESOURCE_NAME");
  let origin: string;
  if (baseUrl) {
    origin = parseHttpUrl(baseUrl).origin;
  } else {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(resource)) return fail(`Invalid resource name "${resource}"`);
    origin = `https://${resource}.openai.azure.com`;
  }
  const apiVersion = value(values, "AZURE_OPENAI_API_VERSION") || "2024-10-21";
  const res = await request(ctx, `${origin}/openai/models?api-version=${encodeURIComponent(apiVersion)}`, {
    headers: { "api-key": key },
  });
  if (!res.ok) return httpFailure(res);
  return pass(`API key accepted${modelCount(get(res.body, "data"))}`);
}

type BedrockAuth = { token: string } | { accessKeyId: string; secretAccessKey: string; sessionToken: string };

/** `ListFoundationModels`, signed with access keys or sent with a Bedrock API key (Bearer). */
async function probeBedrock(ctx: ProbeContext, auth: BedrockAuth, regionInput: string): Promise<CredentialProbeResult> {
  const region = regionInput || "us-east-1";
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) return fail(`Invalid region "${region}"`);
  const host = `bedrock.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
  const path = "/foundation-models";
  const headers =
    "token" in auth
      ? bearer(auth.token)
      : signAwsV4({
          method: "GET",
          host,
          path,
          region,
          service: "bedrock",
          headers: {},
          body: "",
          accessKeyId: auth.accessKeyId,
          secretAccessKey: auth.secretAccessKey,
          sessionToken: auth.sessionToken || undefined,
          date: new Date(),
        });
  const res = await request(ctx, `https://${host}${path}`, { headers });
  if (!res.ok) return httpFailure(res);
  const models = get(res.body, "modelSummaries");
  const count = Array.isArray(models) && models.length ? ` (${plural(models.length, "Bedrock model")})` : "";
  return pass(`${"token" in auth ? "Bedrock API key" : "AWS credentials"} accepted${count}`);
}

async function probeHuggingFace(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://huggingface.co/api/whoami-v2", { headers: bearer(key) });
  if (!res.ok) return httpFailure(res);
  const role = str(get(res.body, "auth", "accessToken", "role"));
  return authenticatedAs(str(get(res.body, "name")), role ? `${role} token` : undefined);
}

async function probeGitHub(ctx: ProbeContext, token: string, host: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, `${githubApiBase(host)}/user`, {
    headers: { ...bearer(token), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) return httpFailure(res);
  return authenticatedAs(str(get(res.body, "login")));
}

/** github.com → api.github.com; a bare GitHub Enterprise Server URL → its /api/v3 REST root. */
function githubApiBase(host: string): string {
  const url = parseHttpUrl(host || "https://api.github.com");
  if (url.hostname === "github.com" || url.hostname === "www.github.com") return "https://api.github.com";
  if (!url.hostname.startsWith("api.") && !url.pathname.includes("/api/")) {
    url.pathname = url.pathname.replace(/\/*$/, "/api/v3");
  }
  return withoutTrailingSlash(url);
}

async function probeGitLab(ctx: ProbeContext, token: string, host: string): Promise<CredentialProbeResult> {
  const base = withoutTrailingSlash(parseHttpUrl(host || "https://gitlab.com")).replace(/\/api\/v4$/, "");
  const res = await request(ctx, `${base}/api/v4/user`, { headers: { "private-token": token } });
  if (!res.ok) return httpFailure(res);
  return authenticatedAs(str(get(res.body, "username")));
}

async function probeSentry(ctx: ProbeContext, token: string, host: string): Promise<CredentialProbeResult> {
  const base = withoutTrailingSlash(parseHttpUrl(host || "https://sentry.io")).replace(/\/api\/0$/, "");
  const res = await request(ctx, `${base}/api/0/organizations/`, { headers: bearer(token) });
  if (!res.ok) return httpFailure(res);
  if (!Array.isArray(res.body)) return pass("Token accepted");
  const slugs = res.body.map((org) => str(get(org, "slug"))).filter((slug) => slug !== undefined);
  return pass(`Access to ${plural(res.body.length, "organization")}${slugs.length ? ` (${slugs.join(", ")})` : ""}`);
}

async function probeLinear(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  // Personal API keys go in the header as-is; OAuth access tokens need the Bearer scheme.
  const authorization = key.startsWith("lin_api_") ? key : `Bearer ${key}`;
  const res = await request(ctx, "https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ query: "{ viewer { name email } }" }),
  });
  const code = str(get(res.body, "errors", "0", "extensions", "code"));
  if (!res.ok) return httpFailure(res, isRejection(res) || code === "AUTHENTICATION_ERROR");
  const name = str(get(res.body, "data", "viewer", "name"));
  if (!name) return fail(errorDetail(res) || "Linear answered without a viewer");
  const email = str(get(res.body, "data", "viewer", "email"));
  return authenticatedAs(name, email);
}

async function probeAtlassian(ctx: ProbeContext, fields: Record<string, string>): Promise<CredentialProbeResult> {
  const base = withoutTrailingSlash(parseHttpUrl(need(value(fields, "siteUrl"), "site URL")));
  const email = need(value(fields, "email"), "account email");
  const apiToken = need(value(fields, "apiToken", "token"), "API token");
  const res = await request(ctx, `${base}/rest/api/3/myself`, {
    headers: { authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}` },
  });
  if (!res.ok) return httpFailure(res);
  return authenticatedAs(str(get(res.body, "displayName")), str(get(res.body, "emailAddress")));
}

async function probeFigma(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.figma.com/v1/me", { headers: { "x-figma-token": key } });
  if (!res.ok) return httpFailure(res);
  return authenticatedAs(str(get(res.body, "handle")), str(get(res.body, "email")));
}

async function probeSlack(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://slack.com/api/auth.test", {
    method: "POST",
    headers: { ...bearer(key), "content-type": "application/x-www-form-urlencoded" },
    body: "",
  });
  if (!res.ok) return httpFailure(res);
  // Slack answers 200 even for bad tokens; the verdict is the `ok` flag.
  if (get(res.body, "ok") !== true) {
    return fail(`Token rejected (${str(get(res.body, "error")) ?? "unknown error"})`);
  }
  const user = str(get(res.body, "user"));
  const team = str(get(res.body, "team"));
  return pass(user ? `Authenticated as ${user}${team ? ` in ${team}` : ""}` : "Token accepted");
}

async function probeNotion(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.notion.com/v1/users/me", {
    headers: { ...bearer(key), "notion-version": "2022-06-28" },
  });
  if (!res.ok) return httpFailure(res);
  return authenticatedAs(str(get(res.body, "name")), str(get(res.body, "bot", "workspace_name")));
}

async function probeAws(ctx: ProbeContext, fields: Record<string, string>): Promise<CredentialProbeResult> {
  const accessKeyId = need(value(fields, "accessKeyId"), "access key ID");
  const secretAccessKey = need(value(fields, "secretAccessKey"), "secret access key");
  const sessionToken = value(fields, "sessionToken");
  const region = value(fields, "region") || "us-east-1";
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) return fail(`Invalid region "${region}"`);
  const host = `sts.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
  const body = "Action=GetCallerIdentity&Version=2011-06-15";
  const headers = signAwsV4({
    method: "POST",
    host,
    path: "/",
    region,
    service: "sts",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    date: new Date(),
  });
  const res = await request(ctx, `https://${host}/`, {
    method: "POST",
    headers: { ...headers, accept: "text/xml, application/json" },
    body,
  });
  if (!res.ok) return httpFailure(res);
  const arn =
    /<Arn>([^<]+)<\/Arn>/.exec(res.text)?.[1] ??
    str(get(res.body, "GetCallerIdentityResponse", "GetCallerIdentityResult", "Arn"));
  return arn ? pass(`Authenticated as ${arn}`) : fail("STS answered without a caller identity");
}

interface AwsSignInput {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  date: Date;
}

/**
 * AWS Signature Version 4 for a request without a query string. Returns the headers to send
 * (`host` is signed but left to fetch, which derives the same value from the URL).
 */
function signAwsV4(input: AwsSignInput): Record<string, string> {
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, val] of Object.entries(input.headers)) headers[name.toLowerCase()] = val;
  headers.host = input.host;
  headers["x-amz-date"] = amzDate;
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const payloadHash = createHash("sha256").update(input.body).digest("hex");
  const canonicalRequest = [input.method, input.path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const requestHash = createHash("sha256").update(canonicalRequest).digest("hex");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, requestHash].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const out: Record<string, string> = {};
  for (const name of names) if (name !== "host") out[name] = headers[name];
  out.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

async function probeCloudflare(ctx: ProbeContext, token: string, accountId: string): Promise<CredentialProbeResult> {
  const user = await request(ctx, "https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: bearer(token) });
  if (user.ok && cloudflareStatus(user) === "active") return pass("Token is active");
  // Account-owned tokens are only verifiable under their account.
  if (accountId) {
    const account = await request(
      ctx,
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
      { headers: bearer(token) },
    );
    if (account.ok) {
      const status = cloudflareStatus(account);
      return status === "active" ? pass("Account token is active") : fail(`Token is ${status ?? "not active"}`);
    }
    if (!user.ok) return httpFailure(account);
  }
  if (user.ok) return fail(`Token is ${cloudflareStatus(user) ?? "not active"}`);
  return httpFailure(user);
}

function cloudflareStatus(res: HttpResponse): string | undefined {
  return str(get(res.body, "result", "status"));
}

async function probeVercel(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.vercel.com/v2/user", { headers: bearer(key) });
  if (!res.ok) return httpFailure(res);
  return authenticatedAs(str(get(res.body, "user", "username")), str(get(res.body, "user", "email")));
}

async function probeSupabase(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.supabase.com/v1/projects", { headers: bearer(key) });
  if (!res.ok) return httpFailure(res);
  return pass(Array.isArray(res.body) ? `Access to ${plural(res.body.length, "project")}` : "Token accepted");
}

async function probePostgres(connectionString: string, timeoutMs: number): Promise<CredentialProbeResult> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
  // A dropped connection emits "error" on the client; unhandled, it would crash the process.
  client.on("error", () => {});
  try {
    await client.connect();
    const { rows } = await client.query<{ current_user: string; version: string }>("SELECT current_user, version()");
    const row = rows[0];
    const version = /^PostgreSQL [\d.]+/.exec(row?.version ?? "")?.[0];
    return pass(`Connected as ${row?.current_user ?? "unknown user"}${version ? ` (${version})` : ""}`);
  } catch (err) {
    const message = describeError(err, timeoutMs);
    return fail(/timeout/i.test(message) ? `Timed out after ${formatDuration(timeoutMs)}` : message);
  } finally {
    // end() can wait on a half-open socket; never let it hold the check hostage.
    const { promise: gaveUp, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 1000).unref();
    await Promise.race([client.end().catch(() => {}), gaveUp]);
  }
}

// ---------------------------------------------------------------------------------------------
// SMTP

type SmtpSocket = Socket; // tls.TLSSocket extends net.Socket

/** Reads CRLF-terminated SMTP lines from a paused socket without over-reading. */
class SmtpReader {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  private failed: Error | null = null;

  constructor(
    private readonly socket: SmtpSocket,
    timeoutMs: number,
  ) {
    socket.on("readable", () => this.pump());
    socket.on("error", (err) => this.abort(err));
    socket.on("close", () => this.abort(new Error("Connection closed by the server")));
    socket.setTimeout(timeoutMs, () => this.abort(new Error(`Timed out after ${formatDuration(timeoutMs)}`)));
  }

  /** Move whatever the socket has buffered into `buffer` and split off complete lines. */
  private pump(): void {
    for (;;) {
      const chunk = this.socket.read() as Buffer | null;
      if (chunk === null) break;
      this.buffer += chunk.toString("utf8");
    }
    let end: number;
    while ((end = this.buffer.indexOf("\r\n")) >= 0) {
      this.lines.push(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 2);
    }
    this.deliver();
  }

  /** Pair queued lines with waiting readers. */
  private deliver(): void {
    while (this.lines.length > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve(this.lines.shift()!);
    }
  }

  private abort(err: Error): void {
    this.failed = err;
    while (this.waiters.length > 0) this.waiters.shift()!.reject(err);
  }

  line(): Promise<string> {
    if (this.failed) return Promise.reject(this.failed);
    this.pump();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    this.waiters.push({ resolve, reject });
    this.deliver();
    return promise;
  }

  /** Detach before handing the socket to the TLS layer, so it owns the data stream. */
  detach(): void {
    this.socket.removeAllListeners("readable");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
    this.socket.setTimeout(0);
  }
}

/** One SMTP conversation over a connected socket; supports a STARTTLS upgrade mid-session. */
class SmtpConversation {
  private socket: SmtpSocket;
  private reader: SmtpReader;

  constructor(
    socket: SmtpSocket,
    private readonly host: string,
    private readonly timeoutMs: number,
  ) {
    this.socket = socket;
    this.reader = new SmtpReader(socket, timeoutMs);
  }

  write(command: string): void {
    this.socket.write(`${command}\r\n`);
  }

  /** One reply: its 3-digit code plus the text of each line (multi-line replies included). */
  private async reply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.reader.line();
      if (!/^\d{3}[- ]/.test(line)) continue;
      const code = Number(line.slice(0, 3));
      lines.push(line.slice(4));
      if (line[3] === " ") return { code, lines };
    }
  }

  async command(cmd: string | null): Promise<{ code: number; lines: string[] }> {
    if (cmd !== null) this.write(cmd);
    return this.reply();
  }

  /** The EHLO capability names, uppercased. */
  async ehlo(): Promise<Set<string>> {
    const res = await this.command(`EHLO ${USER_AGENT}`);
    if (res.code !== 250) throw new ProbeFailure(`EHLO failed: ${res.code} ${res.lines.join(" ").trim()}`.trim());
    const caps = new Set<string>();
    for (const line of res.lines) {
      const name = line.trim().toUpperCase();
      if (name) caps.add(name);
    }
    return caps;
  }

  /** Upgrade the plain connection to TLS (STARTTLS); only after the server's 220 go-ahead. */
  async startTls(): Promise<void> {
    const res = await this.command("STARTTLS");
    if (res.code !== 220) throw new ProbeFailure(`STARTTLS rejected: ${res.code} ${res.lines.join(" ").trim()}`.trim());
    this.reader.detach();
    this.socket = tlsConnect({ socket: this.socket, servername: this.host, timeout: this.timeoutMs });
    this.reader = new SmtpReader(this.socket, this.timeoutMs);
    await awaitSmtpConnect(this.socket, true);
  }

  async auth(username: string, password: string): Promise<CredentialProbeResult> {
    const accepted = () => pass(`SMTP login accepted (${username})`);
    const plain = Buffer.from(`\u0000${username}\u0000${password}`, "utf8").toString("base64");
    let res = await this.command(`AUTH PLAIN ${plain}`);
    if (res.code === 235) return accepted();
    if (res.code === 334) {
      res = await this.command(plain);
      if (res.code === 235) return accepted();
    }
    if (res.code === 535) return fail("SMTP authentication rejected: check the username and password");
    // 504/502/…: the server does not speak AUTH PLAIN — fall back to AUTH LOGIN.
    const login = await this.command("AUTH LOGIN");
    if (login.code === 334) {
      const user = await this.command(Buffer.from(username, "utf8").toString("base64"));
      if (user.code === 334) {
        const passRes = await this.command(Buffer.from(password, "utf8").toString("base64"));
        if (passRes.code === 235) return accepted();
        if (passRes.code === 535) return fail("SMTP authentication rejected: check the username and password");
        return fail(`SMTP authentication failed: ${passRes.code} ${passRes.lines.join(" ").trim()}`.trim());
      }
      return fail(`SMTP authentication failed: ${user.code} ${user.lines.join(" ").trim()}`.trim());
    }
    return fail(`SMTP authentication failed: ${login.code} ${login.lines.join(" ").trim()}`.trim());
  }
}

function smtpSocket(host: string, port: number, security: string, timeoutMs: number): SmtpSocket {
  return security === "tls"
    ? tlsConnect({ host, port, servername: host, timeout: timeoutMs })
    : netConnect({ host, port, timeout: timeoutMs });
}

/** Resolves once the socket is connected, or the TLS handshake has completed. */
function awaitSmtpConnect(socket: SmtpSocket, encrypted: boolean): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onReady = () => {
    cleanup();
    resolve();
  };
  const onError = (err: Error) => {
    cleanup();
    reject(err);
  };
  const cleanup = () => {
    socket.removeListener(encrypted ? "secureConnect" : "connect", onReady);
    socket.removeListener("error", onError);
  };
  socket.once(encrypted ? "secureConnect" : "connect", onReady);
  socket.once("error", onError);
  return promise;
}

async function probeSmtp(fields: Record<string, string>, timeoutMs: number): Promise<CredentialProbeResult> {
  const host = need(value(fields, "host"), "SMTP host");
  const portText = value(fields, "port");
  const port = portText ? Number(portText) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(`Invalid port: ${portText || "empty"}`);
  const username = need(value(fields, "username"), "username");
  const password = need(value(fields, "password"), "password");
  const security = value(fields, "security") || "starttls";

  // Overall deadline: a hung connect or a silent server must not hold the check open.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const socket = smtpSocket(host, port, security, timeoutMs);
  socket.on("error", () => {}); // never let a connect/teardown error crash the process
  controller.signal.addEventListener(
    "abort",
    () => socket.destroy(new Error(`Timed out after ${formatDuration(timeoutMs)}`)),
    { once: true },
  );

  try {
    await awaitSmtpConnect(socket, security === "tls");
    const talk = new SmtpConversation(socket, host, timeoutMs);
    const greeting = await talk.command(null);
    if (greeting.code !== 220) {
      return fail(`${greeting.code} ${greeting.lines.join(" ").trim()}`.trim() || `Unexpected greeting (${greeting.code})`);
    }
    if (security === "starttls") {
      const caps = await talk.ehlo();
      if (!caps.has("STARTTLS")) return fail("The server does not advertise STARTTLS; try the TLS or None encryption setting");
      await talk.startTls();
      await talk.ehlo();
    } else {
      await talk.ehlo();
    }
    return await talk.auth(username, password);
  } catch (err) {
    return fail(describeError(err, timeoutMs));
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Telegram

async function probeTelegram(ctx: ProbeContext, token: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, `https://api.telegram.org/bot${token}/getMe`);
  const body = res.body as { ok?: unknown } | undefined;
  if (!res.ok || body?.ok === false) {
    const description = str(get(body, "description"));
    return fail(`Telegram rejected the token${description ? ` (${description})` : ""} — check it with @BotFather (/token)`);
  }
  const username = str(get(body, "result", "username"));
  const firstName = str(get(body, "result", "first_name"));
  return authenticatedAs(username ? `@${username}` : firstName);
}

async function probeStripe(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.stripe.com/v1/balance", { headers: bearer(key) });
  if (!res.ok) return httpFailure(res);
  const livemode = get(res.body, "livemode");
  if (typeof livemode !== "boolean") return pass("API key accepted");
  return pass(`API key accepted (${livemode ? "live" : "test"} mode)`);
}

async function probeBrave(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.search.brave.com/res/v1/web/search?q=agentman&count=1", {
    headers: { "x-subscription-token": key },
  });
  if (!res.ok) return httpFailure(res, isRejection(res) || /token/i.test(errorDetail(res)));
  return pass("API key accepted");
}

async function probeTavily(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.tavily.com/usage", { headers: bearer(key) });
  if (!res.ok) return httpFailure(res);
  const plan = str(get(res.body, "account", "current_plan"));
  const used = num(get(res.body, "account", "plan_usage")) ?? num(get(res.body, "key", "usage"));
  const limit = num(get(res.body, "account", "plan_limit")) ?? num(get(res.body, "key", "limit"));
  const parts: string[] = [];
  if (plan) parts.push(`${plan} plan`);
  if (used !== undefined) parts.push(`${used}${limit !== undefined ? ` of ${limit}` : ""} credits used`);
  return pass(`API key accepted${parts.length ? ` (${parts.join(", ")})` : ""}`);
}

async function probeFirecrawl(ctx: ProbeContext, key: string): Promise<CredentialProbeResult> {
  const res = await request(ctx, "https://api.firecrawl.dev/v1/team/credit-usage", { headers: bearer(key) });
  if (!res.ok) return httpFailure(res);
  const remaining = num(get(res.body, "data", "remaining_credits"));
  return pass(remaining !== undefined ? `API key accepted (${plural(remaining, "credit")} remaining)` : "API key accepted");
}

async function probeMcpHttp(ctx: ProbeContext, fields: Record<string, string>): Promise<CredentialProbeResult> {
  const url = parseHttpUrl(need(value(fields, "url"), "server URL")).toString();
  const token = value(fields, "token");
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (token) setAuthHeader(headers, value(fields, "headerName"), token);

  // An SSE answer may keep the stream open; stop reading once the initialize reply arrived.
  const res = await request(ctx, url, { method: "POST", headers, body: MCP_INITIALIZE }, (text) =>
    Boolean(findRpcReply(sseMessages(text))),
  );
  if (res.status === 401 || res.status === 403) {
    return fail(`${res.status} Unauthorized: ${token ? "the server rejected the token" : "the server requires a token"}`);
  }
  if (!res.ok) return fail(`${res.status} ${res.statusText}`.trim());

  await closeMcpSession(ctx, url, headers, res.headers.get("mcp-session-id"));
  const reply = findRpcReply(res.body !== undefined ? [res.body] : sseMessages(res.text));
  if (!reply) return fail("No JSON-RPC result in the response; is this an MCP endpoint?");
  if (!("result" in reply)) return fail(`MCP error: ${str(get(reply.error, "message")) ?? "initialize failed"}`);
  const name = str(get(reply.result, "serverInfo", "name"));
  const version = str(get(reply.result, "serverInfo", "version"));
  return pass(name ? `Connected to ${name}${version ? ` ${version}` : ""}` : "MCP server answered");
}

/** Politely end the session the initialize call opened, so periodic checks don't pile them up. */
async function closeMcpSession(ctx: ProbeContext, url: string, headers: Headers, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  try {
    const close = new Headers(headers);
    close.delete("content-type");
    close.set("mcp-session-id", sessionId);
    const res = await ctx.fetchImpl(url, { method: "DELETE", headers: close, signal: ctx.signal });
    await res.body?.cancel();
  } catch {
    // Best effort: the server expires idle sessions on its own.
  }
}

type RpcReply = { result: unknown } | { error: unknown };

function findRpcReply(messages: unknown[]): RpcReply | undefined {
  for (const message of messages.flat()) {
    if (message === null || typeof message !== "object") continue;
    if ("result" in message) return message as { result: unknown };
    if ("error" in message) return message as { error: unknown };
  }
  return undefined;
}

/** JSON payloads of the complete `data:` events in a text/event-stream body. */
function sseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    const parsed = data ? parseJson(data) : undefined;
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

async function probeCustomApi(ctx: ProbeContext, fields: Record<string, string>): Promise<CredentialProbeResult> {
  const url = parseHttpUrl(need(value(fields, "url"), "URL")).toString();
  const token = value(fields, "token");
  const headers = new Headers();
  if (token) setAuthHeader(headers, value(fields, "headerName"), token);
  const res = await request(ctx, url, { headers });
  if (!res.ok) return httpFailure(res);
  return pass(`Reachable (${`${res.status} ${res.statusText}`.trim()})`);
}

/** `Authorization` gets the Bearer scheme; any other header carries the raw token. */
function setAuthHeader(headers: Headers, headerName: string, token: string): void {
  const name = headerName || "Authorization";
  headers.set(name, name.toLowerCase() === "authorization" ? `Bearer ${token}` : token);
}

// ---------------------------------------------------------------------------------------------
// HTTP

async function request(
  ctx: ProbeContext,
  url: string,
  init: RequestInit = {},
  until?: (text: string) => boolean,
): Promise<HttpResponse> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  const res = await ctx.fetchImpl(url, { ...init, headers, signal: ctx.signal });
  const text = await readText(res, until);
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText || STATUS_CODES[res.status] || "",
    headers: res.headers,
    text,
    body: parseJson(text),
  };
}

/** Read at most MAX_BODY_CHARS of the body, or less when `until` is satisfied early. */
async function readText(res: Response, until?: (text: string) => boolean): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      text += decoder.decode(chunk, { stream: true });
      if (text.length > MAX_BODY_CHARS || until?.(text)) break;
    }
    text += decoder.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRejection(res: HttpResponse): boolean {
  return res.status === 401 || res.status === 403;
}

/** "<status> <statusText>: <provider's own error message>"; auth failures say the key was rejected. */
function httpFailure(res: HttpResponse, rejected = isRejection(res)): CredentialProbeResult {
  const status = `${res.status} ${res.statusText}`.trim();
  const detail = errorDetail(res);
  const extra = detail && detail !== status ? detail : "";
  if (rejected) return fail(`${status}: ${extra ? `Key rejected (${extra})` : "Key rejected"}`);
  return fail(extra ? `${status}: ${extra}` : status);
}

/** The provider's error message from a JSON body (or an AWS-style XML one), if any. */
function errorDetail(res: HttpResponse): string {
  const detail = pickMessage(res.body) ?? /<Message>([^<]*)<\/Message>/.exec(res.text)?.[1]?.trim();
  return detail ? detail.replace(/\s+/g, " ") : "";
}

function pickMessage(input: unknown, depth = 0): string | undefined {
  if (depth > 4 || input === null || input === undefined) return undefined;
  if (typeof input === "string") return str(input);
  if (Array.isArray(input)) return pickMessage(input[0], depth + 1);
  if (typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["message", "error_description", "error", "errors", "detail", "msg", "title"]) {
    const found = pickMessage(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function pass(message: string): CredentialProbeResult {
  return { ok: true, message };
}

function fail(message: string): CredentialProbeResult {
  return { ok: false, message };
}

function authenticatedAs(name: string | undefined, detail?: string): CredentialProbeResult {
  if (!name) return pass("Credentials accepted");
  return pass(`Authenticated as ${name}${detail ? ` (${detail})` : ""}`);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function modelCount(data: unknown): string {
  return Array.isArray(data) && data.length ? ` (${plural(data.length, "model")} available)` : "";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** First non-empty (trimmed) value among `keys`. */
function value(fields: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const raw = fields[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return "";
}

function need(input: string, what: string): string {
  if (!input) throw new ProbeFailure(`Missing ${what}`);
  return input;
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProbeFailure(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ProbeFailure(`Not an http(s) URL: ${raw}`);
  return url;
}

function withoutTrailingSlash(url: URL): string {
  return url.toString().replace(/\/+$/, "");
}

/** Walk plain objects/arrays by key; anything missing or not an object yields undefined. */
function get(input: unknown, ...path: string[]): unknown {
  let current = input;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function str(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function num(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(1))} s` : `${ms} ms`;
}

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof ProbeFailure) return err.message;
  const e = (typeof err === "object" && err !== null ? err : {}) as { name?: unknown; message?: unknown; cause?: unknown };
  if (e.name === "TimeoutError" || e.name === "AbortError") return `Timed out after ${formatDuration(timeoutMs)}`;
  const message = typeof e.message === "string" ? e.message : String(err);
  // undici reports every connection problem as "fetch failed"; the cause says what happened.
  if (message === "fetch failed") {
    const cause = (typeof e.cause === "object" && e.cause !== null ? e.cause : {}) as { message?: unknown; code?: unknown };
    const detail = str(cause.message) ?? str(cause.code);
    return detail ? `Network error: ${detail}` : "Network error";
  }
  return message || "Check failed";
}

/** Every secret value (raw and trimmed), longest first so a value containing another is scrubbed whole. */
function secretValues(provider: CredentialProvider, fields: Record<string, string>): string[] {
  const keys = new Set(SECRET_KEYS);
  for (const field of provider.fields) if (field.kind === "secret") keys.add(field.key);
  const out = new Set<string>();
  for (const key of keys) {
    const raw = fields[key];
    if (typeof raw !== "string") continue;
    if (raw) out.add(raw);
    if (raw.trim()) out.add(raw.trim());
  }
  const password = connectionPassword(value(fields, "connectionString"));
  if (password) {
    out.add(password);
    out.add(encodeURIComponent(password));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** The password inside a postgres:// URL or a libpq `key=value` connection string. */
function connectionPassword(connectionString: string): string {
  if (!connectionString) return "";
  try {
    const password = new URL(connectionString).password;
    if (password) return decodeURIComponent(password);
  } catch {
    // Not a URL: try the key=value form below.
  }
  const match = /(?:^|\s)password\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/.exec(connectionString);
  if (!match) return "";
  const raw = match[1];
  return raw.startsWith("'") ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
}

/** Scrub secrets, collapse whitespace, cap the length. */
function clean(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("••••");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_MESSAGE_LENGTH) out = `${out.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
  return out || "Check failed";
}

/** Every secret AI provider value (raw and trimmed), longest first like `secretValues`. */
function aiSecretValues(provider: AiProviderDefinition, values: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const field of provider.fields) {
    const raw = values[field.envVar];
    if (!field.secret || typeof raw !== "string") continue;
    if (raw) out.add(raw);
    if (raw.trim()) out.add(raw.trim());
  }
  return [...out].sort((a, b) => b.length - a.length);
}
