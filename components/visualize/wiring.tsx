"use client";

import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { LinkKind } from "./agent-map";

/** Every wire kind on the map: agent-to-agent links plus subagent and system hookups. */
export type WireKind = LinkKind | "subagent" | "uses";

/** One wire between two `data-node` endpoints inside the overlay's container. */
export interface Wire {
  /** data-node values of the two endpoints inside the container. */
  from: string;
  to: string;
  kind: WireKind;
  /** In use right now: drawn at full opacity, older links fade. */
  active?: boolean;
  /** Accessible / tooltip text, e.g. "Fix login messaged Add tests". */
  label?: string;
}

/** Colour + dash + legend label per kind; used by the legend and the overlay. One signal accent
 * (amber) for live agent talk, neutrals for structure, destructive for blockers; dashes tell the
 * rest apart. Theme tokens, so wires read in light and dark mode. */
export const WIRE_STYLE: Record<WireKind, { label: string; color: string; dash?: string }> = {
  message: { label: "Message", color: "var(--color-signal)" },
  wait: { label: "Waiting on", color: "var(--color-signal)", dash: "5 3" },
  inspect: { label: "Reading card", color: "var(--color-foreground)", dash: "0.5 4" },
  delegate: { label: "Delegated", color: "var(--color-foreground)" },
  depends: { label: "Blocked by", color: "var(--color-destructive)", dash: "6 4" },
  subagent: { label: "Subagent", color: "var(--color-muted-foreground)", dash: "2 2" },
  uses: { label: "Uses system", color: "var(--color-muted-foreground)" },
};

const ALL_KINDS = Object.keys(WIRE_STYLE) as WireKind[];

/** Stroke width per kind: system hookups are thin so agent links dominate. */
const strokeWidth = (kind: WireKind) => (kind === "uses" ? 1 : 1.5);
/** Dotted kinds need round caps for the zero-length dashes to render as dots. */
const lineCap = (kind: WireKind) => (kind === "inspect" ? "round" : "butt");

const wireKey = (wire: Wire) => `${wire.kind}\u0000${wire.from}\u0000${wire.to}`;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

interface Geometry {
  /** SVG path data, source edge midpoint → target edge midpoint. */
  d: string;
  /** Source terminal point. */
  sx: number;
  sy: number;
  /** Arrowhead polygon points at the target. */
  arrow: string;
}

/** Half-pixel rounding keeps path strings stable across sub-pixel layout jitter. */
const snap = (n: number) => Math.round(n * 2) / 2;

/** Keep a parallel-wire offset inside the endpoint's edge. */
const clampOffset = (offset: number, size: number) => Math.max(-size / 2 + 2, Math.min(size / 2 - 2, offset));

/** Cubic bezier between the facing edges of two boxes; `offset` fans out parallel wires. */
function route(a: Box, b: Box, offset: number): Geometry {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  let sx: number, sy: number, ex: number, ey: number, c1x: number, c1y: number, c2x: number, c2y: number;
  if (Math.abs(dx) > Math.abs(dy)) {
    const dir = dx >= 0 ? 1 : -1;
    sx = dir > 0 ? a.right : a.left;
    ex = dir > 0 ? b.left : b.right;
    sy = a.cy + clampOffset(offset, a.h);
    ey = b.cy + clampOffset(offset, b.h);
    const k = Math.max(16, Math.abs(ex - sx) / 2);
    c1x = sx + dir * k;
    c1y = sy;
    c2x = ex - dir * k;
    c2y = ey;
  } else {
    const dir = dy >= 0 ? 1 : -1;
    sy = dir > 0 ? a.bottom : a.top;
    ey = dir > 0 ? b.top : b.bottom;
    sx = a.cx + clampOffset(offset, a.w);
    ex = b.cx + clampOffset(offset, b.w);
    const k = Math.max(16, Math.abs(ey - sy) / 2);
    c1x = sx;
    c1y = sy + dir * k;
    c2x = ex;
    c2y = ey - dir * k;
  }
  [sx, sy, ex, ey, c1x, c1y, c2x, c2y] = [sx, sy, ex, ey, c1x, c1y, c2x, c2y].map(snap);

  // Arrowhead along the end tangent (end - c2; never zero since k >= 16).
  const tx = ex - c2x;
  const ty = ey - c2y;
  const len = Math.hypot(tx, ty) || 1;
  const ux = tx / len;
  const uy = ty / len;
  const bx = ex - ux * 7;
  const by = ey - uy * 7;
  const px = -uy * 3.5;
  const py = ux * 3.5;
  const arrow = `${ex},${ey} ${snap(bx + px)},${snap(by + py)} ${snap(bx - px)},${snap(by - py)}`;

  return { d: `M${sx} ${sy} C${c1x} ${c1y} ${c2x} ${c2y} ${ex} ${ey}`, sx, sy, arrow };
}

