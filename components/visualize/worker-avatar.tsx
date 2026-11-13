import type { CSSProperties } from "react";
import type { AgentRole } from "@/components/visualize/roles";
import { cn } from "@/lib/utils";

/** How the worker looks: the five floor states plus the finer feelings of a running agent. */
export type WorkerMood =
  | "working"
  | "waiting"
  | "happy"
  | "error"
  | "sleeping"
  /** Idle thinking: eyes up, thought dots. */
  | "thinking"
  /** Deep thinking / active problem solving: narrowed eyes, turning gear. */
  | "focused"
  /** Confused: mismatched eyes, "?" over the head. */
  | "stuck"
  /** Fatigue: droopy half-closed eyes, sweat drop, dim antenna. */
  | "tired"
  /** Too much at once: wide eyes, "!!", shaking. */
  | "overloaded"
  /** Errors piling up: red visor, steam puffs. */
  | "overheated"
  /** Getting there: wavy mouth, sweat drop, faster bob. */
  | "stressed"
  /** Fresh and productive: sparkle eyes, lightning spark, bouncy. */
  | "energized"
  /** Asks for help: worried brows, raised hand. */
  | "needs-help";

/** Human label of a mood for captions/tooltips. */
export const MOOD_LABEL: Record<WorkerMood, string> = {
  working: "Working",
  waiting: "In line",
  happy: "Done",
  error: "Broken down",
  sleeping: "Asleep",
  thinking: "Thinking",
  focused: "Deep in thought",
  stuck: "Stuck",
  tired: "Tired",
  overloaded: "Overloaded",
  overheated: "Running hot",
  stressed: "Stressed",
  energized: "Energized",
  "needs-help": "Needs help",
};

const GLOW: Partial<Record<WorkerMood, string>> = {
  error: "oklch(0.7 0.2 25)",
  happy: "oklch(0.82 0.16 158)",
  overheated: "oklch(0.68 0.21 30)",
  tired: "oklch(0.68 0.06 200)",
  energized: "oklch(0.93 0.16 190)",
  "needs-help": "oklch(0.85 0.13 85)",
};

/** Whole-robot motion per mood (only when animated). */
const BODY_MOTION: Partial<Record<WorkerMood, string>> = {
  working: "animate-worker-bob",
  energized: "animate-worker-bounce",
  stressed: "animate-worker-bob-fast",
  overloaded: "animate-worker-shake",
  stuck: "animate-worker-tilt",
};

const SIGNALING: Partial<Record<WorkerMood, true>> = { working: true, focused: true, energized: true };
const DIM_TIP: Partial<Record<WorkerMood, true>> = { sleeping: true, waiting: true, tired: true };
const SWEAT = "oklch(0.8 0.09 225)";

interface Palette {
  hue: number;
  paint: string;
  shade: string;
  light: string;
  dark: string;
  visor: string;
  glow: string;
  /** Status light colour (antenna tip, lamp, orb). */
  tip: string;
  tipClass: string | undefined;
  chestOpacity: number;
}

/**
 * A little robot worker. Colour comes from `hue` (see workerIdentity) so every card has its own
 * worker; the silhouette follows `role`, the face follows `mood`. Animations are CSS utilities from
 * globals.css, all disabled by prefers-reduced-motion.
 */
