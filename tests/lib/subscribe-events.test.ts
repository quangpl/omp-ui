import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENTS_REOPEN_MAX_MS,
  EVENTS_REOPEN_MIN_MS,
  EVENTS_RESUME_AFTER_MS,
  EVENTS_STALE_AFTER_MS,
  subscribeEvents,
} from "@/lib/api-client";

/** Just enough of the browser's EventSource for `subscribeEvents`, driven by the test. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    super();
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.closed = true;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  ping(): void {
    this.dispatchEvent(new MessageEvent("ping", { data: "" }));
  }

  /** `gaveUp`: the browser's terminal failure (readyState CLOSED); else it retries on its own. */
  fail(gaveUp: boolean): void {
    this.readyState = gaveUp ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.(new Event("error"));
  }
}

class FakeDocument extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";

  setVisibility(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function latest(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource opened");
  return source;
}

let doc: FakeDocument;
let win: EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  doc = new FakeDocument();
  win = new EventTarget();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("subscribeEvents", () => {
  it("delivers data frames and reports the first open separately from reconnects", () => {
    const onEvent = vi.fn();
    const onFirstOpen = vi.fn();
    const onReconnect = vi.fn();
    const onStatus = vi.fn();
    const stop = subscribeEvents(onEvent, { boardId: "b 1", onFirstOpen, onReconnect, onStatus });

    const source = latest();
    expect(source.url).toBe("/api/v1/events?boardId=b%201");
    source.open();
    expect(onStatus).toHaveBeenLastCalledWith("live");
    expect(onFirstOpen).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();

    source.message({ type: "queue.updated", running: [], queued: [] });
    expect(onEvent).toHaveBeenCalledWith({ type: "queue.updated", running: [], queued: [] });

    // A native retry (readyState stays CONNECTING) reopens the same source.
    source.fail(false);
    expect(onStatus).toHaveBeenLastCalledWith("reconnecting");
    source.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onFirstOpen).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    stop();
  });

  it("reopens a silent stream after the watchdog timeout and resyncs", () => {
    const onReconnect = vi.fn();
    const onStatus = vi.fn();
    const stop = subscribeEvents(() => {}, { onReconnect, onStatus });
    const first = latest();
    first.open();

    // Pings keep a quiet stream alive.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(EVENTS_STALE_AFTER_MS - 1);
      first.ping();
    }
    expect(FakeEventSource.instances).toHaveLength(1);

    // Then silence: a half-open connection never errors.
    vi.advanceTimersByTime(EVENTS_STALE_AFTER_MS);
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(onStatus).toHaveBeenLastCalledWith("reconnecting");
    expect(onReconnect).not.toHaveBeenCalled();

    latest().open();
    expect(onStatus).toHaveBeenLastCalledWith("live");
    expect(onReconnect).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reopens a stream the browser gave up on, with capped backoff reset on open", () => {
    const onReconnect = vi.fn();
    const stop = subscribeEvents(() => {}, { onReconnect });
    latest().open();

    const delays: number[] = [];
    let expected = EVENTS_REOPEN_MIN_MS;
    for (let attempt = 0; attempt < 8; attempt++) {
      const failed = latest();
      failed.fail(true);
      expect(failed.closed).toBe(true);
      const count = FakeEventSource.instances.length;
      vi.advanceTimersByTime(expected - 1);
      expect(FakeEventSource.instances).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(count + 1);
      delays.push(expected);
      expected = Math.min(expected * 2, EVENTS_REOPEN_MAX_MS);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(onReconnect).not.toHaveBeenCalled();

    latest().open();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // A successful open resets the backoff.
    latest().fail(true);
    const count = FakeEventSource.instances.length;
    vi.advanceTimersByTime(EVENTS_REOPEN_MIN_MS);
    expect(FakeEventSource.instances).toHaveLength(count + 1);
    stop();
  });

  it("reconnects before the first open with onReconnect, not onFirstOpen", () => {
    const onFirstOpen = vi.fn();
    const onReconnect = vi.fn();
    const stop = subscribeEvents(() => {}, { onFirstOpen, onReconnect });
    latest().fail(true);
    vi.advanceTimersByTime(EVENTS_REOPEN_MIN_MS);
    latest().open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onFirstOpen).not.toHaveBeenCalled();
    stop();
  });

  it("resyncs when the tab returns after a while and reopens a dead stream right away", () => {
    const onReconnect = vi.fn();
    const stop = subscribeEvents(() => {}, { onReconnect });
    const source = latest();
    source.open();

    // A short hide keeps going quietly.
    doc.setVisibility("hidden");
    vi.advanceTimersByTime(EVENTS_RESUME_AFTER_MS - 1);
    source.ping();
    doc.setVisibility("visible");
    expect(onReconnect).not.toHaveBeenCalled();

    // A longer one resyncs over the still-open stream.
    doc.setVisibility("hidden");
    vi.advanceTimersByTime(EVENTS_RESUME_AFTER_MS + 1);
    source.ping();
    doc.setVisibility("visible");
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);

    // Waiting out a backoff: coming back (or the network returning) reconnects immediately.
    source.fail(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    win.dispatchEvent(new Event("online"));
    expect(FakeEventSource.instances).toHaveLength(2);
    latest().open();
    expect(onReconnect).toHaveBeenCalledTimes(2);

    // The pending backoff timer was cancelled: no extra source later.
    vi.advanceTimersByTime(EVENTS_REOPEN_MAX_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
    stop();
  });

  it("stops every timer and listener on unsubscribe", () => {
    const onReconnect = vi.fn();
    const onStatus = vi.fn();

    // Unsubscribed while waiting out a backoff.
    const stopA = subscribeEvents(() => {}, { onReconnect, onStatus });
    latest().open();
    latest().fail(true);
    stopA();

    // Unsubscribed while open (watchdog armed).
    const stopB = subscribeEvents(() => {}, { onReconnect, onStatus });
    const open = latest();
    open.open();
    stopB();
    expect(open.closed).toBe(true);

    const opened = FakeEventSource.instances.length;
    const statusCalls = onStatus.mock.calls.length;
    vi.advanceTimersByTime(EVENTS_STALE_AFTER_MS * 4 + EVENTS_REOPEN_MAX_MS);
    doc.setVisibility("hidden");
    vi.advanceTimersByTime(EVENTS_RESUME_AFTER_MS * 2);
    doc.setVisibility("visible");
    win.dispatchEvent(new Event("online"));

    expect(FakeEventSource.instances).toHaveLength(opened);
    expect(onStatus).toHaveBeenCalledTimes(statusCalls);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
