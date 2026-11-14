import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, FAKE_OMP, freshEnv, setupAdmin, teardown, tempDir, writeScript } from "./helpers";

import * as credentialRoute from "@/app/api/v1/credentials/[id]/route";
import * as credentialsRoute from "@/app/api/v1/credentials/route";
import * as mcpServerRoute from "@/app/api/v1/mcp/[name]/route";
import * as mcpServerTestRoute from "@/app/api/v1/mcp/[name]/test/route";
import * as mcpRoute from "@/app/api/v1/mcp/route";
import * as mcpSyncRoute from "@/app/api/v1/mcp/sync/route";
import type { CredentialsResponse } from "@/lib/credential-types";
import type { McpConnectResult, McpServerConfig, McpServersResponse, McpServerSummary } from "@/lib/mcp-types";
import { mcpAgentEnv, setMcpAgentEnv } from "@/lib/server/mcp-env";

// Every server here is a custom HTTP one (`mcp-http`) connected with `test: false`, so no MCP probe
// runs. New credentials are still health-checked on save: against a closed local port, so that check
// fails at once without leaving the machine.
const SERVER_URL = "http://127.0.0.1:9/mcp";
const TOKEN = "mcp-secret-token-0123456789";
const OTHER_TOKEN = "other-secret-token-9876543210";
const SCHEMA = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

type ErrorBody = { error?: string; fields?: Record<string, string> };

let mcpFile = "";

/** mcp.json as parsed JSON. */
function readConfig(): { mcpServers: Record<string, McpServerConfig & Record<string, unknown>> } & Record<string, unknown> {
  return JSON.parse(readFileSync(mcpFile, "utf8"));
}

