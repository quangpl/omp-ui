"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  /** Anchor id of the section (`<section id>`). */
  id: string;
  label: string;
  icon: React.ReactNode;
}

/** A section counts as current once its top passes this line (px below the viewport top). */
const SPY_OFFSET = 140;

/** Id of the section currently at the top of the viewport; the last one once scrolled to the end. */
function useScrollSpy(ids: string[]): [string, (id: string) => void] {
  const [active, setActive] = useState(ids[0] ?? "");
  /** While a nav click scrolls smoothly, intermediate sections must not steal the highlight. */
  const lockUntil = useRef(0);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      if (Date.now() < lockUntil.current) return;
      const root = document.scrollingElement ?? document.documentElement;
      const scrollable = root.scrollHeight > window.innerHeight + 4;
      if (scrollable && root.scrollHeight - root.scrollTop - window.innerHeight < 4) {
        setActive(ids[ids.length - 1] ?? "");
        return;
      }
      let current = ids[0] ?? "";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top - SPY_OFFSET <= 0) current = id;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    // Capture: scroll events don't bubble, and the scrolling element may be an inner container.
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [ids]);

  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    lockUntil.current = Date.now() + (reduce ? 0 : 700);
    setActive(id);
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
  }, []);

  return [active, jumpTo];
}

/**
 * Section navigation for the settings page: a sticky vertical list beside the content on large
 * screens, a sticky horizontally scrolling chip row under the header below that. Both highlight
 * the section in view.
 */
export function SettingsNav({ items }: { items: SettingsNavItem[] }) {
  const [ids] = useState(() => items.map((item) => item.id));
  const [active, jumpTo] = useScrollSpy(ids);
  const chipRow = useRef<HTMLDivElement>(null);

  // Keep the active chip visible in the horizontal row without scrolling the page vertically.
  useEffect(() => {
    const row = chipRow.current;
    const chip = row?.querySelector<HTMLElement>(`[data-section="${active}"]`);
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
    const left = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollTo({ left: Math.max(0, left), behavior: reduce ? "auto" : "smooth" });
  }, [active]);

  function onClick(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    jumpTo(id);
  }

  return (
    <>
      {/* Phones and tablets: chip row pinned under the app header. */}
      <nav
        aria-label="Settings sections"
        className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-30 -mx-4 -mt-6 border-b bg-background/85 backdrop-blur-lg supports-backdrop-filter:bg-background/70 sm:-mx-6 md:-mt-8 lg:hidden"
      >
        <div
          ref={chipRow}
          className="flex gap-2 overflow-x-auto px-4 py-2.5 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item) => {
            const current = item.id === active;
            return (
              <a
                key={item.id}
                href={`#${item.id}`}
                data-section={item.id}
                aria-current={current ? "location" : undefined}
                onClick={(e) => onClick(e, item.id)}
                className={cn(
                  "inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium whitespace-nowrap ring-1 transition-[background-color,color,transform] active:scale-[0.98] md:h-9 [&_svg]:size-4",
                  current
                    ? "bg-primary/10 text-primary ring-primary/30"
                    : "text-muted-foreground ring-border hover:text-foreground",
                )}
              >
                {item.icon}
                {item.label}
              </a>
            );
          })}
        </div>
      </nav>

      {/* Large screens: vertical list beside the content. */}
      <nav
        aria-label="Settings sections"
        className="sticky top-[calc(3.5rem+env(safe-area-inset-top)+2rem)] hidden self-start lg:block"
      >
        <p className="px-3 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          On this page
        </p>
        <ul className="space-y-0.5">
          {items.map((item) => {
            const current = item.id === active;
            return (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  aria-current={current ? "location" : undefined}
                  onClick={(e) => onClick(e, item.id)}
                  className={cn(
                    "relative flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-[background-color,color,transform] active:scale-[0.98] [&_svg]:size-4 [&_svg]:shrink-0",
                    "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:transition-colors",
                    current
                      ? "bg-muted font-medium text-foreground before:bg-primary"
                      : "text-muted-foreground before:bg-transparent hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
