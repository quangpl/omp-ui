import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { api, createUser, freshEnv, loginAs, setupAdmin, teardown } from "./helpers";

import * as keyRoute from "@/app/api/v1/env/[key]/route";
import * as envRoute from "@/app/api/v1/env/route";
import { childEnv, remoteChildEnv } from "@/lib/child-env";
import type { EnvVarsResponse } from "@/lib/env-vars";

describe("/env", () => {
  beforeAll(async () => {
    await freshEnv();
    await setupAdmin();
  });
  afterAll(teardown);

  it("rejects invalid keys and AgentMan's own secrets", async () => {
    for (const key of ["1BAD", "has space", "AUTH_SECRET", "OMP_UI_X"]) {
      const res = await api(envRoute, "PUT", "/env", { body: { vars: { [key]: "x" } } });
      expect(res.status, key).toBe(400);
    }
  });

  it("stores values and hands them to child processes", async () => {
    const put = await api<EnvVarsResponse>(envRoute, "PUT", "/env", { body: { vars: { MY_VAR: "hello", _B2: "x" } } });
    expect(put.status).toBe(200);
    expect(put.body.vars.map((v) => v.key)).toEqual(["_B2", "MY_VAR"]);
    expect(childEnv().MY_VAR).toBe("hello");
    expect(remoteChildEnv().MY_VAR).toBe("hello");

    const del = await api<EnvVarsResponse>(keyRoute, "DELETE", "/env/MY_VAR", { params: { key: "MY_VAR" } });
    expect(del.body.vars.map((v) => v.key)).toEqual(["_B2"]);
    expect(childEnv().MY_VAR).toBeUndefined();
    expect((await api(keyRoute, "DELETE", "/env/MY_VAR", { params: { key: "MY_VAR" } })).status).toBe(404);
  });

  it("is admin only", async () => {
    await createUser({ username: "bob", password: "bob-password-1", role: "user" });
    const token = await loginAs("bob", "bob-password-1");
    expect((await api(envRoute, "GET", "/env", { token })).status).toBe(403);
    expect((await api(envRoute, "GET", "/env", { token: null })).status).toBe(401);
  });
});
