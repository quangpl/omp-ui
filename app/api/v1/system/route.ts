import { execFile } from "node:child_process";
import { json, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

interface OmpInfo {
  path: string;
  installed: boolean;
  version: string | null;
}

const CACHE_TTL_MS = 60_000;

const g = globalThis as unknown as {
  __ompUiOmpInfo?: { path: string; at: number; info: Promise<OmpInfo> };
};

function probeOmp(ompPath: string): Promise<OmpInfo> {
  const { promise, resolve } = Promise.withResolvers<OmpInfo>();
  execFile(ompPath, ["--version"], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
    const code = err?.code;
    if (code === "ENOENT" || code === "EACCES") {
      resolve({ path: ompPath, installed: false, version: null });
      return;
    }
    const output = `${stdout}\n${stderr}`.trim();
    const version =
      /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(output)?.[0] ??
      (err ? null : output.split("\n")[0]?.trim() || null);
    resolve({ path: ompPath, installed: true, version });
  });
  return promise;
}

export const GET = withApi(async ({ repo }) => {
  const { ompPath } = await getAppSettings(repo);
  const cached = g.__ompUiOmpInfo;
  if (!cached || cached.path !== ompPath || Date.now() - cached.at > CACHE_TTL_MS) {
    g.__ompUiOmpInfo = { path: ompPath, at: Date.now(), info: probeOmp(ompPath) };
  }
  const omp = await g.__ompUiOmpInfo!.info;
  return json({ version: APP_VERSION, db: repo.driver, omp });
});
