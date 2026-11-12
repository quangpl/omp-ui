"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Multi-select of board cards (desktop): the ids of the selected cards plus a range anchor. */
export interface CardSelection {
  selected: ReadonlySet<string>;
  /** Adds or removes one card; it becomes the anchor for ⇧-range extension. */
  toggle: (id: string) => void;
  /** Replaces the whole selection (range extension, select all). */
  replace: (ids: Iterable<string>) => void;
  clear: () => void;
  /** Card a ⇧↑/⇧↓ range grows from; null until a card is toggled or a range starts. */
  anchor: { current: string | null };
}

const EMPTY: ReadonlySet<string> = new Set();

/** Selection state; ids of cards that leave the board (`liveIds`) drop out automatically. */
export function useCardSelection(liveIds: ReadonlySet<string> | ReadonlyMap<string, unknown>): CardSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY);
  const anchor = useRef<string | null>(null);

  useEffect(() => {
    setSelected((prev) => {
      if ([...prev].every((id) => liveIds.has(id))) return prev;
      return new Set([...prev].filter((id) => liveIds.has(id)));
    });
    if (anchor.current && !liveIds.has(anchor.current)) anchor.current = null;
  }, [liveIds]);

  const toggle = useCallback((id: string) => {
    anchor.current = id;
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const replace = useCallback((ids: Iterable<string>) => setSelected(new Set(ids)), []);
  const clear = useCallback(() => {
    anchor.current = null;
    setSelected(EMPTY);
  }, []);

  return useMemo(() => ({ selected, toggle, replace, clear, anchor }), [selected, toggle, replace, clear]);
}
