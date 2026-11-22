import net from "node:net";

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { CredentialField, CredentialProvider, CredentialProviderId } from "@/lib/credential-types";
import { probeCredential } from "@/lib/server/credential-checks";

/** Minimal templates: probes only look at `id` and which fields are secret. */
function provider(id: CredentialProviderId, secretKeys: string[], otherKeys: string[] = []): CredentialProvider {
  const fields: CredentialField[] = [
    ...secretKeys.map((key): CredentialField => ({ key, label: key, kind: "secret", required: true })),
    ...otherKeys.map((key): CredentialField => ({ key, label: key, kind: "text", required: false })),
  ];
  return {
    id,
    name: id,
    category: "custom",
    description: "",
    monogram: "XX",
    brandColor: "#000000",
    docsUrl: "https://example.com",
    fields,
    healthCheck: "",
  };
}

const github = provider("github", ["token"], ["host"]);
const slack = provider("slack", ["token"]);
const aws = provider("aws", ["accessKeyId", "secretAccessKey", "sessionToken"], ["region"]);
const mcpHttp = provider("mcp-http", ["token"], ["url", "headerName"]);
const smtp = provider("smtp", ["password"], ["host", "port", "username", "security"]);
const telegram = provider("telegram", ["token"]);

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("probeCredential: github", () => {
  it("authenticates against {host}/user with a Bearer token", async () => {
    const fetchImpl = mockFetch(respond({ login: "octocat" }));
    const result = await probeCredential(github, { token: ` ${GITHUB_TOKEN} ` }, { fetchImpl });

    expect(result).toEqual({ ok: true, message: "Authenticated as octocat" });
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://api.github.com/user");
    expect(request.headers.get("authorization")).toBe(`Bearer ${GITHUB_TOKEN}`);
  });

  it("uses the /api/v3 root of a GitHub Enterprise host", async () => {
    const fetchImpl = mockFetch(respond({ login: "mona" }));
    await probeCredential(github, { token: GITHUB_TOKEN, host: "https://github.acme.test/" }, { fetchImpl });
    expect(sent(fetchImpl).url).toBe("https://github.acme.test/api/v3/user");
  });

  it("reports a 401 as a rejected key without leaking the token", async () => {
    const fetchImpl = mockFetch(
      respond({ message: `Bad credentials for ${GITHUB_TOKEN}` }, { status: 401, statusText: "Unauthorized" }),
    );
    const result = await probeCredential(github, { token: GITHUB_TOKEN }, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^401 Unauthorized: Key rejected/);
    expect(result.message).not.toContain(GITHUB_TOKEN);
  });

  it("turns network errors into a failure instead of throwing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") }),
    );
    const result = await probeCredential(github, { token: GITHUB_TOKEN }, { fetchImpl });
    expect(result).toEqual({ ok: false, message: "Network error: getaddrinfo ENOTFOUND api.github.com" });
  });

  it("turns a fetch that throws synchronously into a failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => {
      throw new Error("boom");
    });
    await expect(probeCredential(github, { token: GITHUB_TOKEN }, { fetchImpl })).resolves.toEqual({
      ok: false,
      message: "boom",
    });
  });

  it("times out a request that never answers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const result = await probeCredential(github, { token: GITHUB_TOKEN }, { fetchImpl, timeoutMs: 20 });
    expect(result).toEqual({ ok: false, message: "Timed out after 20 ms" });
  });

  it("fails without calling out when the token is missing", async () => {
    const fetchImpl = mockFetch();
    const result = await probeCredential(github, { token: "  " }, { fetchImpl });
    expect(result).toEqual({ ok: false, message: "Missing token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("probeCredential: slack", () => {
  it("treats a 200 with ok:false as a failure", async () => {
    const fetchImpl = mockFetch(respond({ ok: false, error: "invalid_auth" }));
    const result = await probeCredential(slack, { token: "xoxb-1234-5678-abcdefghijkl" }, { fetchImpl });

    expect(result).toEqual({ ok: false, message: "Token rejected (invalid_auth)" });
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://slack.com/api/auth.test");
    expect(request.method).toBe("POST");
  });

  it("names the user and team on success", async () => {
    const fetchImpl = mockFetch(respond({ ok: true, user: "bot", team: "Acme" }));
    const result = await probeCredential(slack, { token: "xoxb-1234-5678-abcdefghijkl" }, { fetchImpl });
    expect(result).toEqual({ ok: true, message: "Authenticated as bot in Acme" });
  });
});

describe("probeCredential: aws", () => {
  it("signs an STS GetCallerIdentity call with SigV4 and reports the ARN", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T08:09:10.123Z"));
    const fetchImpl = mockFetch(
      respond(
        `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>arn:aws:iam::123456789012:user/alice</Arn>
    <UserId>AIDAEXAMPLE</UserId>
    <Account>123456789012</Account>
  </GetCallerIdentityResult>
</GetCallerIdentityResponse>`,
        { headers: { "content-type": "text/xml" } },
      ),
    );
    const result = await probeCredential(
      aws,
      {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        sessionToken: "FwoGZXIvYXdzEXAMPLETOKEN",
        region: "eu-west-1",
      },
      { fetchImpl },
    );

    expect(result).toEqual({ ok: true, message: "Authenticated as arn:aws:iam::123456789012:user/alice" });
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://sts.eu-west-1.amazonaws.com/");
    expect(request.method).toBe("POST");
    expect(request.body).toBe("Action=GetCallerIdentity&Version=2011-06-15");
    expect(request.headers.get("x-amz-date")).toBe("20261113T080910Z");
    expect(request.headers.get("x-amz-security-token")).toBe("FwoGZXIvYXdzEXAMPLETOKEN");
    expect(request.headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261113/eu-west-1/sts/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, " +
        "Signature=9cb16d3d615c56a655ae6bbeec7b615fca7d34ca8abab05fe08b953382c6e76c",
    );
  });

  it("surfaces the STS error message without the secret", async () => {
    const secretAccessKey = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    const fetchImpl = mockFetch(
      respond(
        "<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>The security token included in the request is invalid.</Message></Error></ErrorResponse>",
        { status: 403, statusText: "Forbidden" },
      ),
    );
    const result = await probeCredential(aws, { accessKeyId: "AKIDEXAMPLE", secretAccessKey }, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      message: "403 Forbidden: Key rejected (The security token included in the request is invalid.)",
    });
    expect(sent(fetchImpl).url).toBe("https://sts.us-east-1.amazonaws.com/");
  });
});