export function WorkerAvatar({
  hue,
  mood,
  role = "lead",
  help = false,
  className,
  animated = true,
}: {
  hue: number;
  mood: WorkerMood;
  role?: AgentRole;
  /** Draws a "!" help badge regardless of mood. */
  help?: boolean;
  className?: string;
  animated?: boolean;
}) {
  const glow = GLOW[mood] ?? "oklch(0.86 0.13 200)";
  const c: Palette = {
    hue,
    paint: `oklch(0.7 0.13 ${hue})`,
    shade: `oklch(0.56 0.12 ${hue})`,
    light: `oklch(0.8 0.12 ${hue})`,
    dark: `oklch(0.42 0.09 ${hue})`,
    visor: mood === "overheated" ? "oklch(0.3 0.08 25)" : "oklch(0.22 0.03 270)",
    glow,
    tip: DIM_TIP[mood] ? `oklch(0.56 0.12 ${hue})` : glow,
    tipClass: animated && SIGNALING[mood] ? "animate-worker-signal" : undefined,
    chestOpacity: mood === "sleeping" ? 0.35 : mood === "tired" ? 0.5 : 0.85,
  };
  const square = role === "guard";
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      className={cn("shrink-0 overflow-visible", animated && BODY_MOTION[mood], className)}
    >
      <Backdrop role={role} c={c} />
      <Antenna role={role} c={c} />
      <Ears role={role} c={c} />
      {/* head + visor */}
      <rect x="13" y="12" width="38" height="30" rx={square ? 4 : 10} fill={c.paint} />
      <rect x="18" y="18" width="28" height="18" rx={square ? 3 : 6} fill={c.visor} />
      <Headgear role={role} c={c} />
      {/* body */}
      <rect x="19" y="44" width="26" height="16" rx="6" fill={c.shade} />
      <Chest role={role} c={c} />
      <g key={mood} className={cn(animated && "animate-mood-in")}>
        <Face mood={mood} glow={glow} blink={animated} />
        <Overlay mood={mood} c={c} animated={animated} />
      </g>
      <Eyewear role={role} c={c} />
      {help && (
        <g className={cn(animated && "animate-worker-help")}>
          <circle
            cx="58"
            cy="2"
            r="5.5"
            fill="oklch(0.78 0.15 75)"
            strokeWidth="1.5"
            style={{ stroke: "var(--background)" }}
          />
          <path d="M58 -1v3.4" stroke="oklch(0.25 0.05 60)" strokeWidth="2" strokeLinecap="round" />
          <circle cx="58" cy="5" r="1.1" fill="oklch(0.25 0.05 60)" />
        </g>
      )}
    </svg>
  );
}

/** Painted outline of a worker where nobody stands yet (an open station). Static, `currentColor`. */
export function WorkerOutline({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeDasharray="3 3"
      className={cn("shrink-0", className)}
    >
      <rect x="13" y="12" width="38" height="30" rx="10" />
      <rect x="19" y="44" width="26" height="16" rx="6" />
    </svg>
  );
}

const MANA = "oklch(0.68 0.16 265)";
const MANA_LOW = "oklch(0.78 0.15 75)";
const MANA_EMPTY = "oklch(0.63 0.2 25)";

/** "Mana": context window left. value 0..1, null = unknown (renders a dim empty track with no fill). */
export function ManaBar({ value, className }: { value: number | null; className?: string }) {
  const left = value === null ? null : Math.min(1, Math.max(0, value));
  const pct = left === null ? undefined : Math.round(left * 100);
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={pct === undefined ? "Mana: unknown" : `Mana: ${pct}% of context left`}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted", left === null && "opacity-50", className)}
    >
      {left !== null && (
        <div
          className="h-full rounded-full transition-[width,background-color] duration-500 motion-reduce:transition-none"
          style={{ width: `${pct}%`, backgroundColor: left < 0.12 ? MANA_EMPTY : left < 0.3 ? MANA_LOW : MANA }}
        />
      )}
    </div>
  );
}

/** Pieces behind the head (the medium's hood). */
function Backdrop({ role, c }: { role: AgentRole; c: Palette }) {
  if (role !== "oracle") return null;
  return <path d="M9 42V24Q9 3 32 3Q55 3 55 24V42Z" fill={c.dark} />;
}

