// Opens the cluster port in the host firewall when cluster mode starts (docs/CLUSTER.md), so a
// direct deployment needs no manual step: ufw or firewalld, whichever is active, through root —
// directly when the server runs as root, else `sudo -n` (never prompts). Without root privileges,
// or when a command fails, the result carries the exact command an admin can run instead.
import { execFile } from "node:child_process";

/** Outcome of one attempt to open the cluster port. */
export interface FirewallResult {
  /** Firewall that is active on this host; null when none (or not Linux). */
  tool: "ufw" | "firewalld" | null;
  /** True when a rule was added. */
  changed: boolean;
  /** False when the port may still be blocked: `message` names the command to run. */
  ok: boolean;
  message: string;
}

/** Runs one command; `code` 127 when it is not installed. Injectable for tests. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const COMMAND_TIMEOUT_MS = 10_000;
const UFW_COMMENT = "omp-ui cluster";
/** Readable without root: whether ufw is enabled (`ufw status` itself needs root). */
const UFW_CONF = "/etc/ufw/ufw.conf";

const runCommand: CommandRunner = (cmd, args) => {
  const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  execFile(
    cmd,
    args,
    // Untranslated output: "Status: active", "running", "yes" are matched literally.
    { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, env: { ...process.env, LC_ALL: "C" } },
    (err, stdout, stderr) => {
      if (!err) resolve({ code: 0, stdout, stderr });
      else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ code: 127, stdout: "", stderr: `${cmd}: command not found` });
      } else resolve({ code: typeof err.code === "number" ? err.code : 1, stdout, stderr: stderr || err.message });
    },
  );
  return promise;
};

/** The command is not installed (directly: ENOENT; through sudo: "command not found"). */
function notInstalled(res: { code: number; stderr: string }): boolean {
  return res.code === 127 || /command not found/i.test(res.stderr);
}

function failure(res: { stdout: string; stderr: string }): string {
  return (res.stderr.trim() || res.stdout.trim()).split("\n")[0] || "no output";
}

/** A ufw status line that already allows `port`/tcp (or the port for every protocol). */
function ufwAllows(status: string, port: number): boolean {
  const rule = new RegExp(`^${port}(/tcp)?(\\s|$)`);
  return status.split("\n").some((line) => rule.test(line.trim()) && /\bALLOW\b/.test(line));
}

function ufwCommand(port: number): string {
  return `sudo ufw allow ${port}/tcp comment '${UFW_COMMENT}'`;
}

function firewalldCommand(port: number): string {
  return `sudo firewall-cmd --add-port=${port}/tcp && sudo firewall-cmd --permanent --add-port=${port}/tcp`;
}

/** ufw with root (directly or via sudo): null when ufw is not installed or not active. */
async function openInUfw(port: number, run: CommandRunner): Promise<FirewallResult | null> {
  const status = await run("ufw", ["status"]);
  if (notInstalled(status)) return null;
  if (status.code !== 0) {
    return {
      tool: "ufw",
      changed: false,
      ok: false,
      message: `Could not check ufw for TCP ${port} (${failure(status)}); if it is active, run: ${ufwCommand(port)}`,
    };
  }
  if (!/^Status:\s*active\b/m.test(status.stdout)) return null;
  if (ufwAllows(status.stdout, port)) {
    return { tool: "ufw", changed: false, ok: true, message: `TCP ${port} is already allowed in ufw` };
  }
  const allow = await run("ufw", ["allow", `${port}/tcp`, "comment", UFW_COMMENT]);
  if (allow.code !== 0) {
    return {
      tool: "ufw",
      changed: false,
      ok: false,
      message: `Could not open TCP ${port} in ufw (${failure(allow)}); run: ${ufwCommand(port)}`,
    };
  }
  return { tool: "ufw", changed: true, ok: true, message: `Opened TCP ${port} in ufw for the cluster` };
}

