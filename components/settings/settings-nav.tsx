"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  /** Anchor id of the section (`<section id>`). */
  id: string;
  label: string;
  icon: React.ReactNode;
}

/**
 * A section counts as current once its top passes its own `scroll-margin-top` (where a nav jump
 * parks it, i.e. just below the sticky chrome) plus this slack, in px.
 */
const SPY_SLACK = 16;

/**
 * A nav jump counts as finished once no scroll event arrived for this long, in ms. Browsers scale a
 * smooth scroll's duration with its distance (Chrome takes over a second across the whole page),
 * so a fixed lock would expire mid-flight and the highlight would flicker through every section
 * passed on the way.
 */
const JUMP_SETTLE_MS = 150;

/** Keys that scroll the page, ending a nav jump in flight. */
const SCROLL_KEYS: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  PageUp: true,
  PageDown: true,
  Home: true,
  End: true,
  " ": true,
};

/**
 * Id of the section currently at the top of the viewport; the last one once scrolled to the end.
 * A nav click holds its section until the user scrolls again: sections near the end can't reach
 * the top, and the end-of-page rule would otherwise hand the highlight to the last one.
 */
function useScrollSpy(ids: string[]): [string, (id: string) => void] {
  const [active, setActive] = useState(ids[0] ?? "");
  /** True from a nav click until its scroll settles; the spy then leaves the clicked section be. */
  const jumping = useRef(false);
  const settleTimer = useRef(0);

  const armSettle = useCallback(() => {
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      jumping.current = false;
    }, JUMP_SETTLE_MS);
  }, []);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const root = document.scrollingElement ?? document.documentElement;
      const scrollable = root.scrollHeight > window.innerHeight + 4;
      if (scrollable && root.scrollHeight - root.scrollTop - window.innerHeight < 4) {
        setActive(ids[ids.length - 1] ?? "");
        return;
      }
      let current = ids[0] ?? "";
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const line = (parseFloat(getComputedStyle(el).scrollMarginTop) || 0) + SPY_SLACK;
        if (el.getBoundingClientRect().top - line <= 0) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (jumping.current) armSettle();
      else if (!frame) frame = requestAnimationFrame(update);
    };
    // Wheel, touch or scroll keys cancel a smooth scroll in flight: the user is steering again.
    const onUserScroll = (e: Event) => {
      if (!jumping.current || (e instanceof KeyboardEvent && !SCROLL_KEYS[e.key])) return;
      jumping.current = false;
      window.clearTimeout(settleTimer.current);
    };
    update();
    // Capture: scroll events don't bubble, and the scrolling element may be an inner container.
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    window.addEventListener("wheel", onUserScroll, { passive: true });
    window.addEventListener("touchstart", onUserScroll, { passive: true });
    window.addEventListener("keydown", onUserScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer.current);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("wheel", onUserScroll);
      window.removeEventListener("touchstart", onUserScroll);
      window.removeEventListener("keydown", onUserScroll);
    };
  }, [ids, armSettle]);

  const jumpTo = useCallback(
    (id: string) => {
      const el = document.getElementById(id);
      if (!el) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      jumping.current = true;
      // Also ends the jump when the section is already in place and no scroll event follows.
      armSettle();
      setActive(id);
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      history.replaceState(null, "", `#${id}`);
    },
    [armSettle],
  );

  return [active, jumpTo];
}

/**
 * Section navigation for the settings page: a sticky vertical list beside the content on large
 * screens; below that a sticky swipeable chip strip pinned under the header (and its metrics strip).
 * Both highlight the section in view.
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
      {/* Phones and tablets: swipeable chip strip pinned under the app header and its metrics strip. */}
      <nav
        aria-label="Settings sections"
        className="glass-edge sticky top-[calc(5.5rem+2px+env(safe-area-inset-top))] z-30 -mx-4 -mt-6 border-b bg-background/85 backdrop-blur-lg supports-backdrop-filter:bg-background/70 sm:-mx-6 md:-mt-8 lg:hidden"
      >
        <div ref={chipRow} className="scroll-row flex gap-2 px-4 py-2.5 sm:px-6">
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
                  "inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium whitespace-nowrap ring-1 transition-[background-color,color,box-shadow,scale] duration-150 ease-(--ease-fluid) active:scale-[0.96] motion-reduce:transition-none [&_svg]:size-4",
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
                    "relative flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-[background-color,color,scale] duration-150 ease-(--ease-fluid) active:scale-[0.98] motion-reduce:transition-none [&_svg]:size-4 [&_svg]:shrink-0",
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
