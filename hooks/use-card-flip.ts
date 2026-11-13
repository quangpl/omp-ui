"use client";

import { useLayoutEffect, useState } from "react";
import { TASK_STATUSES } from "@/lib/types";
import type { TasksByStatus } from "@/hooks/use-board";

/**
 * Card motion for the board: when cards change column or order (an action, a drag in another
 * tab, an SSE update), they glide from where they were to where they are now instead of jumping.
 *
 * FLIP with the Web Animations API: the old rects are read during the render that brings the new
 * order (the DOM still shows the old one), the new rects after commit in a layout effect, and each
 * card that moved plays `translate(old - new) → none` before the browser paints the jump.
 *
 * Column changes can't do that in place: every column list is its own scroller and would clip the
 * card on its way over. Those fly a ghost instead (a copy of the card in a fixed overlay on
 * `<body>`), crossfading from the old look to the new one while the real card waits invisibly in
 * its new slot. A card that lands out of view (scrolled away, another phone page) stays invisible
 * there and glides in once it scrolls into view.
 *
 * Only the layout key (ids per column, in order) drives this: activity lines and other per-card
 * updates arrive many times per second and never measure anything.
 */

/** Same curve as `--ease-out-smooth` in globals.css. */
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
/** In-column slides and the glide-in of a card that arrived out of view. */
const SLIDE_MS = 320;
/** Column-to-column flights travel further; a touch longer reads as the same speed. */
const FLIGHT_MS = 380;
/** Moves up to this many px are layout jitter, not worth animating. */
const MIN_DELTA = 1;
/** A rect counts as on screen once this many px of it show in both directions. */
const MIN_VISIBLE = 8;
/** How far a card that arrived out of view glides in from, once it's scrolled into view. */
const ARRIVAL_OFFSET = 32;
/** Share of the card that has to show before an out-of-view arrival glides in. */
const ARRIVAL_THRESHOLD = 0.2;
const REST_SHADOW = "0 0 0 0 transparent, 0 0 0 0 transparent";
const LIFT_SHADOW = "0 14px 30px -12px oklch(0.25 0.03 272 / 0.35), 0 2px 6px oklch(0.25 0.03 272 / 0.12)";
/** Ghost layer: above the columns and the phone FAB (z-30), below dialogs, sheets and toasts (z-50+). */
const GHOST_LAYER_Z = "40";
/** globals.css freezes animations/transitions and input inside the ghost layer. */
const GHOST_LAYER_CLASS = "card-flip-ghosts";

export interface CardFlip {
  /** Ref callback for a card's animated layer; stable per id, so React never re-attaches it. */
  register: (id: string) => (node: HTMLElement | null) => void;
  /** Whether the card was on the board at the last committed layout (moved, not newly created). */
  wasOnBoard: (id: string) => boolean;
}

/** Layout key for {@link useCardFlip}: card ids per column in board order. */
export function cardLayoutKey(columns: TasksByStatus): string {
  return TASK_STATUSES.map((status) => columns[status].map((task) => task.id).join(",")).join("|");
}

/**
 * FLIP animations for one board's cards. `layoutKey` is groups (columns) joined by `|` of ids
 * joined by `,` (see {@link cardLayoutKey}); `disabled` while something else moves the cards
 * (a dnd-kit drag), and for the commit right after it, so its drop animation isn't doubled.
 */
export function useCardFlip(layoutKey: string, { disabled }: { disabled: boolean }): CardFlip {
  const [engine] = useState(createFlipEngine);
  // Old rects have to be read before React commits the new order; the engine only measures when
  // the key differs from the committed one, once per pending layout (StrictMode re-renders reuse it).
  engine.prepare(layoutKey, disabled);
  useLayoutEffect(() => engine.commit(layoutKey, disabled), [engine, layoutKey, disabled]);
  useLayoutEffect(() => () => engine.dispose(), [engine]);
  return engine.api;
}

interface SnapItem {
  /** Visual rect before the change (mid-animation position included). */
  rect: DOMRect;
  /** Changes column (or is already flying as a ghost): moves through the overlay. */
  crossing: boolean;
  /** Crossing only: the card was actually visible where it was. */
  visible: boolean;
  /** Crossing and visible: a copy of the card as it looked before the change. */
  face: HTMLElement | null;
}

interface Snapshot {
  fromKey: string;
  toKey: string;
  items: Map<string, SnapItem>;
}

