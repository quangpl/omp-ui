/**
 * User-selectable primary color presets (Settings → Appearance). Pure data + CSS string, safe on server
 * and client. Values follow the Tailwind v4 palette (oklch): light primary ≈ 600/700 shade, dark ≈ 400.
 * `jade` is the default and mirrors the `:root` / `.dark` tokens in app/globals.css (keep in sync).
 */

export const PRIMARY_COLOR_IDS = [
  "jade",
  "blue",
  "indigo",
  "violet",
  "purple",
  "pink",
  "rose",
  "red",
  "orange",
  "amber",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "slate",
] as const;

export type PrimaryColorId = (typeof PRIMARY_COLOR_IDS)[number];

export const DEFAULT_PRIMARY_COLOR: PrimaryColorId = "jade";

/** Attribute carrying the preset id: on <html> globally, or on any element for a scoped preview. */
export const PRIMARY_COLOR_ATTRIBUTE = "data-primary";

export function isPrimaryColorId(value: unknown): value is PrimaryColorId {
  return typeof value === "string" && (PRIMARY_COLOR_IDS as readonly string[]).includes(value);
}

/** CSS color strings (oklch). primary/primaryForeground keep WCAG contrast >= 4.5 (jade light: legacy ~4.26). */
export interface PrimaryColorTokens {
  primary: string;
  primaryForeground: string;
  ring: string;
  accent: string;
}

export interface PrimaryColorPreset {
  id: PrimaryColorId;
  label: string;
  light: PrimaryColorTokens;
  dark: PrimaryColorTokens;
}

const tokens = (primary: string, primaryForeground: string, ring: string, accent: string): PrimaryColorTokens => ({
  primary,
  primaryForeground,
  ring,
  accent,
});

