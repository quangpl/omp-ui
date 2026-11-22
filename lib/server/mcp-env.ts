// Decrypted MCP secrets for the omp processes OMP-UI starts. lib/server/mcp.ts fills the cache at
// boot and after every MCP or credential change; spawn sites merge `await mcpAgentEnv()` into their
// child environment so the `${OMPUI_MCP_…}` placeholders in omp's mcp.json resolve. No imports:
// agent modules use this without pulling in the database or the credential store.

// On globalThis so dev hot reloads share one cache.
const g = globalThis as unknown as {
  __ompUiMcpEnv?: Record<string, string>;
  __ompUiMcpReady?: Promise<unknown>;
};

/** Replace the cached `OMPUI_MCP_*` variables. */
export function setMcpAgentEnv(env: Record<string, string>): void {
  g.__ompUiMcpEnv = { ...env };
}

/** The boot-time load; `mcpAgentEnv` waits for it so the first run after a restart gets the secrets. */
export function setMcpEnvReady(ready: Promise<unknown>): void {
  g.__ompUiMcpReady = ready;
}

/** `OMPUI_MCP_*` variables for an omp child process. Never rejects; empty before the first load. */
export async function mcpAgentEnv(): Promise<Record<string, string>> {
  try {
    await g.__ompUiMcpReady;
  } catch {
    // The boot load logs its own failure; agents still start, without MCP secrets.
  }
  return { ...g.__ompUiMcpEnv };
}
