"use client";

import { type RefObject, useEffect, useState } from "react";
import { Loader2Icon, SearchIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** Search box with an `F` hint, a clear button and a busy spinner. */
export function SearchField({
  inputRef,
  value,
  onChange,
  placeholder,
  busy,
  className,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  busy?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("group/search relative min-w-0", className)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-11 pr-16 pl-9 [&::-webkit-search-cancel-button]:hidden md:h-9"
      />
      <div className="absolute top-1/2 right-0 flex -translate-y-1/2 items-center gap-1 md:right-2">
        {busy && <Loader2Icon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />}
        {value ? (
          <button
            type="button"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            className="pressable-icon flex size-11 items-center justify-center rounded-md text-muted-foreground transition-[color,scale] hover:text-foreground md:size-6"
            aria-label="Clear search"
          >
            <XIcon className="size-4" />
          </button>
        ) : (
          <Kbd className="hidden md:inline-flex group-focus-within/search:hidden">F</Kbd>
        )}
      </div>
    </div>
  );
}

export interface FilterOption {
  value: string;
  label: string;
  hint?: string;
}

/** Compact labelled select; `all` is the "no filter" value. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly FilterOption[];
  allLabel?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={cn("h-11 w-full min-w-0 md:h-9 md:w-auto md:max-w-56", className)}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent position="popper" align="start" className="max-h-80">
        {allLabel && <SelectItem value="all">{allLabel}</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="truncate">{option.label}</span>
            {option.hint && <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{option.hint}</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