function Antenna({ role, c }: { role: AgentRole; c: Palette }) {
  switch (role) {
    case "lead":
      return (
        <g>
          <line x1="32" y1="7" x2="32" y2="13" stroke={c.shade} strokeWidth="2.5" strokeLinecap="round" />
          <path
            d="M32 -0.6L33.18 2.38L36.37 2.58L33.9 4.62L34.7 7.72L32 6L29.3 7.72L30.1 4.62L27.63 2.58L30.82 2.38Z"
            fill={c.tip}
            stroke={c.tip}
            strokeWidth="1"
            strokeLinejoin="round"
            className={c.tipClass}
          />
        </g>
      );
    case "worker":
      return null; // the hard hat carries the lamp
    case "scout":
      return (
        <g>
          <line x1="32" y1="2" x2="32" y2="13" stroke={c.shade} strokeWidth="2.2" strokeLinecap="round" />
          <path d="M24.5 -2Q32 8 39.5 -2Z" fill={c.shade} />
          <line x1="32" y1="2" x2="32" y2="-3" stroke={c.shade} strokeWidth="1.2" />
          <circle cx="32" cy="-3.6" r="1.9" fill={c.tip} className={c.tipClass} />
        </g>
      );
    case "guard":
      return (
        <g>
          <line x1="32" y1="8" x2="32" y2="13" stroke={c.shade} strokeWidth="3" />
          <rect x="25.5" y="4.5" width="13" height="4" rx="1.6" fill={c.tip} className={c.tipClass} />
        </g>
      );
    case "sprinter":
      return (
        <path
          d="M35 -3L27.5 6H31.8L29.5 13L37 3.6H32.6Z"
          fill={c.tip}
          stroke={c.shade}
          strokeWidth="0.8"
          strokeLinejoin="round"
          className={c.tipClass}
        />
      );
    case "oracle":
      return (
        <g>
          <path d="M28.5 3.6h7" stroke={c.shade} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="32" cy="-1.2" r="4.4" fill={c.tip} opacity="0.9" className={c.tipClass} />
          <circle cx="30.5" cy="-2.7" r="1.2" fill="white" opacity="0.7" />
        </g>
      );
    case "planner":
      return (
        <g>
          <rect x="30" y="1.5" width="4" height="11.5" fill={c.light} />
          <rect x="30" y="10" width="4" height="2" fill={c.shade} />
          <path d="M30 1.5L32 -3L34 1.5Z" fill="oklch(0.88 0.05 75)" />
          <path d="M31.1 -1L32 -3L32.9 -1Z" fill={c.tip} className={c.tipClass} />
        </g>
      );
    case "designer":
      return null; // the beret carries the status dot
    case "helper":
      return (
        <g>
          <line x1="32" y1="9" x2="32" y2="13" stroke={c.shade} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="32" cy="8" r="2.4" fill={c.tip} className={c.tipClass} />
        </g>
      );
    default:
      return (
        <g>
          <line x1="32" y1="6" x2="32" y2="13" stroke={c.shade} strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="32" cy="5" r="3.2" fill={c.tip} className={c.tipClass} />
        </g>
      );
  }
}

function Ears({ role, c }: { role: AgentRole; c: Palette }) {
  if (role === "oracle") return null; // hidden under the hood
  const rx = role === "guard" ? 1 : 2.5;
  return (
    <g>
      {role === "sprinter" && <path d="M10 23L1 19.5L10 31ZM54 23L63 19.5L54 31Z" fill={c.dark} />}
      {role === "worker" && (
        <g stroke={c.shade} strokeLinecap="round" fill="none">
          <path d="M55 27h4" strokeWidth="2.5" />
          <path d="M62.5 25a2.4 2.4 0 1 0 0 4" strokeWidth="2" />
        </g>
      )}
      <rect x="9" y="22" width="6" height="10" rx={rx} fill={c.shade} />
      <rect x="49" y="22" width="6" height="10" rx={rx} fill={c.shade} />
    </g>
  );
}

/** Pieces worn on the head, drawn over it (hard hat, beret, goggle strap). */
function Headgear({ role, c }: { role: AgentRole; c: Palette }) {
  switch (role) {
    case "worker":
      return (
        <g>
          <path d="M15.5 15.5a16.5 8 0 0 1 33 0Z" fill={c.light} />
          <rect x="30.5" y="7.6" width="3" height="7.9" fill={c.shade} />
          <rect x="11" y="15" width="42" height="2.6" rx="1.3" fill={c.shade} />
          <circle cx="32" cy="6.4" r="1.9" fill={c.tip} className={c.tipClass} />
        </g>
      );
    case "designer":
      return (
        <g>
          <path d="M33 7l1.6-3.2" stroke={c.dark} strokeWidth="2" strokeLinecap="round" />
          <path d="M13 16Q12.5 6.5 31 6.5Q49.5 6.5 51.5 13.5Q45 17.5 13 16Z" fill={c.dark} />
          <circle cx="22" cy="11.5" r="1.9" fill={c.tip} className={c.tipClass} />
        </g>
      );
    case "scout":
      return (
        <g fill={c.shade}>
          <rect x="13" y="24" width="5" height="4" />
          <rect x="46" y="24" width="5" height="4" />
        </g>
      );
    default:
      return null;
  }
}