/** Absolutely positioned SVG over `containerRef` drawing an orthogonal/curved path between the
 * elements with `data-node={from}` and `data-node={to}` found inside the container. Re-measures on
 * ResizeObserver (container + endpoints), window resize, and when `wires` change. Wires whose
 * endpoints are missing or hidden (zero size) are skipped. pointer-events: none; aria-hidden.
 *
 * Render it as a child of the container, which must be positioned (`relative`). Coordinates
 * account for the container's border and scroll offset, so wires stay attached inside scrolling
 * containers. Re-measuring is requestAnimationFrame-throttled and also follows DOM mutations,
 * nested scrolling and finished transitions inside the container. */
export function Wiring({
  containerRef,
  wires,
  className,
}: {
  containerRef: RefObject<HTMLElement | null>;
  wires: Wire[];
  className?: string;
}) {
  const [geometry, setGeometry] = useState<ReadonlyMap<string, Geometry>>(() => new Map());
  const stampRef = useRef("");
  const wiresRef = useRef(wires);
  // Latest wires for rAF re-measures; declared before the measuring effect so it runs first.
  useLayoutEffect(() => {
    wiresRef.current = wires;
  });

  // Only the endpoints and kinds affect geometry; styling props never trigger a re-measure.
  const signature = useMemo(() => wires.map(wireKey).join("\u0001"), [wires]);

  useLayoutEffect(() => {
    let frame = 0;
    let teardown: (() => void) | undefined;

    const setup = (container: HTMLElement) => {
      const observed = new Set<Element>();
      const resize = new ResizeObserver(() => schedule());
      resize.observe(container);
      const mutations = new MutationObserver(() => schedule());
      mutations.observe(container, { childList: true, subtree: true, characterData: true });

      const measure = () => {
        frame = 0;
        const rect = container.getBoundingClientRect();
        const originX = rect.left + container.clientLeft - container.scrollLeft;
        const originY = rect.top + container.clientTop - container.scrollTop;
        const boxes = new Map<string, Box | null>();
        const seen = new Set<Element>();

        const boxOf = (id: string): Box | null => {
          const cached = boxes.get(id);
          if (cached !== undefined) return cached;
          const el = container.querySelector(`[data-node="${CSS.escape(id)}"]`);
          let box: Box | null = null;
          if (el) {
            seen.add(el);
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              const left = r.left - originX;
              const top = r.top - originY;
              box = {
                left,
                top,
                right: left + r.width,
                bottom: top + r.height,
                cx: left + r.width / 2,
                cy: top + r.height / 2,
                w: r.width,
                h: r.height,
              };
            }
          }
          boxes.set(id, box);
          return box;
        };

        // Parallel wires between the same pair fan out around the edge midpoint.
        const current = wiresRef.current;
        const pairOf = (w: Wire) => (w.from < w.to ? `${w.from}\u0000${w.to}` : `${w.to}\u0000${w.from}`);
        const pairTotals = new Map<string, number>();
        for (const w of current) pairTotals.set(pairOf(w), (pairTotals.get(pairOf(w)) ?? 0) + 1);
        const pairSeen = new Map<string, number>();

        const next = new Map<string, Geometry>();
        for (const w of current) {
          const pair = pairOf(w);
          const index = pairSeen.get(pair) ?? 0;
          pairSeen.set(pair, index + 1);
          const a = boxOf(w.from);
          const b = boxOf(w.to);
          if (!a || !b) continue;
          const offset = (index - ((pairTotals.get(pair) ?? 1) - 1) / 2) * 6;
          next.set(wireKey(w), route(a, b, offset));
        }

        for (const el of observed) {
          if (!seen.has(el)) {
            resize.unobserve(el);
            observed.delete(el);
          }
        }
        for (const el of seen) {
          if (!observed.has(el)) {
            resize.observe(el);
            observed.add(el);
          }
        }

        const stamp = [...next].map(([key, g]) => `${key}\u0002${g.d}`).join("\u0001");
        if (stamp !== stampRef.current) {
          stampRef.current = stamp;
          setGeometry(next);
        }
      };

      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(measure);
      };

      window.addEventListener("resize", schedule);
      container.addEventListener("scroll", schedule, { capture: true, passive: true });
      container.addEventListener("transitionend", schedule);
      // Entry animations (floor-in) move endpoints with transforms, which ResizeObserver misses.
      container.addEventListener("animationend", schedule);
      measure();

      teardown = () => {
        resize.disconnect();
        mutations.disconnect();
        window.removeEventListener("resize", schedule);
        container.removeEventListener("scroll", schedule, { capture: true });
        container.removeEventListener("transitionend", schedule);
        container.removeEventListener("animationend", schedule);
      };
    };

    // A parent's ref attaches after its children's layout effects on first mount: retry next frame.
    const start = () => {
      frame = 0;
      const container = containerRef.current;
      if (container) setup(container);
      else frame = requestAnimationFrame(start);
    };
    start();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      teardown?.();
    };
  }, [containerRef, signature]);

  return (
    <svg
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 size-full overflow-visible", className)}
    >
      {wires.map((wire) => {
        const key = wireKey(wire);
        const g = geometry.get(key);
        if (!g) return null;
        const style = WIRE_STYLE[wire.kind];
        const width = strokeWidth(wire.kind) + (wire.active ? 0.5 : 0);
        return (
          <g
            key={key}
            data-wire-kind={wire.kind}
            data-wire-from={wire.from}
            data-wire-to={wire.to}
            data-wire-active={wire.active ? "" : undefined}
            style={{ color: style.color }}
            opacity={wire.active ? 1 : 0.55}
          >
            <path
              d={g.d}
              fill="none"
              stroke="currentColor"
              strokeWidth={width}
              strokeDasharray={style.dash}
              strokeLinecap={lineCap(wire.kind)}
              opacity={wire.active ? 0.4 : 1}
            >
              <title>{wire.label ?? `${style.label}: ${wire.from} → ${wire.to}`}</title>
            </path>
            {/* Live wires carry flowing dashes over the faint base line; idle ones stay still. */}
            {wire.active && (
              <path d={g.d} fill="none" stroke="currentColor" strokeWidth={width} className="animate-wire-flow" />
            )}
            <rect x={g.sx - 2.5} y={g.sy - 2.5} width={5} height={5} fill="currentColor" />
            <polygon points={g.arrow} fill="currentColor" />
          </g>
        );
      })}
    </svg>
  );
}

/** Legend: a compact mono key, one short line sample per wire kind (its colour and dash). */
export function WireLegend({ kinds = ALL_KINDS, className }: { kinds?: WireKind[]; className?: string }) {
  return (
    <ul
      aria-label="Wire key"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground", className)}
    >
      {kinds.map((kind) => {
        const style = WIRE_STYLE[kind];
        return (
          <li key={kind} className="flex items-center gap-1">
            <svg
              aria-hidden
              width={18}
              height={6}
              viewBox="0 0 18 6"
              className="shrink-0 overflow-visible"
              style={{ color: style.color }}
            >
              <line
                x1={0}
                y1={3}
                x2={14}
                y2={3}
                stroke="currentColor"
                strokeWidth={strokeWidth(kind) + 0.5}
                strokeDasharray={style.dash}
                strokeLinecap={lineCap(kind)}
              />
              <polygon points="18,3 13.5,0.5 13.5,5.5" fill="currentColor" />
            </svg>
            {style.label}
          </li>
        );
      })}
    </ul>
  );
}