async function list(): Promise<McpServersResponse> {
  const res = await api<McpServersResponse>(mcpRoute, "GET", "/mcp");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function credentialIds(): Promise<string[]> {
  const res = await api<CredentialsResponse>(credentialsRoute, "GET", "/credentials");
  expect(res.status).toBe(200);
  return res.body.credentials.map((c) => c.id);
}

function connect(body: Record<string, unknown>) {
  return api<McpConnectResult & ErrorBody>(mcpRoute, "POST", "/mcp", { body: { providerId: "mcp-http", test: false, ...body } });
}

function newCredential(name: string, token = TOKEN) {
  return { name, fields: { url: SERVER_URL, token } };
}

function patch(name: string, body: unknown) {
  return api<McpServerSummary & ErrorBody>(mcpServerRoute, "PATCH", `/mcp/${name}`, { body, params: { name } });
}

function remove(name: string, query = "") {
  return api<{ ok: boolean } & ErrorBody>(mcpServerRoute, "DELETE", `/mcp/${name}${query}`, { params: { name } });
}

afterAll(async () => {
  setMcpAgentEnv({});
  await teardown();
});

describe("/mcp", () => {
  let credentialId = "";

  beforeAll(async () => {
    await freshEnv();
    const agentDir = tempDir("omp-agent");
    mcpFile = path.join(agentDir, "mcp.json");
    // omp stand-in: `omp config path` reports the temp agent dir; anything else runs the fake omp
    // (importing fake-omp.mjs runs it on this process's argv), so the suite needs no real omp.
    process.env.OMP_PATH = writeScript(
      path.join(tempDir("bin"), "omp.mjs"),
      `if (process.argv[2] === "config" && process.argv[3] === "path") {
  process.stdout.write(${JSON.stringify(`${agentDir}\n`)});
} else {
  await import(${JSON.stringify(pathToFileURL(FAKE_OMP).href)});
}`,
    );
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: { foreign: { type: "stdio", command: "foreign-mcp", args: ["--serve"] } },
        customTopLevel: { keep: true },
      }),
    );
    await setupAdmin();
  });

  it("requires authentication", async () => {
    expect((await api(mcpRoute, "GET", "/mcp", { token: null })).status).toBe(401);
    expect((await api(mcpSyncRoute, "POST", "/mcp/sync", { token: null })).status).toBe(401);
  });

  it("lists entries it does not manage as external", async () => {
    expect(await list()).toEqual({
      servers: [],
      configPath: mcpFile,
      configError: null,
      external: [{ name: "foreign", transport: "stdio", enabled: true }],
    });
  });

  it("rejects invalid credential fields and server names without saving anything", async () => {
    const before = readFileSync(mcpFile, "utf8");
    const badFields = await connect({ name: "fakemcp", credential: { name: "Fake", fields: { url: "not a url" } } });
    expect(badFields.status).toBe(400);
    expect(badFields.body.fields?.url).toBeTruthy();

    const badName = await connect({ name: "Bad Name!", credential: newCredential("Fake") });
    expect(badName.status).toBe(400);
    expect(badName.body.error).toBeTruthy();

    expect(await credentialIds()).toEqual([]);
    expect(readFileSync(mcpFile, "utf8")).toBe(before);
  });

  it("connects a server: placeholder in mcp.json, real token in the agents' environment", async () => {
    const res = await connect({ name: "fakemcp", credential: newCredential("Fake MCP") });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const expected: McpServerConfig = {
      type: "http",
      url: SERVER_URL,
      headers: { Authorization: "Bearer ${OMPUI_MCP_FAKEMCP_TOKEN}" },
    };
    expect(res.body.server).toMatchObject({
      name: "fakemcp",
      providerId: "mcp-http",
      enabled: true,
      transport: "http",
      synced: true,
      config: expected,
    });
    credentialId = res.body.server.credentialId;
    expect(await credentialIds()).toEqual([credentialId]);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);

    const raw = readFileSync(mcpFile, "utf8");
    expect(raw).not.toContain(TOKEN);
    const config = readConfig();
    expect(config.$schema).toBe(SCHEMA);
    expect(config.customTopLevel).toEqual({ keep: true });
    expect(config.mcpServers.foreign).toEqual({ type: "stdio", command: "foreign-mcp", args: ["--serve"] });
    expect(config.mcpServers.fakemcp).toEqual(expected);

    expect((await mcpAgentEnv()).OMPUI_MCP_FAKEMCP_TOKEN).toBe(TOKEN);
    const listed = await list();
    expect(listed.servers.map((s) => s.name)).toEqual(["fakemcp"]);
    expect(listed.external.map((s) => s.name)).toEqual(["foreign"]);
  });

  it("names servers after the provider by default, deduplicated", async () => {
    const first = await connect({ credentialId });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.server.name).toBe("mcp-http");
    const second = await connect({ credentialId });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.server.name).toBe("mcp-http-2");
    expect(Object.keys(readConfig().mcpServers).sort()).toEqual(["fakemcp", "foreign", "mcp-http", "mcp-http-2"]);
    // Both reuse the saved credential.
    expect(await credentialIds()).toEqual([credentialId]);
  });

  it("refuses a name already used in mcp.json, managed or not", async () => {
    expect((await connect({ name: "fakemcp", credentialId })).status).toBe(409);
    expect((await connect({ name: "foreign", credentialId })).status).toBe(409);
    expect((await connect({ name: "foreign", credential: newCredential("Dup") })).status).toBe(409);
    expect(await credentialIds()).toEqual([credentialId]);
  });

  it("404s on unknown servers and credentials", async () => {
    expect((await connect({ name: "ghost", credentialId: "nope" })).status).toBe(404);
    expect((await patch("nope", { enabled: false })).status).toBe(404);
    expect((await remove("nope")).status).toBe(404);
    const tested = await api(mcpServerTestRoute, "POST", "/mcp/nope/test", { params: { name: "nope" } });
    expect(tested.status).toBe(404);
  });

  it("disables and re-enables a server in mcp.json", async () => {
    const disabled = await patch("fakemcp", { enabled: false });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body).toMatchObject({ enabled: false, status: "disabled" });
    expect(readConfig().mcpServers.fakemcp?.enabled).toBe(false);

    const enabled = await patch("fakemcp", { enabled: true });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body.enabled).toBe(true);
    expect(readConfig().mcpServers.fakemcp).not.toHaveProperty("enabled");
  });

  it("sync restores a managed entry removed from mcp.json by hand", async () => {
    const config = readConfig();
    delete config.mcpServers.fakemcp;
    writeFileSync(mcpFile, JSON.stringify(config));
    expect((await list()).servers.find((s) => s.name === "fakemcp")?.synced).toBe(false);

    const res = await api<McpServersResponse>(mcpSyncRoute, "POST", "/mcp/sync");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.configError).toBeNull();
    expect(res.body.servers.find((s) => s.name === "fakemcp")?.synced).toBe(true);
    expect(readConfig().mcpServers.fakemcp).toMatchObject({ type: "http", url: SERVER_URL });
    expect(readConfig().mcpServers.foreign).toBeTruthy();
  });

  it("an unparsable mcp.json fails the connect with 502 and leaves everything untouched", async () => {
    const good = readFileSync(mcpFile, "utf8");
    const broken = '{ "mcpServers": { oops';
    writeFileSync(mcpFile, broken);
    try {
      const res = await connect({ name: "broken", credential: newCredential("Broken", OTHER_TOKEN) });
      expect(res.status, JSON.stringify(res.body)).toBe(502);
      expect(readFileSync(mcpFile, "utf8")).toBe(broken);
      expect(await credentialIds()).toEqual([credentialId]);
      expect((await list()).configError).toBeTruthy();
    } finally {
      writeFileSync(mcpFile, good);
    }
  });

  it("deleting a server's credential switches it off with status error", async () => {
    const res = await connect({ name: "solo", credential: newCredential("Solo", OTHER_TOKEN) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const soloCredential = res.body.server.credentialId;
    expect((await mcpAgentEnv()).OMPUI_MCP_SOLO_TOKEN).toBe(OTHER_TOKEN);

    const deleted = await api(credentialRoute, "DELETE", `/credentials/${soloCredential}`, { params: { id: soloCredential } });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toEqual({ ok: true });

    expect(readConfig().mcpServers.solo?.enabled).toBe(false);
    expect((await list()).servers.find((s) => s.name === "solo")).toMatchObject({ status: "error", credential: null });
    expect(Object.values(await mcpAgentEnv())).not.toContain(OTHER_TOKEN);
  });

  it("removes servers, and their credential with deleteCredential=1", async () => {
    for (const name of ["mcp-http", "mcp-http-2", "solo"]) {
      const res = await remove(name);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
    expect(Object.keys(readConfig().mcpServers).sort()).toEqual(["fakemcp", "foreign"]);
    expect(await credentialIds()).toEqual([credentialId]);
    expect((await mcpAgentEnv()).OMPUI_MCP_FAKEMCP_TOKEN).toBe(TOKEN);

    const res = await remove("fakemcp", "?deleteCredential=1");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await credentialIds()).toEqual([]);

    const config = readConfig();
    expect(Object.keys(config.mcpServers)).toEqual(["foreign"]);
    expect(config.customTopLevel).toEqual({ keep: true });
    expect((await list()).servers).toEqual([]);
    const agentEnv = await mcpAgentEnv();
    expect(agentEnv).not.toHaveProperty("OMPUI_MCP_FAKEMCP_TOKEN");
    expect(Object.values(agentEnv)).not.toContain(TOKEN);
  });
});
