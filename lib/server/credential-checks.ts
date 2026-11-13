// Health checks for /credentials: one cheap, read-only, authenticated request per provider that
// never spends credits or mutates data. Server only: the AWS signer uses node:crypto, Postgres pg.
import { createHash, createHmac } from "node:crypto";
import { STATUS_CODES } from "node:http";

import pg from "pg";

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
    case "custom-api":
      return probeCustomApi(ctx, fields);
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
