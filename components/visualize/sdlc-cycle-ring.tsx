"use client";

import { cn } from "@/lib/utils";

/** Ring geometry in the 100x100 viewBox; `ringPoint` defaults to the same radius so nodes sit on the stroke. */
const CENTER = 50;
const RADIUS = 41;
/** Degrees trimmed from each end of a phase arc so station nodes visibly interrupt the ring. */
const SEGMENT_GAP_DEG = 4;

/** Angle in degrees of slot `index` of `count` on the cycle; 0 = 12 o'clock, clockwise. Fractional indices land between slots (e.g. i + 0.5 = midway between station i and i+1). */
export function ringAngle(index: number, count: number): number {
  return count > 0 ? (index / count) * 360 : 0;
}

/** Rounds to 2 decimals and drops trailing zeros (and `-0`), keeping style strings and path data short. */
function fmt(n: number): number {
  return +n.toFixed(2) || 0;
}

/** Cartesian point on a circle around the box center; angle per the `ringAngle` convention. */
function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CENTER + radius * Math.sin(rad), y: CENTER - radius * Math.cos(rad) };
}

/** Center of slot `index` as CSS percentage offsets for absolutely-positioned children of the square board. `radius` is percent of the board (0 = center, 50 = edge); default 41 (on the ring). */
export function ringPoint(index: number, count: number, radius = RADIUS): { left: string; top: string } {
  const { x, y } = polar(ringAngle(index, count), radius);
  return { left: `${fmt(x)}%`, top: `${fmt(y)}%` };
}

/** Clockwise arc on the ring from `fromDeg` to `toDeg` (span under 360; sweep-flag 1 is clockwise in SVG's y-down space). */
function arcPath(fromDeg: number, toDeg: number): string {
  const a = polar(fromDeg, RADIUS);
  const b = polar(toDeg, RADIUS);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${fmt(a.x)} ${fmt(a.y)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${fmt(b.x)} ${fmt(b.y)}`;
}

export interface RingSegment {
  /** Phase id, used as the key. */
  id: string;
  /** Workers present at the station that starts this segment. */
  occupied: boolean;
  /** A gate breach on the transition this segment represents (station i -> station i+1). */
  alert: boolean;
  /** Every running card that includes this phase has finished it. */
  done: boolean;
}

/** Decorative cycle track for a square board: phase arcs tinted by occupancy, completion and breaches. */
export function CycleRing({
  segments,
  className,
}: {
  segments: RingSegment[];
  className?: string;
}) {
  const count = segments.length;
  const gap = count > 1 ? SEGMENT_GAP_DEG : 0;
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden
      focusable="false"
      fill="none"
      strokeLinecap="round"
      className={cn("pointer-events-none absolute inset-0 size-full overflow-visible", className)}
    >
      {/* Base track. */}
      <circle cx={CENTER} cy={CENTER} r={RADIUS} strokeWidth={1.2} stroke="currentColor" className="text-border opacity-60" />

      {/* Phase arcs: slot i to slot i+1, trimmed at both ends; color cross-fades as occupancy and alerts change. */}
      {count > 1 &&
        segments.map((segment, i) => (
          <path
            key={segment.id}
            d={arcPath(ringAngle(i, count) + gap, ringAngle(i + 1, count) - gap)}
            strokeWidth={1.6}
            stroke="currentColor"
            className={cn(
              "transition-colors duration-500 ease-out motion-reduce:transition-none",
              segment.alert ? "text-destructive" : segment.occupied ? "text-signal" : segment.done ? "text-success" : "text-border",
            )}
          />
        ))}
    </svg>
  );
}