describe("probeCredential: mcp-http", () => {
  const initializeResult = {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "demo-server", version: "1.2.0" } },
  };

  it("sends initialize and reports the server from a JSON answer", async () => {
    const fetchImpl = mockFetch(respond(initializeResult, { headers: { "content-type": "application/json" } }));
    const result = await probeCredential(
      mcpHttp,
      { url: "https://mcp.example.com/mcp", token: "secret-token-123" },
      { fetchImpl },
    );

    expect(result).toEqual({ ok: true, message: "Connected to demo-server 1.2.0" });
    const request = sent(fetchImpl);
    expect(request.url).toBe("https://mcp.example.com/mcp");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(request.headers.get("authorization")).toBe("Bearer secret-token-123");
    expect(JSON.parse(String(request.body))).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
  });

  it("sends the raw token in a custom header", async () => {
    const fetchImpl = mockFetch(respond(initializeResult));
    await probeCredential(
      mcpHttp,
      { url: "https://mcp.example.com/mcp", token: "secret-token-123", headerName: "X-Api-Key" },
      { fetchImpl },
    );
    const request = sent(fetchImpl);
    expect(request.headers.get("x-api-key")).toBe("secret-token-123");
    expect(request.headers.has("authorization")).toBe(false);
  });

  it("reads the initialize result from an SSE answer", async () => {
    const fetchImpl = mockFetch(
      respond(`event: message\ndata: ${JSON.stringify(initializeResult)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const result = await probeCredential(mcpHttp, { url: "https://mcp.example.com/mcp" }, { fetchImpl });
    expect(result).toEqual({ ok: true, message: "Connected to demo-server 1.2.0" });
  });

  it("reports a 401 as unauthorized without leaking the token", async () => {
    const fetchImpl = mockFetch(respond({ error: "invalid_token" }, { status: 401, statusText: "Unauthorized" }));
    const result = await probeCredential(
      mcpHttp,
      { url: "https://mcp.example.com/mcp", token: "secret-token-123" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^401 Unauthorized/);
    expect(result.message).not.toContain("secret-token-123");
  });

  it("fails when the endpoint answers without a JSON-RPC result", async () => {
    const fetchImpl = mockFetch(respond("<html>hello</html>", { headers: { "content-type": "text/html" } }));
    const result = await probeCredential(mcpHttp, { url: "https://mcp.example.com/mcp" }, { fetchImpl });
    expect(result.ok).toBe(false);
  });
});

describe("probeCredential: telegram", () => {
  const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

  it("authenticates with getMe and names the bot", async () => {
    const fetchImpl = mockFetch(respond({ ok: true, result: { id: 1, is_bot: true, first_name: "OMP-UI", username: "omp_ui_bot" } }));
    const result = await probeCredential(telegram, { token: TOKEN }, { fetchImpl });

    expect(result).toEqual({ ok: true, message: "Authenticated as @omp_ui_bot" });
    expect(sent(fetchImpl).url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it("turns a rejected token into a failure without leaking it", async () => {
    const fetchImpl = mockFetch(respond({ ok: false, description: "Unauthorized" }, { status: 401, statusText: "Unauthorized" }));
    const result = await probeCredential(telegram, { token: TOKEN }, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Telegram rejected the token/);
    expect(result.message).not.toContain(TOKEN);
  });
});

describe("probeCredential: smtp", () => {
  const PASSWORD = "hunter2-secret-password";

  let server: net.Server;
  let port: number;

  beforeEach(async () => {
    server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.write("220 test.local ESMTP ready\r\n");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const space = line.indexOf(" ");
          const command = (space >= 0 ? line.slice(0, space) : line).toUpperCase();
          const argument = space >= 0 ? line.slice(space + 1) : "";
          if (command === "EHLO") {
            socket.write("250-test.local\r\n250-AUTH PLAIN LOGIN\r\n250 STARTTLS\r\n");
          } else if (command === "AUTH" && argument.startsWith("PLAIN ")) {
            const password = Buffer.from(argument.slice(6), "base64").toString("utf8").split("\u0000")[2];
            socket.write(
              password === PASSWORD
                ? "235 2.7.0 Authentication successful\r\n"
                : "535 5.7.8 Authentication credentials invalid\r\n",
            );
          } else if (command === "QUIT") {
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
          } else {
            socket.write("500 5.5.1 Command unrecognized\r\n");
          }
        }
      });
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", resolve);
    await promise;
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  });

  it("authenticates with AUTH PLAIN", async () => {
    const result = await probeCredential(
      smtp,
      { host: "127.0.0.1", port: String(port), username: "alice@example.com", password: PASSWORD, security: "none" },
      { timeoutMs: 2000 },
    );

    expect(result).toEqual({ ok: true, message: "SMTP login accepted (alice@example.com)" });
  });

  it("rejects bad credentials without leaking the password", async () => {
    const result = await probeCredential(
      smtp,
      { host: "127.0.0.1", port: String(port), username: "alice@example.com", password: "wrong-password", security: "none" },
      { timeoutMs: 2000 },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/authentication rejected/);
    expect(result.message).not.toContain("wrong-password");
  });
});
