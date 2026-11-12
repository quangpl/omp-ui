"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
  { key: "v", href: "/visualize", label: "Visualize" },
  { key: "d", href: "/containers", label: "Containers" },
  { key: "t", href: "/stats", label: "Stats" },
  { key: "m", href: "/memory", label: "Memory" },
  { key: "s", href: "/settings", label: "Settings" },
];

const HINT_TOAST_ID = "go-hotkeys-hint";
const HINT = "G — then P projects, V visualize, D containers, T stats, M memory, S settings";

/**
 * App-wide `G` then `P`/`H`/`V`/`D`/`T`/`M`/`S` navigation. Listens in the window capture phase so the
 * consumed second key never reaches single-key board hotkeys; a small toast shows the options
 * while the sequence waits for its second key.
 */
export function useGoHotkeys(enabled = true): void {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (!enabled) return;
    const bindings: Record<string, () => void> = {};
    for (const { key, href } of GO_SHORTCUTS) bindings[key] = () => routerRef.current.push(href);
    const sequence = createKeySequence({
      leader: "g",
      bindings,
      onPending: () => toast(HINT, { id: HINT_TOAST_ID, duration: Number.POSITIVE_INFINITY }),
      onEnd: () => toast.dismiss(HINT_TOAST_ID),
    });
    window.addEventListener("keydown", sequence.handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", sequence.handleKeyDown, true);
      sequence.cancel();
    };
  }, [enabled]);
}
