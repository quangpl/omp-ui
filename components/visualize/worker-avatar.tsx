import { cn } from "@/lib/utils";

/** How the worker looks: busy at the desk, in line, done, broken down, or asleep on the job. */
export type WorkerMood = "working" | "waiting" | "happy" | "error" | "sleeping";

/**
 * A little robot worker. Colour comes from `hue` (see workerIdentity) so every card has its own
 * worker; the face follows `mood`. Animations are CSS utilities from globals.css, all disabled by
 * prefers-reduced-motion.
 */
export function WorkerAvatar({
  hue,
  mood,
  className,
  animated = true,
}: {
  hue: number;
  mood: WorkerMood;
  className?: string;
  animated?: boolean;
}) {
  const paint = `oklch(0.7 0.13 ${hue})`;
  const shade = `oklch(0.56 0.12 ${hue})`;
  const glow =
    mood === "error" ? "oklch(0.7 0.2 25)" : mood === "happy" ? "oklch(0.82 0.16 158)" : "oklch(0.86 0.13 200)";
  const active = animated && mood === "working";
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      className={cn("shrink-0 overflow-visible", active && "animate-worker-bob", className)}
    >
      {/* antenna */}
      <line x1="32" y1="6" x2="32" y2="13" stroke={shade} strokeWidth="2.5" strokeLinecap="round" />
      <circle
        cx="32"
        cy="5"
        r="3.2"
        fill={mood === "sleeping" || mood === "waiting" ? shade : glow}
        className={cn(active && "animate-worker-signal")}
      />
      {/* ears */}
      <rect x="9" y="22" width="6" height="10" rx="2.5" fill={shade} />
      <rect x="49" y="22" width="6" height="10" rx="2.5" fill={shade} />
      {/* head + visor */}
      <rect x="13" y="12" width="38" height="30" rx="10" fill={paint} />
      <rect x="18" y="18" width="28" height="18" rx="6" fill="oklch(0.22 0.03 270)" />
      <Face mood={mood} glow={glow} blink={animated && mood !== "sleeping" && mood !== "error"} />
      {/* body */}
      <rect x="19" y="44" width="26" height="16" rx="6" fill={shade} />
      <rect x="27" y="48" width="10" height="5" rx="2" fill={glow} opacity={mood === "sleeping" ? 0.35 : 0.85} />
      {mood === "sleeping" && (
        <text
          x="50"
          y="12"
          fontSize="11"
          fontWeight="700"
          fill="currentColor"
          className={cn("text-muted-foreground", animated && "animate-worker-snore")}
        >
          z
        </text>
      )}
    </svg>
  );
}

function Face({ mood, glow, blink }: { mood: WorkerMood; glow: string; blink: boolean }) {
  if (mood === "error") {
    return (
      <g stroke={glow} strokeWidth="2.2" strokeLinecap="round">
        <path d="M23 23l5 5M28 23l-5 5M36 23l5 5M41 23l-5 5" />
        <path d="M27 33.5h10" />
      </g>
    );
  }
  if (mood === "sleeping") {
    return (
      <g stroke={glow} strokeWidth="2.2" strokeLinecap="round" opacity="0.7">
        <path d="M23 27h6M35 27h6" />
      </g>
    );
  }
  return (
    <g>
      <g className={cn(blink && "animate-worker-blink")}>
        <circle cx="26" cy="26" r="3" fill={glow} />
        <circle cx="38" cy="26" r="3" fill={glow} />
      </g>
      {mood === "happy" ? (
        <path d="M26 31.5q6 4.5 12 0" stroke={glow} strokeWidth="2" strokeLinecap="round" fill="none" />
      ) : mood === "waiting" ? (
        <path d="M28 32.5h8" stroke={glow} strokeWidth="2" strokeLinecap="round" opacity="0.8" />
      ) : (
        <path d="M27 32q5 2.5 10 0" stroke={glow} strokeWidth="2" strokeLinecap="round" fill="none" />
      )}
    </g>
  );
}
