import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { api, freshEnv, readOmpLog, setupAdmin, teardown, waitFor } from "./helpers";

import * as aiProvidersRoute from "@/app/api/v1/settings/ai-providers/route";
import * as oauthRoute from "@/app/api/v1/settings/ai-providers/oauth/route";
import * as oauthSessionRoute from "@/app/api/v1/settings/ai-providers/oauth/[id]/route";
import type { AiOAuthSession, AiProvidersResponse } from "@/lib/ai-providers";

// Drives `omp login` through the fake omp (tests/fixtures/fake-omp.mjs), which speaks omp's login
// dialog: the page to open, then a readline question for the pasted code.

afterAll(teardown);

beforeEach(async () => {
  await freshEnv();
  await setupAdmin();
});

async function start(loginId: string): Promise<AiOAuthSession> {
  const res = await api<AiOAuthSession>(oauthRoute, "POST", "/settings/ai-providers/oauth", { body: { loginId } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function poll(id: string): Promise<AiOAuthSession> {
  const res = await api<AiOAuthSession>(oauthSessionRoute, "GET", `/settings/ai-providers/oauth/${id}`, {
    params: { id },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function answer(id: string, input: string) {
  return api<AiOAuthSession & { error?: string }>(oauthSessionRoute, "POST", `/settings/ai-providers/oauth/${id}`, {
    params: { id },
    body: { input },
  });
}

function cancel(id: string) {
  return api<AiOAuthSession>(oauthSessionRoute, "DELETE", `/settings/ai-providers/oauth/${id}`, { params: { id } });
}

/** Poll until `check` holds for the session. */
function until(id: string, check: (session: AiOAuthSession) => boolean): Promise<AiOAuthSession> {
  return waitFor(async () => {
    const session = await poll(id);
    return check(session) ? session : null;
  });
}

describe("POST /settings/ai-providers/oauth", () => {
  it("relays the browser sign-in and signs in with the pasted redirect URL", async () => {
    const started = await start("anthropic");
    expect(started).toMatchObject({ loginId: "anthropic", label: "Claude Pro/Max", status: "running" });

    const waiting = await until(started.id, (s) => s.prompt !== null);
    expect(waiting.url).toBe("https://auth.example.test/authorize?login=anthropic&state=fake");
    expect(waiting.prompt).toBe("Paste the authorization code (or full redirect URL):");
    expect(waiting.userCode).toBeNull();
    // The server-local shortcut is useless to a remote browser; the URL is not repeated as text.
    expect(waiting.output.join("\n")).not.toContain("localhost:54545");
    expect(waiting.output.join("\n")).not.toContain("https://auth.example.test");
    expect(waiting.output).toContain("Waiting for browser authentication...");

    const redirect = "http://localhost:54545/callback?code=good-code&state=fake";
    const answered = await answer(started.id, redirect);
    expect(answered.status).toBe(200);
    expect(answered.body.prompt).toBeNull();

    const done = await until(started.id, (s) => s.status !== "running");
    expect(done.status).toBe("succeeded");
    expect(done.account).toBe("fake@example.com");
    expect(done.error).toBeNull();
    expect(done.finishedAt).not.toBeNull();
    // The pasted code and omp's credential file path never reach the browser.
    const text = JSON.stringify(done);
    expect(text).not.toContain("good-code");
    expect(text).not.toContain("agent.db");

    expect(readOmpLog().filter((e) => e.kind === "login").map((e) => e.argv)).toEqual([["login", "anthropic"]]);
  });

  it("reports omp's error when the pasted code is rejected", async () => {
    const { id } = await start("openai-codex");
    await until(id, (s) => s.prompt !== null);
    expect((await answer(id, "wrong-code")).status).toBe(200);

    const done = await until(id, (s) => s.status !== "running");
    expect(done.status).toBe("failed");
    expect(done.error).toBe("Invalid authorization code");
    expect(done.account).toBeNull();
  });

  it("answers a question before a device-code sign-in, blank included", async () => {
    const { id } = await start("github-copilot");
    const asked = await until(id, (s) => s.prompt !== null);
    expect(asked.prompt).toBe("GitHub Enterprise URL/domain (blank for github.com) (company.ghe.com):");
    expect(asked.url).toBeNull();

    expect((await answer(id, "")).status).toBe(200);
    const device = await until(id, (s) => s.userCode !== null || s.status !== "running");
    expect(device.url).toBe("https://github.com/login/device");
    expect(device.userCode).toBe("FAKE-1234");

    const done = await until(id, (s) => s.status !== "running");
    expect(done.status).toBe("succeeded");
    expect(done.account).toBe("fake@example.com");
  });

  it("cancels a running sign-in and refuses answers afterwards", async () => {
    const { id } = await start("google-gemini-cli");
    await until(id, (s) => s.prompt !== null);

    const cancelled = await cancel(id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", error: null, prompt: null });
    expect((await poll(id)).status).toBe("cancelled");

    const late = await answer(id, "good-code");
    expect(late.status).toBe(409);
  });

  it("cancels the previous run of the same sign-in when it starts again", async () => {
    const first = await start("openrouter");
    await until(first.id, (s) => s.prompt !== null);
    const second = await start("openrouter");

    expect((await poll(first.id)).status).toBe("cancelled");
    expect((await poll(second.id)).status).toBe("running");
    await cancel(second.id);
  });

  it("only runs sign-ins the catalog offers", async () => {
    for (const loginId of ["--help", "nonexistent", "", 42]) {
      const res = await api(oauthRoute, "POST", "/settings/ai-providers/oauth", { body: { loginId } });
      expect(res.status, String(loginId)).toBe(400);
    }
    expect(readOmpLog().some((e) => e.kind === "login")).toBe(false);
  });

  it("refuses an answer while omp is not asking, and unknown sessions", async () => {
    const { id } = await start("github-copilot");
    await until(id, (s) => s.prompt !== null);
    await answer(id, "");
    await until(id, (s) => s.userCode !== null);
    expect((await answer(id, "anything")).status).toBe(409);
    await until(id, (s) => s.status !== "running");

    const missing = "00000000-0000-4000-8000-000000000000";
    const res = await api(oauthSessionRoute, "GET", `/settings/ai-providers/oauth/${missing}`, { params: { id: missing } });
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await api(oauthRoute, "POST", "/settings/ai-providers/oauth", {
      body: { loginId: "anthropic" },
      token: null,
    });
    expect(res.status).toBe(401);
  });
});

describe("OAuth sign-ins in GET /settings/ai-providers", () => {
  it("counts a subscription sign-in for its catalog provider, others under other", async () => {
    process.env.FAKE_OMP_USAGE = JSON.stringify([
      { provider: "openai-codex", metadata: { email: "codex@example.com" }, limits: [] },
      { provider: "github-copilot", metadata: { email: "octo@example.com" }, limits: [] },
    ]);
    try {
      const res = await api<AiProvidersResponse>(aiProvidersRoute, "GET", "/settings/ai-providers?refresh=1");
      expect(res.status).toBe(200);
      const openai = res.body.providers.find((p) => p.id === "openai");
      expect(openai?.ompSignIn).toEqual({ account: "codex@example.com" });
      expect(res.body.other.map((p) => p.id)).toEqual(["github-copilot"]);
      expect(res.body.other[0].ompSignIn).toEqual({ account: "octo@example.com" });
    } finally {
      delete process.env.FAKE_OMP_USAGE;
    }
  });
});
