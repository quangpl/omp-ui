"use client";

import { type KeyboardEvent, useEffect, useRef } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { isModalOpen, isPlainKey } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";

export interface BoardSearchProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Cards matching `value` across the board. */
  matches: number;
  /** Cards on the board. */
  total: number;
  /** The matches are close ones (typos, skipped letters), not literal: shows a quiet "fuzzy" tag. */
  fuzzy?: boolean;
  /** Enter / ArrowDown in the field: hand focus to the first result. */
  onSubmit?: () => void;
  className?: string;
}

/**
 * Title filter for the board: `F` focuses it, Esc clears it, a pill reports the match count (and
 * whether the matches are fuzzy).
 */
export function BoardSearch({
  value,
  onValueChange,
  matches,
  total,
  fuzzy = false,
  onSubmit,
  className,
}: BoardSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isPlainKey(event, "f") || isModalOpen()) return;
      const input = inputRef.current;
      // Desktop and phone layouts may both mount a field; only the rendered one claims the key.
      if (!input || input.getClientRects().length === 0) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      if (value) {
        event.preventDefault();
        event.stopPropagation();
        onValueChange("");
      } else {
        event.currentTarget.blur();
      }
    } else if ((event.key === "Enter" || event.key === "ArrowDown") && onSubmit) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <search
      role="search"
      className={cn(
        "group/board-search flex h-8 w-full min-w-0 items-center rounded-lg border border-input bg-background pr-1 transition-[border-color,box-shadow] has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50 max-md:h-11 dark:bg-input/30",
        className,
      )}
    >
      <label className="flex h-full min-w-0 flex-1 cursor-text items-center gap-2 pl-2.5">
        <Search
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-colors group-focus-within/board-search:text-foreground max-md:size-4"
        />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search cards"
          aria-label="Search cards"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground max-md:text-base [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
        />
      </label>
      <div className="flex shrink-0 items-center gap-1 pl-1">
        <span role="status" aria-live="polite" className="inline-flex items-center gap-1">
          {value && fuzzy && matches > 0 && (
            <span
              title="Showing close matches (typos and skipped letters)"
              className="font-mono text-[10px] leading-none font-medium tracking-wide whitespace-nowrap text-muted-foreground/80 animate-fade-in-soft"
            >
              fuzzy
            </span>
          )}
          {value && (
            <span
              key={matches === 0 ? "none" : "some"}
              className={cn(
                "inline-flex h-5 items-center rounded-full px-1.5 font-mono text-[11px] font-medium whitespace-nowrap tabular-nums animate-fade-in-soft",
                matches === 0
                  ? "bg-destructive/10 text-destructive dark:bg-destructive/20"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {matches === 0 ? "No matches" : `${matches} of ${total}`}
            </span>
          )}
        </span>
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear search"
            onClick={() => {
              onValueChange("");
              inputRef.current?.focus();
            }}
            className="text-muted-foreground hover:text-foreground active:not-aria-[haspopup]:scale-[0.96] max-md:size-9"
          >
            <X className="size-3.5 max-md:size-4" />
          </Button>
        ) : (
          <Kbd className="mr-0.5 group-focus-within/board-search:hidden max-md:hidden">F</Kbd>
        )}
      </div>
    </search>
  );
}
