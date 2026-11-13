import { describe, expect, it } from "vitest";

import { DEFAULT_PRIMARY_COLOR, PRIMARY_COLOR_IDS, PRIMARY_COLORS } from "@/lib/primary-colors";

/** WCAG 2 relative luminance of an `oklch(L C H)` string (OKLab → linear sRGB, clamped to gamut). */
function luminance(color: string): number {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(color);
  if (!match) throw new Error(`unparseable color: ${color}`);
  const [l, c, h] = match.slice(1).map(Number);
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(x: string, y: string): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

describe("PRIMARY_COLORS", () => {
  it("lists every id in order and keeps the jade default unchanged", () => {
    expect(PRIMARY_COLORS.map((p) => p.id)).toEqual([...PRIMARY_COLOR_IDS]);
    expect(DEFAULT_PRIMARY_COLOR).toBe("jade");
    expect(PRIMARY_COLORS[0]).toEqual({
      id: "jade",
      label: "Jade",
      light: {
        primary: "oklch(0.55 0.13 168)",
        primaryForeground: "oklch(0.985 0.01 168)",
        ring: "oklch(0.62 0.11 168)",
        accent: "oklch(0.955 0.01 168)",
      },
      dark: {
        primary: "oklch(0.74 0.12 168)",
        primaryForeground: "oklch(0.2 0.04 168)",
        ring: "oklch(0.62 0.1 168)",
        accent: "oklch(0.27 0.018 168)",
      },
    });
  });

  // Jade light (~4.26) is the legacy default, kept byte-identical by request; it gets a 4.2 floor.
  it.each(PRIMARY_COLORS.flatMap((p) => (["light", "dark"] as const).map((mode) => [p.id, mode, p[mode]] as const)))(
    "%s (%s) keeps primary text readable (WCAG contrast floor)",
    (id, mode, tokens) => {
      const floor = id === "jade" && mode === "light" ? 4.2 : 4.5;
      expect(contrast(tokens.primary, tokens.primaryForeground)).toBeGreaterThanOrEqual(floor);
    },
  );
});
