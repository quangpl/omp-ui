// Environment for every child process the server starts (omp agents, git/gh/glab, omp usage/stats).
// Children inherit the host user's environment verbatim — HOME, SSH_AUTH_SOCK, GH_TOKEN, provider
// API keys, proxies, … — so omp, git, gh and glab use whatever credentials the user already has.
// AgentMan's own secrets are stripped: an agent can read its environment. Provider values saved
// in Settings → AI Providers (lib/server/ai-providers.ts) override the inherited ones.
// Remote runs (cluster mode) get only the forwardable part (remoteChildEnv): the node supplies its
// own PATH, HOME and the rest.
import os from "node:os";
import { AI_PROVIDERS } from "@/lib/ai-providers";

/** AgentMan's own secrets; never passed to child processes. */
export const SECRET_ENV_KEYS: readonly string[] = [
  "ADMIN_PASSWORD",
  "AUTH_SECRET",
  "DATABASE_URL",
  "COMPOSE_DATABASE_URL",
  "POSTGRES_PASSWORD",
  "MONGODB_DB",
  "CREDENTIALS_KEY",
];

/** Any key with this prefix is AgentMan configuration and is stripped too. */
const SECRET_ENV_PREFIX = "OMP_UI_";

/** MCP credentials the server hands its omp children (lib/server/mcp-env.ts). */
const MCP_ENV_PREFIX = "OMPUI_MCP_";

/** Node-local variables a remote run must take from the node it runs on, never from the primary. */
const NODE_LOCAL_KEYS = new Set(["PATH", "HOME"]);

const SECRET_KEYS = new Set(SECRET_ENV_KEYS);

// On globalThis so dev hot reloads share the overlay loaded at boot.
const g = globalThis as unknown as { __ompUiProviderEnv?: Record<string, string> };

/** Replace the AI provider values (env var → value) applied over the inherited environment. */
export function setProviderEnv(values: Record<string, string>): void {
  g.__ompUiProviderEnv = { ...values };
}

/** A copy of `process.env` without AgentMan's secrets, with saved provider values and `extra` applied on top. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (SECRET_KEYS.has(key) || key.startsWith(SECRET_ENV_PREFIX)) delete env[key];
  }
  Object.assign(env, g.__ompUiProviderEnv);
  // omp and git locate ~/.omp, ~/.claude, ~/.gitconfig, ~/.ssh through HOME.
  if (!env.HOME) {
    const home = userHome();
    if (home) env.HOME = home;
  }
  return Object.assign(env, extra);
}

/**
 * What a remote run (cluster mode) takes from this server: the saved provider values, every AI
 * provider env var (Settings → AI Providers definitions) and MCP credential set in the server's
 * environment, then `extra`. The node layers it over its own childEnv(); AgentMan's secrets and
 * configuration, PATH and HOME are never forwarded.
 */
export function remoteChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const provider of AI_PROVIDERS) {
    for (const { envVar } of provider.fields) {
      const value = process.env[envVar];
      if (value) env[envVar] = value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(MCP_ENV_PREFIX) && value) env[key] = value;
  }
  Object.assign(env, g.__ompUiProviderEnv, extra);
  for (const key of Object.keys(env)) {
    if (SECRET_KEYS.has(key) || key.startsWith(SECRET_ENV_PREFIX) || NODE_LOCAL_KEYS.has(key)) delete env[key];
  }
  return env;
}

function userHome(): string | undefined {
  try {
    return os.userInfo().homedir || undefined;
  } catch {
    // No passwd entry for the current uid.
    return undefined;
  }
}
