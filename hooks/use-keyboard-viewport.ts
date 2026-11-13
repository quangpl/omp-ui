"use client";

import { useEffect, useState } from "react";

export interface KeyboardViewport {
  height: number;
  top: number;
}

/**
 * The visible area while an on-screen keyboard is up, else null. Mobile browsers shrink only the
 * visual viewport for the keyboard (the root viewport has no `interactive-widget=resizes-content`),
 * so an `h-dvh` page would leave its bottom bar (Create, the terminal command line) underneath it.
 */
export function useKeyboardViewport(): KeyboardViewport | null {
  const [box, setBox] = useState<KeyboardViewport | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Pinch zoom shrinks the visual viewport too; at scale 1 only a keyboard does.
      const keyboard = Math.abs(vv.scale - 1) < 0.01 && document.documentElement.clientHeight - vv.height > 120;
      const next = keyboard ? { height: Math.round(vv.height), top: Math.round(vv.offsetTop) } : null;
      setBox((prev) => (prev && next && prev.height === next.height && prev.top === next.top ? prev : next));
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return box;
}
