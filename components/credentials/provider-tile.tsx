import { KeyRoundIcon } from "lucide-react";
import type { CredentialProvider } from "@/lib/credential-types";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-8 rounded-lg text-[0.7rem] [&_svg]:size-4",
  md: "size-10 rounded-xl text-sm [&_svg]:size-5",
} as const;

/**
 * Text color for a brand background. Most brand colors carry white text; a few are light
 * (Supabase green, Firecrawl orange…), where white would be unreadable, so those get near-black.
 */
function monogramColor(background: string): string {
  const hex = background.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return "#fff";
  const channel = (offset: number) => {
    const c = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  const onWhite = 1.05 / (luminance + 0.05);
  const onDark = (luminance + 0.05) / 0.0556; // #111
  // Brand look first: white whenever it is readable for bold small text (≥ 3:1).
  return onWhite >= 3 || onWhite >= onDark ? "#fff" : "#111";
}

/** Provider "logo": its monogram on the brand color (lucide has no brand icons). */
export function ProviderTile({
  provider,
  size = "md",
  className,
}: {
  /** Anything with a monogram and brand color (credential or AI provider). */
  provider: Pick<CredentialProvider, "monogram" | "brandColor"> | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const base = cn(
    "flex shrink-0 items-center justify-center font-semibold tracking-tight select-none ring-1 ring-inset ring-foreground/10",
    SIZES[size],
    className,
  );
  if (!provider) {
    return (
      <span className={cn(base, "bg-muted text-muted-foreground")} aria-hidden="true">
        <KeyRoundIcon />
      </span>
    );
  }
  return (
    <span
      className={base}
      style={{ backgroundColor: provider.brandColor, color: monogramColor(provider.brandColor) }}
      aria-hidden="true"
    >
      {provider.monogram}
    </span>
  );
}
