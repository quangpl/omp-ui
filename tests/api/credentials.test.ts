import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, env, freshEnv, restartServer, setupAdmin, teardown } from "./helpers";

import * as checkAllRoute from "@/app/api/v1/credentials/check-all/route";
import * as credentialTestRoute from "@/app/api/v1/credentials/[id]/test/route";
import * as credentialRoute from "@/app/api/v1/credentials/[id]/route";
import * as notificationsRoute from "@/app/api/v1/credentials/notifications/route";
import * as credentialsRoute from "@/app/api/v1/credentials/route";
import * as testRoute from "@/app/api/v1/credentials/test/route";
import type {
  CredentialNotificationsResponse,
  CredentialsResponse,
  CredentialSummary,
  CredentialTestResult,
} from "@/lib/credential-types";
import { getRepo } from "@/lib/db";

const GOOD_TOKEN = "good-token";
const BAD_TOKEN = "bad-token-0000";

// lib/server/credentials.ts caches file keys per path on globalThis.
const g = globalThis as unknown as { __ompUiCredentialKeys?: Map<string, Buffer> };

/** Fake MCP endpoint: answers `initialize` for `Bearer good-token`, 401 otherwise. */
let server: Server;
let mcpUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${GOOD_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid token" }));
        return;
      }
      const rpc = JSON.parse(body || "{}") as { id?: number; method?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id ?? 1,
          result: { serverInfo: { name: "fake-mcp", version: "1.0" }, protocolVersion: "2025-06-18", capabilities: {} },
        }),
      );
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await teardown();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
});

