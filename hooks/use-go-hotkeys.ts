"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useCurrentUser } from "@/hooks/use-current-user";
import { ADMIN_ONLY_HREFS } from "@/lib/dashboard-menus";
import { createKeySequence } from "@/lib/hotkeys";

export interface GoShortcut {
  /** Second key after `G` (lowercase). */
  key: string;
  href: string;
  label: string;
}

/** `G` then … destinations; H is an alias of P (projects home). */
export const GO_SHORTCUTS: readonly GoShortcut[] = [
  { key: "p", href: "/", label: "Projects" },
  { key: "h", href: "/", label: "Projects" },
  { key: "c", href: "/schedulers", label: "Schedulers" },
  { key: "v", href: "/visualize", label: "Visualize" },
  { key: "d", href: "/containers", label: "Containers" },
  { key: "x", href: "/terminal", label: "Terminal" },
  { key: "f", href: "/files", label: "Files" },
  { key: "a", href: "/artifacts", label: "Artifacts" },
  { key: "t", href: "/stats", label: "Stats" },
  { key: "l", href: "/logs", label: "Logs" },
  { key: "m", href: "/memory", label: "Memory" },
  { key: "k", href: "/credentials", label: "Credentials" },
  { key: "i", href: "/mcp", label: "MCP servers" },
  { key: "s", href: "/settings", label: "Settings" },
];

const HINT_TOAST_ID = "go-hotkeys-hint";

/** "G — then P projects, C schedulers, …" for the given shortcuts, aliases left out. */
function hintFor(shortcuts: readonly GoShortcut[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const { key, href, label } of shortcuts) {
    if (seen.has(href)) continue;
    seen.add(href);
    // Lowercase the leading word unless it is an acronym ("MCP servers").
    parts.push(`${key.toUpperCase()} ${label.replace(/^[A-Z][a-z]/, (start) => start.toLowerCase())}`);
  }
  return `G — then ${parts.join(", ")}`;
}

/**
 * App-wide `G` then `P`/`H`/`C`/`V`/`D`/`X`/`F`/`A`/`T`/`L`/`M`/`K`/`I`/`S` navigation. Listens in the window capture phase so the
 * consumed second key never reaches single-key board hotkeys; a small toast shows the options
 * while the sequence waits for its second key. Admin-only pages (`D`, `X`, `L`, `M`) are bound for admins only.
 */
export function useGoHotkeys(enabled = true): void {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const { isAdmin } = useCurrentUser();

  useEffect(() => {
    if (!enabled) return;
    const shortcuts = isAdmin ? GO_SHORTCUTS : GO_SHORTCUTS.filter(({ href }) => !ADMIN_ONLY_HREFS.includes(href));
    const hint = hintFor(shortcuts);
    const bindings: Record<string, () => void> = {};
    for (const { key, href } of shortcuts) bindings[key] = () => routerRef.current.push(href);
    const sequence = createKeySequence({
      leader: "g",
      bindings,
      onPending: () => toast(hint, { id: HINT_TOAST_ID, duration: Number.POSITIVE_INFINITY }),
      onEnd: () => toast.dismiss(HINT_TOAST_ID),
    });
    window.addEventListener("keydown", sequence.handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", sequence.handleKeyDown, true);
      sequence.cancel();
    };
  }, [enabled, isAdmin]);
}
