// "Restart server" button: update (npm install or git pull), then stop this server, rebuild it and start it
// again. The work is done by the omp-ui CLI in a detached process, so it outlives this server
// (under systemd by the user manager, since anything we spawn dies with the service's cgroup).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/files";
import { HttpError } from "@/lib/server/http";
import type { RestartStatus } from "@/lib/types";

type RestartMode = NonNullable<RestartStatus["mode"]>;

/** Printed by the CLI (`buildOrKeepPrevious` in bin/omp-ui.mjs) when it falls back to the old build. */
const BUILD_FAILED_MARK = "Build failed — starting the previous build";
const LOG_TAIL_LINES = 60;

const g = globalThis as unknown as { __ompUiRestarting?: boolean };

function cliPath(): string {
  return path.join(process.cwd(), "bin", "omp-ui.mjs");
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Who manages this process (from the CLI's pid file, `<pid>\n[pm2|systemd|fg]`), or why the button cannot restart it. */
function detectMode(): { mode: RestartMode | null; reason: string | null } {
  if (process.env.NODE_ENV === "development") {
    return { mode: null, reason: "Dev mode hot-reloads. To restart, rerun `omp-ui dev` in its terminal." };
  }
  if (!fs.existsSync(cliPath())) {
    return { mode: null, reason: "The omp-ui CLI (bin/omp-ui.mjs) is missing next to this server." };
  }
  const [pid, owner = ""] = (readText(path.join(dataDir(), "omp-ui.pid")) ?? "").split("\n");
  // The CLI records the pid of bin/supervisor.mjs, which runs this server.
  if (Number.parseInt(pid ?? "", 10) !== process.ppid) {
    return {
      mode: null,
      reason:
        "This server was not started by the omp-ui CLI (e.g. Docker). Restart it where it runs, e.g. `omp-ui docker up --build`.",
    };
  }
  const by = owner.trim();
  if (by === "fg") {
    return { mode: null, reason: "Runs attached to a terminal (`omp-ui start -f`). Restart it there." };
  }
  return { mode: by === "pm2" || by === "systemd" ? by : "cli", reason: null };
}

export function restartStatus(): Omit<RestartStatus, "running"> {
  const { mode, reason } = detectMode();
  const text = readText(path.join(dataDir(), "restart.log"));
  // vite colors its output even into a file.
  const plain = text?.replace(/\x1b\[[0-9;]*m/g, "") ?? null;
  const log = plain === null ? null : plain.trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n");
  return {
    available: mode !== null,
    mode,
    reason,
    log,
    buildFailed: plain?.includes(BUILD_FAILED_MARK) ?? false,
    restarting: g.__ompUiRestarting ?? false,
  };
}

/**
 * Hand the restart to a detached `omp-ui restart --rebuild` (or `pm2 restart --rebuild`). It stops
 * this server (running agents are interrupted; boot recovery resumes them), builds and starts the new one;
 * its output goes to DATA_DIR/restart.log. Under systemd it queues `systemctl --user restart` instead:
 * the service's `omp-ui up --foreground` rebuilds on start when the sources changed (output in the journal).
 */
export function startRestart(): RestartMode {
  const { mode, reason } = detectMode();
  if (!mode) throw new HttpError(409, reason ?? "This server cannot restart itself.");
  if (g.__ompUiRestarting) throw new HttpError(409, "A restart is already in progress.");

  const file = path.join(dataDir(), "restart.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, `=== restart requested ${new Date().toISOString()} · ${mode} ===\n`);
  // The CLI reads .env itself. Without pm_id / OMP_UI_SERVICE_MANAGER it does not mistake itself for
  // the manager's own process.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NODE_ENV;
  delete env.pm_id;
  delete env.OMP_UI_SERVICE_MANAGER;
  const [cmd, args]: [string, string[]] =
    mode === "systemd"
      ? ["systemctl", ["--user", "restart", "--no-block", "omp-ui.service"]]
      : [process.execPath, [cliPath(), ...(mode === "pm2" ? ["pm2", "restart", "--rebuild"] : ["restart", "--rebuild"])]];
  const failed = (what: string, code: number | null) => {
    // Still alive: it failed before stopping this server (see restart.log).
    g.__ompUiRestarting = false;
    console.error(`[restart] ${what} exited (code ${code}) without restarting this server`);
  };
  const spawnDetached = (c: string, a: string[], onExit: (code: number | null) => void) => {
    const child = spawn(c, a, {
      cwd: process.cwd(),
      // Cast: the project types a required NODE_ENV, which the CLI must not inherit.
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.once("error", (err) => {
      g.__ompUiRestarting = false;
      console.error(`[restart] could not run ${c}:`, err);
    });
    child.once("exit", onExit);
    child.unref();
  };
  g.__ompUiRestarting = true;
  try {
    // Fetch the new version first (`omp-ui update --no-restart`: npm install, or git pull + deps).
    // This server keeps running meanwhile, so a failed update just reports the error in restart.log.
    spawnDetached(process.execPath, [cliPath(), "update", "--no-restart"], (updateCode) => {
      if (updateCode !== 0) {
        fs.closeSync(fd);
        return failed("the update", updateCode);
      }
      try {
        spawnDetached(cmd, args, (code) => {
          fs.closeSync(fd);
          // `--no-block` returns once the job is queued; the user manager then stops this server.
          if (mode === "systemd" && code === 0) return;
          failed(mode === "systemd" ? "systemctl" : "the omp-ui CLI", code);
        });
      } catch (err) {
        fs.closeSync(fd);
        g.__ompUiRestarting = false;
        console.error("[restart] could not start the restart:", err);
      }
    });
  } catch (err) {
    fs.closeSync(fd);
    g.__ompUiRestarting = false;
    throw err;
  }
  console.log(`[restart] update → stop → rebuild → start requested (${mode}); output: ${file}`);
  return mode;
}