export const PRIMARY_COLORS: readonly PrimaryColorPreset[] = [
  {
    id: "jade",
    label: "Jade",
    light: tokens("oklch(0.55 0.13 168)", "oklch(0.985 0.01 168)", "oklch(0.62 0.11 168)", "oklch(0.955 0.01 168)"),
    dark: tokens("oklch(0.74 0.12 168)", "oklch(0.2 0.04 168)", "oklch(0.62 0.1 168)", "oklch(0.27 0.018 168)"),
  },
  {
    id: "blue",
    label: "Blue",
    light: tokens("oklch(0.546 0.245 262.881)", "oklch(0.985 0.01 262)", "oklch(0.623 0.214 259.815)", "oklch(0.955 0.014 262)"),
    dark: tokens("oklch(0.707 0.165 254.624)", "oklch(0.282 0.091 267.935)", "oklch(0.623 0.214 259.815)", "oklch(0.27 0.02 262)"),
  },
  {
    id: "indigo",
    label: "Indigo",
    light: tokens("oklch(0.511 0.262 276.966)", "oklch(0.985 0.01 277)", "oklch(0.585 0.233 277.117)", "oklch(0.955 0.014 277)"),
    dark: tokens("oklch(0.673 0.182 276.935)", "oklch(0.257 0.09 281.288)", "oklch(0.585 0.233 277.117)", "oklch(0.27 0.02 277)"),
  },
  {
    id: "violet",
    label: "Violet",
    light: tokens("oklch(0.541 0.281 293.009)", "oklch(0.985 0.01 293)", "oklch(0.606 0.25 292.717)", "oklch(0.955 0.014 293)"),
    dark: tokens("oklch(0.702 0.183 293.541)", "oklch(0.283 0.141 291.089)", "oklch(0.606 0.25 292.717)", "oklch(0.27 0.02 293)"),
  },
  {
    id: "purple",
    label: "Purple",
    light: tokens("oklch(0.558 0.288 302.321)", "oklch(0.985 0.01 303)", "oklch(0.627 0.265 303.9)", "oklch(0.955 0.014 303)"),
    dark: tokens("oklch(0.714 0.203 305.504)", "oklch(0.291 0.149 302.717)", "oklch(0.627 0.265 303.9)", "oklch(0.27 0.02 303)"),
  },
  {
    id: "pink",
    label: "Pink",
    light: tokens("oklch(0.525 0.223 3.958)", "oklch(0.985 0.01 354)", "oklch(0.656 0.241 354.308)", "oklch(0.955 0.014 354)"),
    dark: tokens("oklch(0.718 0.202 349.761)", "oklch(0.284 0.109 3.907)", "oklch(0.656 0.241 354.308)", "oklch(0.27 0.02 354)"),
  },
  {
    id: "rose",
    label: "Rose",
    light: tokens("oklch(0.514 0.222 16.935)", "oklch(0.985 0.01 16)", "oklch(0.645 0.246 16.439)", "oklch(0.955 0.014 16)"),
    dark: tokens("oklch(0.712 0.194 13.428)", "oklch(0.271 0.105 12.094)", "oklch(0.645 0.246 16.439)", "oklch(0.27 0.02 16)"),
  },
  {
    id: "red",
    label: "Red",
    light: tokens("oklch(0.505 0.213 27.518)", "oklch(0.985 0.01 25)", "oklch(0.637 0.237 25.331)", "oklch(0.955 0.014 25)"),
    dark: tokens("oklch(0.704 0.191 22.216)", "oklch(0.258 0.092 26.042)", "oklch(0.637 0.237 25.331)", "oklch(0.27 0.02 25)"),
  },
  {
    id: "orange",
    label: "Orange",
    light: tokens("oklch(0.553 0.195 38.402)", "oklch(0.985 0.01 48)", "oklch(0.705 0.213 47.604)", "oklch(0.955 0.014 48)"),
    dark: tokens("oklch(0.75 0.183 55.934)", "oklch(0.266 0.079 36.259)", "oklch(0.705 0.213 47.604)", "oklch(0.27 0.02 48)"),
  },
  {
    id: "amber",
    label: "Amber",
    light: tokens("oklch(0.555 0.163 48.998)", "oklch(0.985 0.01 70)", "oklch(0.769 0.188 70.08)", "oklch(0.955 0.018 70)"),
    dark: tokens("oklch(0.828 0.189 84.429)", "oklch(0.279 0.077 45.635)", "oklch(0.769 0.188 70.08)", "oklch(0.27 0.02 70)"),
  },
  {
    id: "green",
    label: "Green",
    light: tokens("oklch(0.527 0.154 150.069)", "oklch(0.985 0.01 150)", "oklch(0.627 0.194 149.214)", "oklch(0.955 0.014 150)"),
    dark: tokens("oklch(0.792 0.209 151.711)", "oklch(0.266 0.065 152.934)", "oklch(0.723 0.219 149.579)", "oklch(0.27 0.02 150)"),
  },
  {
    id: "emerald",
    label: "Emerald",
    light: tokens("oklch(0.508 0.118 165.612)", "oklch(0.985 0.01 163)", "oklch(0.596 0.145 163.225)", "oklch(0.955 0.014 163)"),
    dark: tokens("oklch(0.765 0.177 163.223)", "oklch(0.262 0.051 172.552)", "oklch(0.696 0.17 162.48)", "oklch(0.27 0.02 163)"),
  },
  {
    id: "teal",
    label: "Teal",
    light: tokens("oklch(0.511 0.096 186.391)", "oklch(0.985 0.01 183)", "oklch(0.6 0.118 184.704)", "oklch(0.955 0.014 183)"),
    dark: tokens("oklch(0.777 0.152 181.912)", "oklch(0.277 0.046 192.524)", "oklch(0.704 0.14 182.503)", "oklch(0.27 0.02 183)"),
  },
  {
    id: "cyan",
    label: "Cyan",
    light: tokens("oklch(0.52 0.105 223.128)", "oklch(0.985 0.01 215)", "oklch(0.609 0.126 221.723)", "oklch(0.955 0.014 215)"),
    dark: tokens("oklch(0.789 0.154 211.53)", "oklch(0.302 0.056 229.695)", "oklch(0.715 0.143 215.221)", "oklch(0.27 0.02 215)"),
  },
  {
    id: "sky",
    label: "Sky",
    light: tokens("oklch(0.5 0.134 242.749)", "oklch(0.985 0.01 237)", "oklch(0.588 0.158 241.966)", "oklch(0.955 0.014 237)"),
    dark: tokens("oklch(0.746 0.16 232.661)", "oklch(0.293 0.066 243.157)", "oklch(0.685 0.169 237.323)", "oklch(0.27 0.02 237)"),
  },
  {
    id: "slate",
    label: "Slate",
    light: tokens("oklch(0.279 0.041 260.031)", "oklch(0.984 0.003 247.858)", "oklch(0.554 0.046 257.417)", "oklch(0.955 0.007 257)"),
    dark: tokens("oklch(0.929 0.013 255.508)", "oklch(0.208 0.042 265.755)", "oklch(0.554 0.046 257.417)", "oklch(0.27 0.012 257)"),
  },
];

const declarations = (t: PrimaryColorTokens) =>
  `--primary: ${t.primary}; --primary-foreground: ${t.primaryForeground}; --ring: ${t.ring}; --accent: ${t.accent};`;

/**
 * Stylesheet for every preset. `html[…]` / `html.dark[…]` out-rank `:root` / `.dark` regardless of source
 * order; the descendant forms let any element carrying the attribute preview a preset in place.
 */
export const PRIMARY_COLOR_CSS: string = PRIMARY_COLORS.map(({ id, light, dark }) => {
  const sel = `[${PRIMARY_COLOR_ATTRIBUTE}="${id}"]`;
  return (
    `html${sel}, html ${sel} { ${declarations(light)} }\n` +
    `html.dark${sel}, html.dark ${sel} { ${declarations(dark)} }`
  );
}).join("\n");
