// Environment for every child process the server starts (omp agents, git/gh/glab, omp usage/stats).
// Children inherit the host user's environment verbatim — HOME, SSH_AUTH_SOCK, GH_TOKEN, provider
// API keys, proxies, … — so omp, git, gh and glab use whatever credentials the user already has.
// OMP UI's own secrets are stripped: an agent can read its environment.
import os from "node:os";

/** OMP UI's own secrets; never passed to child processes. */
export const SECRET_ENV_KEYS: readonly string[] = [
  "ADMIN_PASSWORD",
  "AUTH_SECRET",
  "DATABASE_URL",
  "COMPOSE_DATABASE_URL",
  "POSTGRES_PASSWORD",
  "MONGODB_DB",
];

/** Any key with this prefix is OMP UI configuration and is stripped too. */
const SECRET_ENV_PREFIX = "OMP_UI_";

const SECRET_KEYS = new Set(SECRET_ENV_KEYS);

/** A copy of `process.env` without OMP UI's secrets, with `extra` applied on top. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (SECRET_KEYS.has(key) || key.startsWith(SECRET_ENV_PREFIX)) delete env[key];
  }
  // omp and git locate ~/.omp, ~/.claude, ~/.gitconfig, ~/.ssh through HOME.
  if (!env.HOME) {
    const home = userHome();
    if (home) env.HOME = home;
  }
  return Object.assign(env, extra);
}

function userHome(): string | undefined {
  try {
    return os.userInfo().homedir || undefined;
  } catch {
    // No passwd entry for the current uid.
    return undefined;
  }
}
