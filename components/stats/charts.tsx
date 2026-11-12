"use client";

// Lightweight, dependency-free chart primitives for the Stats page. Every component is a memoized
// leaf; animation is transform/opacity (or SVG dash offsets) and honours prefers-reduced-motion.
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { TONE_STROKE, TONE_TEXT, toneForFraction, wholeNumber, type Tone } from "./shared";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Rounds SVG coordinates so path strings stay short. */
const fmt = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------
// AnimatedNumber

const defaultNumberFormat = (n: number) => wholeNumber.format(Math.round(n));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** Number that tweens from its previous value; frames write straight to the DOM, not React state. */
export const AnimatedNumber = memo(function AnimatedNumber({
  value,
  format = defaultNumberFormat,
  durationMs = 600,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  durationMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // Value currently painted; survives interrupted tweens so the next one starts from there.
  const shown = useRef(value);
  // React owns only the first paint; afterwards the effect owns the text so re-renders never fight it.
  const [initialText] = useState(() => format(value));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    const to = value;
    if (from === to || durationMs <= 0 || !Number.isFinite(from) || !Number.isFinite(to) || prefersReducedMotion()) {
      shown.current = to;
      el.textContent = format(to);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const current = progress === 1 ? to : from + (to - from) * easeOutCubic(progress);
      shown.current = current;
      el.textContent = format(current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, format, durationMs]);

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {initialText}
    </span>
  );
});

// ---------------------------------------------------------------------------------------------
// Sparkline

/** Vertical padding (viewBox units) so the stroke and dot never touch the edges. */
const PAD_TOP = 8;
const PAD_BOTTOM = 4;
const SLIDE_MS = 600;

type Point = readonly [x: number, y: number];

