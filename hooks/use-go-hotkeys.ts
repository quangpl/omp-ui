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
const HINT =
  "G — then P projects, C schedulers, V visualize, D containers, X terminal, F files, A artifacts, T stats, L logs, M memory, K credentials, I MCP servers, S settings";

/**
 * App-wide `G` then `P`/`H`/`C`/`V`/`D`/`X`/`F`/`A`/`T`/`L`/`M`/`K`/`I`/`S` navigation. Listens in the window capture phase so the
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
