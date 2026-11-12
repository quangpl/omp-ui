"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { isModalOpen, isTypingTarget } from "@/lib/hotkeys";

/** True at `xl` (≥ 1280px), where the detail panel sits beside the list instead of in a sheet. */
export function useIsWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return wide;
}

interface ListHotkeys {
  enabled: boolean;
  count: number;
  selected: number;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onClose: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

/**
 * Memory page keys: J/K move the selection, Enter opens it, Esc closes the detail, F focuses
 * search. Quiet while typing or while a dialog/sheet is open (Esc in the search field blurs it).
 */
export function useMemoryHotkeys(options: ListHotkeys): void {
  const ref = useRef(options);
  ref.current = options;
  useEffect(() => {
    if (!options.enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const o = ref.current;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape" && event.target === o.searchRef.current) {
        o.searchRef.current?.blur();
        return;
      }
      if (isTypingTarget(event.target) || isModalOpen()) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === "j" || key === "k") {
        if (o.count === 0) return;
        event.preventDefault();
        const step = key === "j" ? 1 : -1;
        const from = o.selected < 0 ? (step > 0 ? -1 : o.count) : o.selected;
        o.onSelect(Math.min(o.count - 1, Math.max(0, from + step)));
      } else if (key === "Enter") {
        if (o.selected < 0 || o.selected >= o.count) return;
        // Let focused buttons and links do their own thing.
        if (event.target instanceof HTMLElement && event.target.closest("button, a")) return;
        event.preventDefault();
        o.onOpen(o.selected);
      } else if (key === "Escape") {
        o.onClose();
      } else if (key === "f" && !event.repeat) {
        event.preventDefault();
        o.searchRef.current?.focus();
        o.searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [options.enabled]);
}