interface Ghost {
  node: HTMLElement;
  /** What the card looks like at the end of the flight; the source for an interrupted flight. */
  face: HTMLElement;
  landsVisible: boolean;
  flight: Animation;
  extras: Animation[];
  /** Keeps the real card invisible under a ghost that lands on it. */
  hide: Animation | null;
}

interface Arrival {
  el: HTMLElement;
  hide: Animation;
  dx: number;
  dy: number;
}

interface Plan {
  id: string;
  el: HTMLElement;
  from: SnapItem;
  to: DOMRect;
  /** Crossing only: the card's corner radius, for the ghost's clip. */
  radius: string;
  /** Crossing and visible where it landed: a copy of the card as it looks now. */
  face: HTMLElement | null;
}

/** Only called on the client: the engine measures nothing before its first commit. */
function motionAllowed(): boolean {
  return !document.hidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function groupsOf(key: string): Map<string, number> {
  const groups = new Map<string, number>();
  key.split("|").forEach((group, index) => {
    if (group) for (const id of group.split(",")) groups.set(id, index);
  });
  return groups;
}

function onScreen(rect: DOMRect | DOMRectReadOnly): boolean {
  return (
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0) >= MIN_VISIBLE &&
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0) >= MIN_VISIBLE
  );
}

/** Whether enough of `rect` (el's border box) shows through the viewport and every clipping ancestor. */
function visibleIn(el: HTMLElement, rect: DOMRect): boolean {
  let left = Math.max(rect.left, 0);
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = node.getBoundingClientRect();
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
    if (right - left < MIN_VISIBLE || bottom - top < MIN_VISIBLE) return false;
  }
  return right - left >= MIN_VISIBLE && bottom - top >= MIN_VISIBLE;
}

/**
 * Where a ghost starts or ends when that end of its path is out of view: toward it, but no further
 * than most of a screen, so a far-off destination doesn't turn the flight into a streak.
 */
function toward(anchor: DOMRect, target: DOMRect): { left: number; top: number } {
  const dx = target.left - anchor.left;
  const dy = target.top - anchor.top;
  const max = Math.max(window.innerWidth, window.innerHeight) * 0.6;
  const k = Math.min(1, max / (Math.hypot(dx, dy) || 1));
  return { left: anchor.left + dx * k, top: anchor.top + dy * k };
}

/** A copy of a card for the ghost layer: no duplicate ids, pinned to the card's own size. */
function makeFace(source: HTMLElement): HTMLElement {
  const face = source.cloneNode(true) as HTMLElement;
  face.removeAttribute("id");
  for (const node of face.querySelectorAll("[id]")) node.removeAttribute("id");
  return face;
}

function placeFace(face: HTMLElement, rect: DOMRect) {
  Object.assign(face.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0px",
  });
}

/** Holds a card invisible (above its CSS entry animation, which also animates opacity). */
function hideCard(el: HTMLElement, duration: number): Animation {
  return el.animate([{ opacity: 0 }, { opacity: 0 }], { duration, fill: "forwards" });
}