/** Chest panel: status light plus the role's emblem. */
function Chest({ role, c }: { role: AgentRole; c: Palette }) {
  const light = <rect x="27" y="48" width="10" height="5" rx="2" fill={c.glow} opacity={c.chestOpacity} />;
  switch (role) {
    case "lead":
      return (
        <g>
          {light}
          <path d="M28.5 57l3.5-2 3.5 2" stroke={c.light} strokeWidth="1.6" strokeLinecap="round" fill="none" />
        </g>
      );
    case "worker":
      return (
        <g>
          {light}
          <rect x="19" y="54.5" width="26" height="2.2" fill={c.dark} />
        </g>
      );
    case "reviewer":
      return (
        <g>
          <rect x="25" y="46" width="14" height="12" rx="1.5" fill="oklch(0.95 0.01 90)" />
          <rect x="29" y="44.5" width="6" height="3" rx="1" fill={c.dark} />
          <path d="M28 51h8" stroke={c.glow} strokeWidth="1.4" strokeLinecap="round" opacity={c.chestOpacity} />
          <path d="M28 54.5h5" stroke={c.shade} strokeWidth="1.4" strokeLinecap="round" />
        </g>
      );
    case "guard":
      return (
        <path
          d="M32 46l6 2.2v4.3q0 4.3-6 6.5q-6-2.2-6-6.5v-4.3Z"
          fill={c.glow}
          fillOpacity={c.chestOpacity}
          stroke={c.light}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      );
    case "sprinter":
      return (
        <g>
          {light}
          <path d="M21.5 50h3M21.5 53h2" stroke={c.light} strokeWidth="1.4" strokeLinecap="round" />
        </g>
      );
    case "oracle":
      return <circle cx="32" cy="51.5" r="3.4" fill={c.glow} opacity={c.chestOpacity} />;
    case "planner":
      return (
        <g>
          <rect x="24" y="46.5" width="16" height="11" rx="1.5" fill={c.visor} />
          <path
            d="M26 49.6l1 1 1.8-1.8M26 54.1l1 1 1.8-1.8"
            stroke={c.glow}
            strokeWidth="1.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            opacity={c.chestOpacity}
          />
          <path d="M30.5 50h7M30.5 54.5h5" stroke={c.light} strokeWidth="1.2" strokeLinecap="round" />
        </g>
      );
    case "designer":
      return (
        <g>
          <ellipse cx="32" cy="52" rx="6.5" ry="4.6" fill="oklch(0.94 0.02 90)" />
          <circle cx="29.3" cy="50.6" r="1.3" fill={`oklch(0.7 0.16 ${(c.hue + 120) % 360})`} />
          <circle cx="32.8" cy="49.9" r="1.3" fill={`oklch(0.7 0.16 ${(c.hue + 240) % 360})`} />
          <circle cx="35.4" cy="52.6" r="1.3" fill={c.glow} />
        </g>
      );
    default:
      return light;
  }
}

/** Pieces worn over the face (scout goggles, reviewer glasses). */
function Eyewear({ role, c }: { role: AgentRole; c: Palette }) {
  if (role === "scout") {
    return (
      <g stroke={c.shade} strokeWidth="2" fill="none">
        <rect x="20.5" y="21" width="11" height="10" rx="4" />
        <rect x="32.5" y="21" width="11" height="10" rx="4" />
      </g>
    );
  }
  if (role === "reviewer") {
    return (
      <g stroke={`oklch(0.93 0.02 ${c.hue})`} strokeWidth="1.3" fill="none" strokeLinecap="round">
        <circle cx="26" cy="26" r="4.8" />
        <circle cx="38" cy="26" r="4.8" />
        <path d="M30.8 25q1.2-1 2.4 0M21.2 25H18.5M42.8 25H45.5" />
      </g>
    );
  }
  return null;
}