/** firewalld (runtime + permanent): null when it is not installed or not running. */
async function openInFirewalld(port: number, run: CommandRunner): Promise<FirewallResult | null> {
  const state = await run("firewall-cmd", ["--state"]);
  if (notInstalled(state) || state.stdout.trim() !== "running") return null;
  const query = await run("firewall-cmd", [`--query-port=${port}/tcp`]);
  if (query.code === 0 && query.stdout.trim() === "yes") {
    return { tool: "firewalld", changed: false, ok: true, message: `TCP ${port} is already open in firewalld` };
  }
  for (const args of [[`--add-port=${port}/tcp`], ["--permanent", `--add-port=${port}/tcp`]]) {
    const res = await run("firewall-cmd", args);
    if (res.code !== 0) {
      return {
        tool: "firewalld",
        changed: false,
        ok: false,
        message: `Could not open TCP ${port} in firewalld (${failure(res)}); run: ${firewalldCommand(port)}`,
      };
    }
  }
  return { tool: "firewalld", changed: true, ok: true, message: `Opened TCP ${port} in firewalld for the cluster` };
}

/**
 * Without root: name the command for the firewall that is active. ufw is read from its config
 * (its status needs root); firewalld answers state and port queries to any user.
 */
async function withoutRoot(port: number, run: CommandRunner): Promise<FirewallResult> {
  const reason = "the server does not run as root and passwordless sudo is not available";
  const ufw = await run("grep", ["-Eqs", "^[[:space:]]*ENABLED[[:space:]]*=[[:space:]]*yes", UFW_CONF]);
  if (ufw.code === 0) {
    return {
      tool: "ufw",
      changed: false,
      ok: false,
      message: `ufw is active but ${reason}; to accept cluster connections run: ${ufwCommand(port)}`,
    };
  }
  const state = await run("firewall-cmd", ["--state"]);
  if (!notInstalled(state) && state.stdout.trim() === "running") {
    const query = await run("firewall-cmd", [`--query-port=${port}/tcp`]);
    if (query.code === 0 && query.stdout.trim() === "yes") {
      return { tool: "firewalld", changed: false, ok: true, message: `TCP ${port} is already open in firewalld` };
    }
    return {
      tool: "firewalld",
      changed: false,
      ok: false,
      message: `firewalld is running but ${reason}; to accept cluster connections run: ${firewalldCommand(port)}`,
    };
  }
  return { tool: null, changed: false, ok: true, message: "No active host firewall (ufw or firewalld)" };
}

/**
 * Allow TCP `port` in the active host firewall (Linux only; other platforms: nothing to do).
 * Root directly when process.getuid() === 0, else `sudo -n` (never prompts). ufw active → allow
 * `${port}/tcp` (comment "omp-ui cluster") unless already allowed; firewalld running → add the
 * port (runtime + permanent) unless already open; neither active → nothing. Missing privileges or a
 * failing command → ok:false with the exact command the admin can run. Never rejects.
 */
export async function openFirewallPort(port: number, run: CommandRunner = runCommand): Promise<FirewallResult> {
  if (process.platform !== "linux") {
    return { tool: null, changed: false, ok: true, message: "No host firewall to configure on this platform" };
  }
  try {
    let privileged: CommandRunner;
    if (process.getuid?.() === 0) {
      privileged = run;
    } else if ((await run("sudo", ["-n", "true"])).code === 0) {
      privileged = (cmd, args) => run("sudo", ["-n", cmd, ...args]);
    } else {
      return await withoutRoot(port, run);
    }
    return (
      (await openInUfw(port, privileged)) ??
      (await openInFirewalld(port, privileged)) ?? {
        tool: null,
        changed: false,
        ok: true,
        message: "No active host firewall (ufw or firewalld)",
      }
    );
  } catch (err) {
    return {
      tool: null,
      changed: false,
      ok: false,
      message: `Could not configure the host firewall for TCP ${port}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
