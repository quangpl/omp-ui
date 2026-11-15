// Dialing another node: the cluster channel over TCP to its cluster port, falling back to the
// cluster WebSocket on its web URL (lib/cluster/websocket.ts) when the port is unreachable — e.g. a
// primary published only through a Cloudflare tunnel, where just HTTPS and WebSockets pass. The
// transport that worked is remembered per target and tried first next time.
import {
  ClusterAuthError,
  connectChannel,
  type ClusterChannel,
  type HelloInfo,
  type ServerIdentity,
} from "@/lib/cluster/protocol";
import { clusterWsUrl } from "@/lib/cluster/websocket";

/** Default deadline of one dial attempt (connect + handshake). */
const DIAL_TIMEOUT_MS = 10_000;
/** The TCP attempt gives up after this long so the WebSocket fallback still has time. */
const TCP_TIMEOUT_MS = 4_000;

type Transport = "tcp" | "ws";

/** A node to dial: its cluster port and (when known) its web URL for the WebSocket fallback. */
export interface DialTarget {
  host: string;
  port: number;
  httpUrl: string | null;
}

const g = globalThis as unknown as {
  /** `host:port|httpUrl` → the transport the latest successful dial used. */
  __ompUiClusterDialVia?: Map<string, Transport>;
};

/**
 * Connect to `target`: TCP first (connect timeout min(timeoutMs, 4 s) when a fallback exists);
 * when that fails with anything but a token mismatch (ClusterAuthError, rethrown as is), the
 * WebSocket at clusterWsUrl(httpUrl). A target that last worked over the WebSocket is dialed that
 * way first. Both failing → an Error naming both attempts.
 */
export async function dialPeer(
  target: DialTarget,
  opts: { token: string; hello: HelloInfo; timeoutMs?: number },
): Promise<{ channel: ClusterChannel; server: ServerIdentity; via: Transport }> {
  const via = (g.__ompUiClusterDialVia ??= new Map());
  const key = `${target.host}:${target.port}|${target.httpUrl ?? ""}`;
  const timeoutMs = opts.timeoutMs ?? DIAL_TIMEOUT_MS;
  const wsUrl = target.httpUrl ? clusterWsUrl(target.httpUrl) : null;
  const order: Transport[] = !wsUrl ? ["tcp"] : via.get(key) === "ws" ? ["ws", "tcp"] : ["tcp", "ws"];
  const failures: string[] = [];
  let lastError: unknown = null;
  for (const transport of order) {
    try {
      const result =
        transport === "ws" && wsUrl
          ? await connectChannel({ url: wsUrl, token: opts.token, hello: opts.hello, timeoutMs })
          : await connectChannel({
              host: target.host,
              port: target.port,
              token: opts.token,
              hello: opts.hello,
              timeoutMs: wsUrl ? Math.min(timeoutMs, TCP_TIMEOUT_MS) : timeoutMs,
            });
      via.set(key, transport);
      return { ...result, via: transport };
    } catch (err) {
      if (err instanceof ClusterAuthError) throw err;
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      failures.push(transport === "ws" ? `over the WebSocket ${wsUrl}: ${message}` : `over TCP: ${message}`);
    }
  }
  if (failures.length === 1) throw lastError;
  throw new Error(`Could not reach ${target.host}: ${failures.join("; ")}`);
}