function Face({ mood, glow, blink }: { mood: WorkerMood; glow: string; blink: boolean }) {
  const line = { stroke: glow, strokeWidth: 2, strokeLinecap: "round", fill: "none" } as const;
  switch (mood) {
    case "error":
      return (
        <g stroke={glow} strokeWidth="2.2" strokeLinecap="round">
          <path d="M23 23l5 5M28 23l-5 5M36 23l5 5M41 23l-5 5" />
          <path d="M27 33.5h10" />
        </g>
      );
    case "sleeping":
      return (
        <g stroke={glow} strokeWidth="2.2" strokeLinecap="round" opacity="0.7">
          <path d="M23 27h6M35 27h6" />
        </g>
      );
    case "thinking":
      return (
        <g>
          <Eyes blink={blink} glow={glow} cx={[27.2, 39.2]} cy={24.6} r={2.6} />
          <path d="M29 32.5q3 1.2 6 0" {...line} />
        </g>
      );
    case "focused":
      return (
        <g>
          <rect x="23" y="25" width="6" height="2.6" rx="1.3" fill={glow} />
          <rect x="35" y="25" width="6" height="2.6" rx="1.3" fill={glow} />
          <path d="M22.5 22l6.5 1.4M41.5 22l-6.5 1.4" {...line} strokeWidth="1.6" />
          <path d="M29.5 32.5h5" {...line} />
        </g>
      );
    case "stuck":
      return (
        <g>
          <path d="M26 26a1 1 0 0 1 2 0a2 2 0 0 1-4 0a3 3 0 0 1 6 0" {...line} strokeWidth="1.5" />
          <circle cx="38" cy="26" r="1.7" fill={glow} />
          <path d="M28 34l8-2" {...line} />
        </g>
      );
    case "tired":
      return (
        <g>
          <path d="M23 26.2a3 3 0 0 0 6 0ZM35 26.2a3 3 0 0 0 6 0Z" fill={glow} />
          <path d="M22.5 26.4l7-1.2M41.5 26.4l-7-1.2" {...line} strokeWidth="1.6" />
          <path d="M29 33.5q3-1.4 6 0" {...line} opacity="0.8" />
        </g>
      );
    case "overloaded":
      return (
        <g>
          <circle cx="26" cy="26" r="3.7" stroke={glow} strokeWidth="1.6" fill="none" />
          <circle cx="38" cy="26" r="3.7" stroke={glow} strokeWidth="1.6" fill="none" />
          <circle cx="26" cy="26" r="1.4" fill={glow} />
          <circle cx="38" cy="26" r="1.4" fill={glow} />
          <ellipse cx="32" cy="33.2" rx="2.2" ry="1.8" stroke={glow} strokeWidth="1.6" fill="none" />
        </g>
      );
    case "overheated":
      return (
        <g>
          <path d="M22.5 21.6l6 2.2M41.5 21.6l-6 2.2" {...line} strokeWidth="1.8" />
          <Eyes blink={blink} glow={glow} cx={[26, 38]} cy={26.8} r={2.4} />
          <rect x="26.5" y="31" width="11" height="4" rx="1.5" stroke={glow} strokeWidth="1.4" fill="none" />
          <path d="M30.2 31v4M33.8 31v4" stroke={glow} strokeWidth="1.2" />
        </g>
      );
    case "stressed":
      return (
        <g>
          <path d="M23 22.6l5-1M41 22.6l-5-1" {...line} strokeWidth="1.5" />
          <Eyes blink={blink} glow={glow} cx={[26, 38]} cy={26} r={2.7} />
          <path d="M26 33q1.5-1.6 3 0t3 0t3 0t3 0" {...line} strokeWidth="1.6" />
        </g>
      );
    case "energized":
      return (
        <g>
          <path
            d="M26 22L27 25L30 26L27 27L26 30L25 27L22 26L25 25ZM38 22L39 25L42 26L39 27L38 30L37 27L34 26L37 25Z"
            fill={glow}
            stroke={glow}
            strokeWidth="0.6"
            strokeLinejoin="round"
          />
          <path d="M26 31h12q-1 4.6-6 4.6t-6-4.6Z" fill={glow} />
        </g>
      );
    case "needs-help":
      return (
        <g>
          <path d="M22.5 22.2l6-1.6M41.5 22.2l-6-1.6" {...line} strokeWidth="1.6" />
          <Eyes blink={blink} glow={glow} cx={[26, 38]} cy={26.4} r={2.6} />
          <path d="M28 34.5q4-2.6 8 0" {...line} />
        </g>
      );
    default:
      return (
        <g>
          <Eyes blink={blink} glow={glow} cx={[26, 38]} cy={26} r={3} />
          {mood === "happy" ? (
            <path d="M26 31.5q6 4.5 12 0" {...line} />
          ) : mood === "waiting" ? (
            <path d="M28 32.5h8" stroke={glow} strokeWidth="2" strokeLinecap="round" opacity="0.8" />
          ) : (
            <path d="M27 32q5 2.5 10 0" {...line} />
          )}
        </g>
      );
  }
}