function createFlipEngine() {
  const elements = new Map<string, HTMLElement>();
  const refs = new Map<string, (node: HTMLElement | null) => void>();
  /** In-column slides and glide-ins, cancelled before every new measurement. */
  const slides = new Map<string, Animation>();
  const ghosts = new Map<string, Ghost>();
  const arrivals = new Map<string, Arrival>();
  let committedKey: string | null = null;
  let committedGroups = new Map<string, number>();
  let committedDisabled = false;
  let pending: Snapshot | null = null;
  let layer: HTMLElement | null = null;
  let observer: IntersectionObserver | null = null;

  const ghostLayer = () => {
    if (layer?.isConnected) return layer;
    layer = document.createElement("div");
    layer.className = GHOST_LAYER_CLASS;
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("inert", "");
    Object.assign(layer.style, {
      position: "fixed",
      inset: "0px",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: GHOST_LAYER_Z,
    });
    document.body.appendChild(layer);
    return layer;
  };

  const dropGhost = (id: string, ghost: Ghost) => {
    if (ghosts.get(id) === ghost) ghosts.delete(id);
    ghost.flight.cancel();
    for (const animation of ghost.extras) animation.cancel();
    ghost.hide?.cancel();
    ghost.node.remove();
    if (layer && ghosts.size === 0) {
      layer.remove();
      layer = null;
    }
  };

  const dropArrival = (id: string) => {
    const arrival = arrivals.get(id);
    if (!arrival) return;
    arrivals.delete(id);
    observer?.unobserve(arrival.el);
    arrival.hide.cancel();
  };

  /** Ends every animation now (cards jump to their real place); arrivals too when `all`. */
  const settle = (all: boolean) => {
    for (const animation of slides.values()) animation.cancel();
    slides.clear();
    for (const [id, ghost] of ghosts) dropGhost(id, ghost);
    if (all) for (const id of [...arrivals.keys()]) dropArrival(id);
  };

  const trackSlide = (id: string, animation: Animation) => {
    slides.set(id, animation);
    animation.onfinish = () => {
      if (slides.get(id) === animation) slides.delete(id);
    };
  };

  const arrivalObserver = () => {
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const found = [...arrivals].find(([, arrival]) => arrival.el === entry.target);
          if (!found) continue;
          const [id, { el, dx, dy }] = found;
          dropArrival(id);
          if (committedDisabled || !motionAllowed()) continue;
          trackSlide(
            id,
            el.animate(
              [{ opacity: 0, transform: `translate(${dx}px, ${dy}px)` }, { opacity: 1, transform: "none" }],
              { duration: SLIDE_MS, easing: EASING },
            ),
          );
        }
      },
      { threshold: ARRIVAL_THRESHOLD },
    );
    return observer;
  };

  /** Keeps a card that landed out of view invisible until it scrolls into view, then glides it in. */
  const arrive = (id: string, el: HTMLElement, from: DOMRect, to: DOMRect) => {
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const scale = ARRIVAL_OFFSET / (Math.hypot(dx, dy) || 1);
    arrivals.set(id, { el, hide: hideCard(el, 1), dx: dx * scale, dy: dy * scale });
    arrivalObserver().observe(el);
  };

  const measure = (toKey: string): Map<string, SnapItem> => {
    const next = groupsOf(toKey);
    const items = new Map<string, SnapItem>();
    for (const [id, el] of elements) {
      if (!next.has(id) || !el.isConnected) continue;
      const ghost = ghosts.get(id);
      if (ghost) {
        // Mid-flight: continue from where the ghost is, looking like it does.
        const visible = ghost.landsVisible;
        items.set(id, {
          rect: ghost.node.getBoundingClientRect(),
          crossing: true,
          visible,
          face: visible ? makeFace(ghost.face) : null,
        });
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (committedGroups.get(id) === next.get(id)) {
        items.set(id, { rect, crossing: false, visible: false, face: null });
        continue;
      }
      // A card still waiting out of view to glide in was never seen where it is.
      const visible = !arrivals.has(id) && visibleIn(el, rect);
      items.set(id, { rect, crossing: true, visible, face: visible ? makeFace(el) : null });
    }
    return items;
  };

  const slide = ({ id, el, from, to }: Plan) => {
    const dx = from.rect.left - to.left;
    const dy = from.rect.top - to.top;
    if (Math.abs(dx) <= MIN_DELTA && Math.abs(dy) <= MIN_DELTA) return;
    if (!onScreen(from.rect) && !onScreen(to)) return;
    trackSlide(
      id,
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: SLIDE_MS,
        easing: EASING,
      }),
    );
  };

  const fly = ({ id, el, from, to, radius, face: newFace }: Plan) => {
    const oldFace = from.visible ? from.face : null;
    if (!newFace) arrive(id, el, from.rect, to);
    // What the ghost looks like when it lands (or fades out); neither end on screen: no ghost.
    const landingFace = newFace ?? oldFace;
    if (!landingFace) return;

    // The ghost sits at its landing box; keyframes carry it there from the take-off box.
    const start = oldFace ? from.rect : toward(to, from.rect);
    const end = newFace ? to : toward(from.rect, to);
    const startSize = oldFace ? from.rect : to;
    const endSize = newFace ? to : from.rect;
    const node = document.createElement("div");
    Object.assign(node.style, {
      position: "absolute",
      left: `${end.left}px`,
      top: `${end.top}px`,
      width: `${endSize.width}px`,
      height: `${endSize.height}px`,
      overflow: "hidden",
      borderRadius: radius,
      willChange: "transform, opacity",
    });
    if (newFace) {
      placeFace(newFace, to);
      node.appendChild(newFace);
    }
    if (oldFace) {
      placeFace(oldFace, from.rect);
      node.appendChild(oldFace);
    }
    ghostLayer().appendChild(node);

    const extras: Animation[] = [];
    if (newFace && oldFace) {
      // The old look on top fades early in the flight, uncovering the new one underneath.
      extras.push(
        oldFace.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: FLIGHT_MS * 0.6,
          easing: "ease-out",
          fill: "forwards",
        }),
      );
    }
    const resize =
      Math.abs(startSize.width - endSize.width) > 0.5 || Math.abs(startSize.height - endSize.height) > 0.5;
    const flight = node.animate(
      [
        {
          transform: `translate(${start.left - end.left}px, ${start.top - end.top}px)`,
          opacity: oldFace ? 1 : 0,
          ...(resize ? { width: `${startSize.width}px`, height: `${startSize.height}px` } : {}),
        },
        {
          transform: "none",
          opacity: newFace ? 1 : 0,
          ...(resize ? { width: `${endSize.width}px`, height: `${endSize.height}px` } : {}),
        },
      ],
      { duration: FLIGHT_MS, easing: EASING },
    );
    extras.push(
      node.animate([{ boxShadow: REST_SHADOW }, { boxShadow: LIFT_SHADOW, offset: 0.3 }, { boxShadow: REST_SHADOW }], {
        duration: FLIGHT_MS,
        easing: "ease-in-out",
      }),
    );
    const ghost: Ghost = {
      node,
      face: landingFace,
      landsVisible: newFace !== null,
      flight,
      extras,
      // Out-of-view landings are already held invisible by their arrival.
      hide: newFace ? hideCard(el, FLIGHT_MS) : null,
    };
    ghosts.set(id, ghost);
    // Removing the ghost and revealing the card happen in the same task: they swap within one frame.
    flight.onfinish = () => dropGhost(id, ghost);
  };

  const play = (snapshot: Snapshot) => {
    // Rects must be the real layout: stop what's moving (the snapshot already holds where it was).
    settle(false);
    const plans: Plan[] = [];
    for (const [id, el] of elements) {
      const from = snapshot.items.get(id);
      if (!from || !el.isConnected) continue;
      plans.push({ id, el, from, to: el.getBoundingClientRect(), radius: "", face: null });
    }
    for (const plan of plans) {
      if (!plan.from.crossing) continue;
      dropArrival(plan.id);
      plan.radius = getComputedStyle(plan.el.firstElementChild ?? plan.el).borderRadius;
      if (visibleIn(plan.el, plan.to)) plan.face = makeFace(plan.el);
    }
    for (const plan of plans) (plan.from.crossing ? fly : slide)(plan);
  };

  const api: CardFlip = {
    register(id) {
      let ref = refs.get(id);
      if (!ref) {
        ref = (node) => {
          if (node) {
            elements.set(id, node);
            return;
          }
          // The card unmounted (deleted, or remounting in another column): forget its element and
          // anything holding it hidden; a ghost in flight finishes on its own.
          elements.delete(id);
          dropArrival(id);
        };
        refs.set(id, ref);
      }
      return ref;
    },
    wasOnBoard: (id) => committedGroups.has(id),
  };

  return {
    api,
    /** Render phase: snapshot the committed layout when a new one is about to be committed. */
    prepare(key: string, disabled: boolean) {
      if (committedKey === null || key === committedKey) return;
      if (pending && pending.fromKey === committedKey && pending.toKey === key) return;
      pending = null;
      // Right after a drag (`committedDisabled`) dnd-kit has already shown the new order.
      if (disabled || committedDisabled || !motionAllowed()) return;
      pending = { fromKey: committedKey, toKey: key, items: measure(key) };
    },
    /** Layout effect: animate from the snapshot to the committed layout. */
    commit(key: string, disabled: boolean) {
      const previousKey = committedKey;
      const snapshot = pending;
      pending = null;
      committedKey = key;
      committedDisabled = disabled;
      if (key !== previousKey) {
        committedGroups = groupsOf(key);
        for (const id of refs.keys()) if (!committedGroups.has(id)) refs.delete(id);
      }
      // A drag owns card motion; nothing of ours may move (or hide) a card under it.
      if (disabled) {
        settle(true);
        return;
      }
      if (key === previousKey) return;
      // No snapshot (reduced motion, hidden tab, right after a drop): cards just take their places.
      if (!snapshot || snapshot.fromKey !== previousKey || snapshot.toKey !== key) {
        settle(false);
        return;
      }
      play(snapshot);
    },
    dispose() {
      settle(true);
      observer?.disconnect();
      observer = null;
      layer?.remove();
      layer = null;
    },
  };
}