async function list(): Promise<CredentialsResponse> {
  const res = await api<CredentialsResponse>(credentialsRoute, "GET", "/credentials");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function notifications(): Promise<CredentialNotificationsResponse> {
  const res = await api<CredentialNotificationsResponse>(notificationsRoute, "GET", "/credentials/notifications");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function patch(id: string, body: unknown): Promise<CredentialSummary> {
  const res = await api<CredentialSummary>(credentialRoute, "PATCH", `/credentials/${id}`, {
    body,
    params: { id },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe("/credentials", () => {
  let id = "";

  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
  });

  it("requires authentication", async () => {
    expect((await api(credentialsRoute, "GET", "/credentials", { token: null })).status).toBe(401);
    expect((await api(notificationsRoute, "GET", "/credentials/notifications", { token: null })).status).toBe(401);
    expect((await api(checkAllRoute, "POST", "/credentials/check-all", { token: null })).status).toBe(401);
  });

  it("starts empty", async () => {
    const body = await list();
    expect(body.credentials).toEqual([]);
    expect(body.keySource).toBe("file");
    expect(body.checkIntervalMs).toBeGreaterThan(0);
    expect(await notifications()).toEqual({ notifications: [], unread: 0 });
  });

  it("rejects invalid input with per-field errors", async () => {
    const missing = await api<{ error: string; fields: Record<string, string> }>(credentialsRoute, "POST", "/credentials", {
      body: { providerId: "mcp-http", name: "Fake", fields: { token: GOOD_TOKEN } },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.fields.url).toBeTruthy();
    expect(missing.body.error).toBeTruthy();

    const badUrl = await api<{ error: string; fields: Record<string, string> }>(credentialsRoute, "POST", "/credentials", {
      body: { providerId: "mcp-http", name: "", fields: { url: "not a url", token: GOOD_TOKEN } },
    });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.fields.url).toBeTruthy();
    expect(badUrl.body.fields.name).toBeTruthy();

    const unknown = await api(credentialsRoute, "POST", "/credentials", {
      body: { providerId: "nope", name: "x", fields: {} },
    });
    expect(unknown.status).toBe(400);

    const badShape = await api(credentialsRoute, "POST", "/credentials", {
      body: { providerId: "mcp-http", name: "x", fields: { url: 42 } },
    });
    expect(badShape.status).toBe(400);
    expect((await list()).credentials).toEqual([]);
  });

  it("creates with test=true: healthy, token masked and encrypted at rest", async () => {
    const res = await api<CredentialSummary>(credentialsRoute, "POST", "/credentials", {
      body: { providerId: "mcp-http", name: "Fake MCP", fields: { url: mcpUrl, token: GOOD_TOKEN }, test: true },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    id = res.body.id;
    expect(res.body).toMatchObject({
      providerId: "mcp-http",
      name: "Fake MCP",
      health: "healthy",
      autoCheck: true,
      consecutiveFailures: 0,
      failingSince: null,
      secretsSet: ["token"],
    });
    expect(res.body.lastMessage).toContain("fake-mcp");
    expect(res.body.lastOkAt).toBeTruthy();
    expect(res.body.fields.url).toBe(mcpUrl);
    expect(res.body.fields.token).not.toContain(GOOD_TOKEN);

    const listed = await list();
    expect(listed.credentials).toHaveLength(1);
    expect(listed.credentials[0]?.fields.token).toBeTruthy();
    expect(JSON.stringify(listed)).not.toContain(GOOD_TOKEN);

    const stored = await (await getRepo()).getSetting("credentials");
    expect(stored).toContain(id);
    expect(stored).not.toContain(GOOD_TOKEN);
    expect(existsSync(path.join(env().dataDir, "credentials.key"))).toBe(true);

    // Created with a test: no "untested" notification, nothing failing.
    expect((await notifications()).unread).toBe(0);
  });

  it("keeps health on a name-only edit", async () => {
    const edited = await patch(id, { name: "Renamed MCP" });
    expect(edited.name).toBe("Renamed MCP");
    expect(edited.health).toBe("healthy");
    expect(edited.secretsSet).toEqual(["token"]);
  });

  it("refuses to change the provider or clear a required field", async () => {
    const res = await api(credentialRoute, "PATCH", `/credentials/${id}`, {
      body: { providerId: "github" },
      params: { id },
    });
    expect(res.status).toBe(400);
    const clear = await api<{ fields: Record<string, string> }>(credentialRoute, "PATCH", `/credentials/${id}`, {
      body: { clear: ["url"] },
      params: { id },
    });
    expect(clear.status).toBe(400);
    expect(clear.body.fields.url).toBeTruthy();
  });

  it("resets health to untested when a value changes without a test", async () => {
    const edited = await patch(id, { fields: { headerName: "Authorization" } });
    expect(edited.health).toBe("untested");
    expect(edited.lastCheckedAt).toBeNull();
    const checked = await api<{ credential: CredentialSummary; result: CredentialTestResult }>(
      credentialTestRoute,
      "POST",
      `/credentials/${id}/test`,
      { params: { id } },
    );
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body.result.ok).toBe(true);
    expect(checked.body.credential.health).toBe("healthy");
  });

  it("a bad token tested on save turns failing and raises a notification", async () => {
    const edited = await patch(id, { fields: { token: BAD_TOKEN }, test: true });
    expect(edited.health).toBe("failing");
    expect(edited.consecutiveFailures).toBe(1);
    expect(edited.failingSince).toBeTruthy();
    expect(edited.lastMessage).toContain("401");
    expect(JSON.stringify(edited)).not.toContain(BAD_TOKEN);

    const feed = await notifications();
    expect(feed.unread).toBe(1);
    expect(feed.notifications).toHaveLength(1);
    expect(feed.notifications[0]).toMatchObject({
      credentialId: id,
      kind: "failing",
      severity: "error",
      read: false,
    });
    expect(feed.notifications[0]?.title).toContain("Renamed MCP");

    // A second failing check keeps the streak start.
    const checkAll = await api<CredentialsResponse>(checkAllRoute, "POST", "/credentials/check-all");
    expect(checkAll.status).toBe(200);
    expect(checkAll.body.credentials[0]).toMatchObject({
      health: "failing",
      consecutiveFailures: 2,
      failingSince: edited.failingSince,
    });
    expect((await notifications()).notifications[0]?.id).toBe(feed.notifications[0]?.id);
  });

  it("marks notifications read, then dismisses them", async () => {
    const [notice] = (await notifications()).notifications;
    expect(notice).toBeTruthy();

    const badAction = await api(notificationsRoute, "POST", "/credentials/notifications", {
      body: { action: "explode", ids: [notice!.id] },
    });
    expect(badAction.status).toBe(400);

    const read = await api<CredentialNotificationsResponse>(notificationsRoute, "POST", "/credentials/notifications", {
      body: { action: "read", ids: [notice!.id] },
    });
    expect(read.status).toBe(200);
    expect(read.body.unread).toBe(0);
    expect(read.body.notifications[0]?.read).toBe(true);

    const dismissed = await api<CredentialNotificationsResponse>(
      notificationsRoute,
      "POST",
      "/credentials/notifications",
      { body: { action: "dismiss", ids: [notice!.id] } },
    );
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toEqual({ notifications: [], unread: 0 });
    expect(await notifications()).toEqual({ notifications: [], unread: 0 });
  });

  it("tests unsaved values, using the stored token when the form leaves it empty", async () => {
    const withStored = await api<CredentialTestResult>(testRoute, "POST", "/credentials/test", {
      body: { providerId: "mcp-http", name: "x", fields: { url: mcpUrl, token: "" }, id },
    });
    expect(withStored.status, JSON.stringify(withStored.body)).toBe(200);
    // The stored token is still the bad one.
    expect(withStored.body.ok).toBe(false);

    const good = await api<CredentialTestResult>(testRoute, "POST", "/credentials/test", {
      body: { providerId: "mcp-http", name: "x", fields: { url: mcpUrl, token: GOOD_TOKEN } },
    });
    expect(good.status).toBe(200);
    expect(good.body.ok).toBe(true);
    expect(good.body.message).toContain("fake-mcp");

    const invalid = await api<{ fields: Record<string, string> }>(testRoute, "POST", "/credentials/test", {
      body: { providerId: "mcp-http", fields: { url: "ftp://nowhere" } },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.fields.url).toBeTruthy();

    // Testing stores nothing.
    expect((await list()).credentials[0]?.health).toBe("failing");
  });

  it("fixing the token makes it healthy and clears the failing notification", async () => {
    const fixed = await patch(id, { fields: { token: GOOD_TOKEN }, test: true });
    expect(fixed).toMatchObject({ health: "healthy", failingSince: null, consecutiveFailures: 0 });
    expect(await notifications()).toEqual({ notifications: [], unread: 0 });

    const withStored = await api<CredentialTestResult>(testRoute, "POST", "/credentials/test", {
      body: { providerId: "mcp-http", fields: { url: mcpUrl }, id },
    });
    expect(withStored.status).toBe(200);
    expect(withStored.body.ok).toBe(true);

    // Dismissed/read ids of the old failure were pruned once it ended.
    const state = JSON.parse((await (await getRepo()).getSetting("credential_notifications")) ?? "{}") as {
      read?: string[];
      dismissed?: string[];
    };
    expect(state.read ?? []).toEqual([]);
    expect(state.dismissed ?? []).toEqual([]);
  });

  it("still decrypts after a restart", async () => {
    g.__ompUiCredentialKeys?.clear();
    await restartServer();
    const body = await list();
    expect(body.credentials[0]).toMatchObject({ id, health: "healthy", secretsSet: ["token"] });
    const checked = await api<{ result: CredentialTestResult }>(credentialTestRoute, "POST", `/credentials/${id}/test`, {
      params: { id },
    });
    expect(checked.status).toBe(200);
    expect(checked.body.result.ok).toBe(true);
  });

  it("reports a changed encryption key as failing instead of erroring", async () => {
    await restartServer({ CREDENTIALS_KEY: "some-other-key" });
    const body = await list();
    expect(body.keySource).toBe("env");
    expect(body.credentials[0]).toMatchObject({ id, health: "failing", secretsSet: [] });
    expect(body.credentials[0]?.lastMessage).toContain("Cannot decrypt");
    expect((await notifications()).unread).toBe(1);
    await restartServer({ CREDENTIALS_KEY: undefined });
    expect((await list()).credentials[0]?.health).toBe("healthy");
  });

  it("deletes, then answers 404", async () => {
    const del = await api(credentialRoute, "DELETE", `/credentials/${id}`, { params: { id } });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    expect((await api(credentialRoute, "DELETE", `/credentials/${id}`, { params: { id } })).status).toBe(404);
    expect(
      (await api(credentialRoute, "PATCH", `/credentials/${id}`, { body: { name: "x" }, params: { id } })).status,
    ).toBe(404);
    expect((await api(credentialTestRoute, "POST", `/credentials/${id}/test`, { params: { id } })).status).toBe(404);
    expect((await list()).credentials).toEqual([]);
  });
});
