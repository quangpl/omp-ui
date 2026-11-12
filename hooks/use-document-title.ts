"use client";

import { useEffect } from "react";

/**
 * Browser-tab title for client pages: "<title> · AgentMan" (the root layout's template only
 * covers server metadata). Skips empty titles (e.g. while a board is still loading) and
 * restores the previous title on unmount.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · AgentMan`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