function Eyes({
  blink,
  glow,
  cx,
  cy,
  r,
}: {
  blink: boolean;
  glow: string;
  cx: [number, number];
  cy: number;
  r: number;
}) {
  return (
    <g className={cn(blink && "animate-worker-blink")}>
      <circle cx={cx[0]} cy={cy} r={r} fill={glow} />
      <circle cx={cx[1]} cy={cy} r={r} fill={glow} />
    </g>
  );
}

function delay(seconds: number): CSSProperties {
  return { animationDelay: `${seconds}s` };
}

/** Mood marks around the head (thought dots, gear, "?", sweat, steam, "!!", spark, raised hand, snore). */
function Overlay({ mood, c, animated }: { mood: WorkerMood; c: Palette; animated: boolean }) {
  const muted = "text-muted-foreground";
  switch (mood) {
    case "sleeping":
      return (
        <text
          x="50"
          y="12"
          fontSize="11"
          fontWeight="700"
          fill="currentColor"
          className={cn(muted, animated && "animate-worker-snore")}
        >
          z
        </text>
      );
    case "thinking":
      return (
        <g fill="currentColor" className={muted}>
          {[
            [16, 10, 1.2],
            [11.5, 6.4, 1.7],
            [6, 1.6, 2.4],
          ].map(([cx, cy, r], i) => (
            <circle
              key={cx}
              cx={cx}
              cy={cy}
              r={r}
              className={cn(animated && "animate-worker-think")}
              style={animated ? delay(i * 0.25) : undefined}
            />
          ))}
        </g>
      );
    case "focused":
      return (
        <g>
          <g className={cn(animated && "animate-worker-spin")}>
            <circle cx="7" cy="4" r="4" stroke={c.glow} strokeWidth="2.2" strokeDasharray="1.8 1.34" fill="none" />
            <circle cx="7" cy="4" r="2.9" stroke={c.glow} strokeWidth="1.6" fill="none" />
          </g>
          <circle cx="14" cy="10" r="1.1" fill={c.glow} className={cn(animated && "animate-worker-think")} />
        </g>
      );
    case "stuck":
      return (
        <text x="3" y="11" fontSize="13" fontWeight="800" fill="currentColor" className={muted}>
          ?
        </text>
      );
    case "tired":
      return <Drop x={16} y={13} />;
    case "stressed":
      return <Drop x={48} y={13} />;
    case "overloaded":
      return (
        <text x="1" y="11" fontSize="12" fontWeight="800" fill="oklch(0.7 0.19 45)" letterSpacing="-1">
          !!
        </text>
      );
    case "overheated":
      return (
        <g fill="currentColor" className={muted} opacity="0.75">
          {[
            [16, 8, 2.2],
            [9.5, 4.5, 2.8],
            [47.5, 7, 2.2],
          ].map(([cx, cy, r], i) => (
            <circle
              key={cx}
              cx={cx}
              cy={cy}
              r={r}
              className={cn(animated && "animate-worker-steam")}
              style={animated ? delay(i * 0.6) : undefined}
            />
          ))}
        </g>
      );
    case "energized":
      return (
        <path
          d="M10 -3L4 5.5H8.2L6 12L12.5 3H8.4Z"
          fill="oklch(0.86 0.16 95)"
          className={cn(animated && "animate-worker-think")}
        />
      );
    case "needs-help":
      return (
        <g>
          <path d="M44 49L52 40" stroke={c.shade} strokeWidth="3.5" strokeLinecap="round" />
          <circle cx="53.4" cy="37.6" r="2.8" fill={c.paint} />
        </g>
      );
    default:
      return null;
  }
}

/** A sweat drop hanging at (x, y), its tip on top. */
function Drop({ x, y }: { x: number; y: number }) {
  return <path d={`M${x} ${y}q-2.2 3-2.2 4.4a2.2 2.2 0 0 0 4.4 0q0-1.4-2.2-4.4Z`} fill={SWEAT} />;
}