/** Monotone cubic interpolation (Fritsch–Butland tangents): smooth, never overshoots the data. */
function monotonePath(points: readonly Point[]): string {
  const n = points.length;
  if (n < 2) return "";
  if (n === 2) return `M${fmt(points[0][0])},${fmt(points[0][1])}L${fmt(points[1][0])},${fmt(points[1][1])}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push(dx[i] === 0 ? 0 : (points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const tangent = new Array<number>(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1];
    const b = slope[i];
    if (a * b <= 0) {
      tangent[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / a + w2 / b);
    }
  }

  let d = `M${fmt(points[0][0])},${fmt(points[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = dx[i] / 3;
    d += `C${fmt(x0 + h)},${fmt(y0 + tangent[i] * h)},${fmt(x1 - h)},${fmt(y1 - tangent[i + 1] * h)},${fmt(x1)},${fmt(y1)}`;
  }
  return d;
}

/** True when `next` is `prev` advanced by exactly one new sample (appended, or ring-buffer shifted). */
function isNextSample(prev: readonly number[], next: readonly number[]): boolean {
  if (prev.length === 0) return false;
  if (next.length === prev.length + 1) {
    for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false;
    return true;
  }
  if (next.length === prev.length) {
    for (let i = 1; i < prev.length; i++) if (prev[i] !== next[i - 1]) return false;
    return true;
  }
  return false;
}

/**
 * Right-aligned live trend line. With `capacity`, the x-axis is fixed to that many samples so new
 * samples slide in from the right.
 */
export const Sparkline = memo(function Sparkline({
  values,
  capacity,
  min = 0,
  max,
  tone = "primary",
  label,
  className,
  showDot = true,
}: {
  values: number[];
  capacity?: number;
  min?: number;
  max?: number;
  tone?: Tone;
  label: string;
  className?: string;
  showDot?: boolean;
}) {
  const gradientId = `spark-${useId().replace(/[^\w-]/g, "")}`;
  const slideRef = useRef<HTMLDivElement>(null);
  const previous = useRef<readonly number[]>([]);

  const n = values.length;
  const slots = Math.max(capacity ?? n, n, 2);
  const step = 100 / (slots - 1);

  const geometry = useMemo(() => {
    if (n < 2) return null;
    let top = max ?? Math.max(...values);
    if (max === undefined && !(top > 0)) top = 1;
    if (!(top > min)) top = min + 1;
    const span = top - min;
    const points = values.map((v, i): Point => {
      const norm = clamp01((v - min) / span);
      return [100 - (n - 1 - i) * step, 100 - PAD_BOTTOM - norm * (100 - PAD_TOP - PAD_BOTTOM)];
    });
    const line = monotonePath(points);
    const first = points[0][0];
    return {
      line,
      area: `${line}L100,100L${fmt(first)},100Z`,
      lastY: points[n - 1][1],
    };
  }, [values, n, min, max, step]);

  // Slide the plot one step to the right, then glide back, so the new sample enters from the edge.
  useLayoutEffect(() => {
    const prev = previous.current;
    previous.current = values.slice();
    const el = slideRef.current;
    if (!el || n < 2 || !isNextSample(prev, values) || prefersReducedMotion()) return;
    el.style.transition = "none";
    el.style.transform = `translateX(${step}%)`;
    void el.getBoundingClientRect();
    el.style.transition = `transform ${SLIDE_MS}ms var(--ease-out-smooth)`;
    el.style.transform = "translateX(0)";
  }, [values, n, step]);

  return (
    <div role="img" aria-label={label} className={cn("relative h-full w-full", TONE_TEXT[tone], className)}>
      {geometry ? (
        <>
          <div className="absolute inset-y-0 right-1 left-0 overflow-hidden">
            <div ref={slideRef} className="absolute inset-0">
              <svg
                aria-hidden
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full overflow-visible"
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <path d={geometry.area} fill={`url(#${gradientId})`} />
                <path
                  d={geometry.line}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          </div>
          {showDot && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-1 left-0 transition-transform duration-[600ms] ease-(--ease-out-smooth) motion-reduce:transition-none"
              style={{ transform: `translateY(${geometry.lastY}%)` }}
            >
              <span className="absolute top-0 right-0 size-2 translate-x-1/2 -translate-y-1/2">
                <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-50 motion-reduce:animate-none" />
                <span className="relative block size-2 rounded-full bg-current ring-2 ring-card" />
              </span>
            </div>
          )}
        </>
      ) : (
        <div
          aria-hidden
          className="absolute inset-x-0 border-t border-dashed border-current opacity-30"
          style={{ bottom: `${PAD_BOTTOM}%` }}
        />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// RadialGauge

/** Circular progress ring starting at 12 o'clock; arc length eases between values. */
export const RadialGauge = memo(function RadialGauge({
  fraction,
  size = 88,
  thickness = 8,
  tone,
  label,
  className,
  children,
}: {
  fraction: number;
  size?: number;
  thickness?: number;
  tone?: Tone;
  label: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const clamped = clamp01(fraction);
  const center = size / 2;
  const radius = Math.max(0, (size - thickness) / 2);
  const circumference = 2 * Math.PI * radius;
  const resolvedTone = tone ?? toneForFraction(clamped);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0">
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          className="stroke-foreground/[0.07]"
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          transform={`rotate(-90 ${center} ${center})`}
          className={cn(
            "transition-[stroke-dashoffset,opacity] duration-700 ease-(--ease-out-smooth) motion-reduce:transition-none",
            TONE_STROKE[resolvedTone],
            clamped === 0 && "opacity-0",
          )}
        />
      </svg>
      {children !== undefined && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// SegmentBar

export interface Segment {
  key: string;
  value: number;
  label: string;
  /** Background class, e.g. `bg-primary`. */
  className: string;
}

/** Stacked horizontal bar; segments resize with transform only. Callers render the legend. */
export const SegmentBar = memo(function SegmentBar({
  segments,
  className,
  height = "h-2",
}: {
  segments: Segment[];
  className?: string;
  height?: string;
}) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  let running = 0;
  const layers = segments.map((segment) => {
    running += Math.max(0, segment.value);
    return { segment, start: 0, end: total > 0 ? running / total : 0 };
  });
  for (let i = 1; i < layers.length; i++) layers[i].start = layers[i - 1].end;

  const motion = "transition-transform duration-700 ease-(--ease-out-smooth) motion-reduce:transition-none";

  return (
    <div aria-hidden className={cn("relative w-full overflow-hidden rounded-full bg-foreground/[0.07]", height, className)}>
      {/* Each segment covers only its own span, so translucent colors never show another segment through. */}
      {layers.map(({ segment, start, end }) => (
        <div
          key={segment.key}
          className={cn("absolute inset-0 origin-left", motion, segment.className)}
          style={{ transform: `translateX(${start * 100}%) scaleX(${end - start})` }}
        />
      ))}
      {/* 1px card-colored dividers at each internal boundary between non-empty segments. */}
      {layers.map(({ segment, start, end }, i) => (
        <div
          key={`gap-${segment.key}`}
          className={cn("absolute inset-0", motion, (i === 0 || end - start <= 0 || start <= 0) && "opacity-0")}
          style={{ transform: `translateX(${start * 100}%)` }}
        >
          <span className="absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-card" />
        </div>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// LiveIndicator

const LIVE_STATES = {
  live: { label: "Live", pill: "bg-success/10 text-success ring-success/20", dot: "bg-success" },
  stale: {
    label: "Stale",
    pill: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-400",
    dot: "bg-amber-500 dark:bg-amber-400",
  },
  connecting: {
    label: "Connecting",
    pill: "bg-muted text-muted-foreground ring-foreground/[0.07]",
    dot: "bg-muted-foreground",
  },
} as const;

/** Connection pill for real-time data. */
export const LiveIndicator = memo(function LiveIndicator({
  state,
  className,
}: {
  state: "live" | "stale" | "connecting";
  className?: string;
}) {
  const { label, pill, dot } = LIVE_STATES[state];
  return (
    <span
      role="status"
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium tracking-wide ring-1 ring-inset",
        pill,
        className,
      )}
    >
      <span aria-hidden className="relative flex size-1.5">
        {state === "live" && (
          <span className={cn("absolute inset-0 animate-ping rounded-full opacity-70 motion-reduce:animate-none", dot)} />
        )}
        <span
          className={cn(
            "relative size-1.5 rounded-full",
            dot,
            state === "connecting" && "animate-pulse motion-reduce:animate-none",
          )}
        />
      </span>
      {label}
    </span>
  );
});

// ---------------------------------------------------------------------------------------------
// RefreshRing

/** Tiny countdown ring that drains over `intervalMs` after each update. */
export const RefreshRing = memo(function RefreshRing({
  intervalMs,
  lastUpdated,
  size = 16,
  className,
}: {
  intervalMs: number;
  lastUpdated: number | null;
  size?: number;
  className?: string;
}) {
  const ringRef = useRef<SVGCircleElement>(null);
  const strokeWidth = 2;
  const center = size / 2;
  const radius = Math.max(0, (size - strokeWidth) / 2);
  const circumference = 2 * Math.PI * radius;

  // Restart the drain on every update; offset by time already elapsed since the sample landed.
  useEffect(() => {
    const ring = ringRef.current;
    if (!ring || lastUpdated === null || intervalMs <= 0 || prefersReducedMotion()) return;
    const animation = ring.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: circumference }], {
      duration: intervalMs,
      delay: -Math.min(intervalMs, Math.max(0, Date.now() - lastUpdated)),
      easing: "linear",
      fill: "forwards",
    });
    return () => animation.cancel();
  }, [lastUpdated, intervalMs, circumference]);

  return (
    <span
      aria-hidden
      title={`Next update in ~${Math.max(1, Math.round(intervalMs / 1000))}s`}
      className={cn("inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={center} cy={center} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-foreground/10" />
        <circle
          ref={ringRef}
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={lastUpdated === null ? circumference : 0}
          transform={`rotate(-90 ${center} ${center})`}
          className={cn(TONE_STROKE.primary, "opacity-70")}
        />
      </svg>
    </span>
  );
});
