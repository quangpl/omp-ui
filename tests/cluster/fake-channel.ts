// In-memory ClusterChannel pair for cluster tests: what one side sends the other receives, in
// order and asynchronously (like a socket), as structured copies. Mirrors lib/cluster/protocol.ts
// semantics: prefix routing, request/reply via `rid` (pending requests resolve before the handlers
// see the reply), close propagation to both ends.
import { randomUUID } from "node:crypto";

import type { ClusterChannel } from "@/lib/cluster/protocol";
import type { BinaryHeader, WireMessage } from "@/lib/cluster/types";

interface PendingRequest {
  resolve(msg: WireMessage): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** One end of an in-memory channel; `sentBinary`/`sentBytes` count what this end sent. */
export class FakeChannel implements ClusterChannel {
  readonly id = randomUUID();
  readonly remote = { host: "127.0.0.1", port: 0 };
  readonly latencyMs = 0;
  /** Binary frames and their payload bytes sent by this end. */
  sentBinary = 0;
  sentBytes = 0;
  closed = false;
  other!: FakeChannel;
  private readonly routes = new Set<{ prefix: string; handler: (msg: WireMessage) => void }>();
  private readonly binaryRoutes = new Set<{ prefix: string; handler: (h: BinaryHeader, data: Buffer) => void }>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private closeReason = "closed";

  constructor(readonly peer: { nodeId: string; name: string }) {}

  send(msg: WireMessage): boolean {
    if (this.closed) return false;
    const copy = structuredClone(msg);
    setImmediate(() => this.other.dispatch(copy));
    return true;
  }

  sendBinary(header: BinaryHeader, data: Uint8Array): boolean {
    if (this.closed) return false;
    const copy = { header: structuredClone(header), data: Buffer.from(data) };
    this.sentBinary++;
    this.sentBytes += data.length;
    setImmediate(() => this.other.dispatchBinary(copy.header, copy.data));
    return true;
  }

  async drain(): Promise<void> {}

  on(prefix: string, handler: (msg: WireMessage) => void): () => void {
    const route = { prefix, handler };
    this.routes.add(route);
    return () => this.routes.delete(route);
  }

  onBinary(prefix: string, handler: (h: BinaryHeader, data: Buffer) => void): () => void {
    const route = { prefix, handler };
    this.binaryRoutes.add(route);
    return () => this.binaryRoutes.delete(route);
  }

  onClose(handler: (reason: string) => void): () => void {
    if (this.closed) {
      handler(this.closeReason);
      return () => undefined;
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  request<T extends WireMessage = WireMessage>(msg: WireMessage, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("channel closed"));
    const rid = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.pending.delete(rid);
      reject(new Error(`request ${msg.t} timed out`));
    }, timeoutMs);
    this.pending.set(rid, { resolve: (reply) => resolve(reply as T), reject, timer });
    this.send({ ...msg, rid });
    return promise;
  }

  reply(to: WireMessage, msg: WireMessage): boolean {
    return this.send({ ...msg, rid: to.rid });
  }

  close(reason = "closed"): void {
    this.shut(reason);
    this.other.shut(reason);
  }

  private shut(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`channel closed: ${reason}`));
    }
    this.pending.clear();
    for (const handler of [...this.closeHandlers]) handler(reason);
    this.closeHandlers.clear();
  }

  private dispatch(msg: WireMessage): void {
    if (this.closed) return;
    const pending = typeof msg.rid === "string" ? this.pending.get(msg.rid) : undefined;
    if (pending && typeof msg.rid === "string") {
      this.pending.delete(msg.rid);
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
    for (const route of [...this.routes]) if (msg.t.startsWith(route.prefix)) route.handler(msg);
  }

  private dispatchBinary(header: BinaryHeader, data: Buffer): void {
    if (this.closed) return;
    for (const route of [...this.binaryRoutes]) if (header.t.startsWith(route.prefix)) route.handler(header, data);
  }
}

/** Two connected ends: `[primary, node]` by convention (only the peer names differ). */
export function channelPair(): [FakeChannel, FakeChannel] {
  const primary = new FakeChannel({ nodeId: "node-1", name: "node" });
  const node = new FakeChannel({ nodeId: "primary-1", name: "primary" });
  primary.other = node;
  node.other = primary;
  return [primary, node];
}
