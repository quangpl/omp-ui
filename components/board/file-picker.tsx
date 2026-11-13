"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Folder, LoaderCircle, Search } from "lucide-react";
import { fileIcon } from "@/components/board/file-icon";
import { errorMessage } from "@/components/board/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api-client";
import { isMacPlatform, modKeyLabel } from "@/lib/hotkeys";
import type { ProjectFileHit } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Most results one search shows. */
const PICKER_LIMIT = 50;
/** Pause after the last keystroke before asking the server, so fast typing sends one request. */
const SEARCH_DEBOUNCE_MS = 120;

const BADGE = "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-normal text-muted-foreground";

/**
 * "Open file…" button with a searchable dropdown of the board's project files (Mod-P).
 * Picking a directory browses into it; picking a file calls `onPick` with its path id
 * (`ProjectFileHit.insert`).
 */
export function FilePicker({
  boardId,
  onPick,
  className,
}: {
  boardId: string;
  onPick: (path: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Hits for the search `key` (`${boardId}\n${query}`); kept while a newer search loads. */
  const [results, setResults] = useState<{ key: string; hits: ProjectFileHit[]; error: string | null } | null>(null);
  const [index, setIndex] = useState(0);
  const [modLabel, setModLabel] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // The platform is only known in the browser; reading it during render would mismatch hydration.
  useEffect(() => setModLabel(modKeyLabel()), []);

  // Mod-P opens the picker while focus is in the same dialog as the trigger (or anywhere outside
  // dialogs), instead of the browser's print dialog.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "p" || event.shiftKey || event.altKey) return;
      if (!(isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      const trigger = triggerRef.current;
      if (!trigger || trigger.getClientRects().length === 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const inPicker = !!target && !!contentRef.current?.contains(target);
      const dialog = trigger.closest('[role="dialog"]');
      const targetDialog = target?.closest('[role="dialog"]') ?? null;
      if (!inPicker && targetDialog !== dialog) return;
      event.preventDefault();
      setQuery("");
      setOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const key = `${boardId}\n${query}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        api.boards
          .projectFiles(boardId, query, { limit: PICKER_LIMIT, signal: controller.signal })
          .then(({ files }) => {
            if (!controller.signal.aborted) setResults({ key, hits: files, error: null });
          })
          .catch((err: unknown) => {
            if (!controller.signal.aborted) setResults({ key, hits: [], error: errorMessage(err) });
          });
      },
      // Opening (empty query) lists the top level right away; typing waits for a pause.
      query ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, boardId, query, key]);

  const loading = results?.key !== key;
  const hits = results?.hits ?? [];
  /** `index` clamped to the list, which can shrink when newer results arrive. */
  const selected = Math.min(index, hits.length - 1);

  useEffect(() => setIndex(0), [results]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, results]);

  const pick = (hit: ProjectFileHit) => {
    if (hit.kind === "dir") {
      setQuery(hit.insert);
      inputRef.current?.focus();
      return;
    }
    setOpen(false);
    onPick(hit.insert);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (hits.length === 0) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setIndex((selected + step + hits.length) % hits.length);
        break;
      }
      case "Enter":
        if (selected < 0) return;
        pick(hits[selected]);
        break;
      case "Escape":
        // Close only the picker; the card sheet around it stays open.
        event.stopPropagation();
        setOpen(false);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const activeId = selected >= 0 ? `${listId}-${selected}` : undefined;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setQuery("");
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button ref={triggerRef} variant="outline" size="sm" className={cn("max-md:h-11", className)}>
          <Search aria-hidden />
          Open file…
          {modLabel && (
            <Kbd className="ml-1 max-md:hidden" aria-hidden>
              {modLabel === "⌘" ? "⌘P" : `${modLabel} P`}
            </Kbd>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        data-vaul-no-drag
        className="w-[min(32rem,calc(100vw-2rem))] gap-0 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="relative border-b p-2">
          <Input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label="Search project files"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            placeholder="Search project files"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            className="pr-8"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {loading && hits.length > 0 && (
            <LoaderCircle
              className="pointer-events-none absolute top-1/2 right-4.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden
            />
          )}
        </div>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Project files"
          aria-busy={loading}
          className="max-h-[min(20rem,50dvh)] overflow-y-auto overscroll-contain p-1"
        >
          {hits.length === 0 ? (
            <li role="presentation" className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              {loading ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                  Searching files…
                </>
              ) : results?.error ? (
                <span className="text-destructive">Couldn't search files: {results.error}</span>
              ) : (
                "No matching files"
              )}
            </li>
          ) : (
            hits.map((hit, i) => (
              <PickerRow
                key={hit.insert}
                id={`${listId}-${i}`}
                hit={hit}
                active={i === selected}
                onHover={() => setIndex(i)}
                onPick={() => pick(hit)}
              />
            ))
          )}
        </ul>
        <p className="border-t px-2.5 py-1.5 text-[11px] text-muted-foreground max-md:hidden">
          <span className="font-medium text-foreground/70">↑↓</span> choose,{" "}
          <span className="font-medium text-foreground/70">↵</span> open,{" "}
          <span className="font-medium text-foreground/70">esc</span> close — picking a folder browses it
        </p>
      </PopoverContent>
    </Popover>
  );
}

function PickerRow({
  id,
  hit,
  active,
  onHover,
  onPick,
}: {
  id: string;
  hit: ProjectFileHit;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const dir = hit.kind === "dir";
  const trimmed = hit.path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  const name = trimmed.slice(slash + 1);
  const parent = trimmed.slice(0, slash + 1);
  const Icon = dir ? Folder : fileIcon(name);
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      title={hit.insert}
      className={cn(
        "flex h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm select-none md:h-8",
        active && "bg-accent text-accent-foreground",
      )}
      // Keep focus in the search field through the click.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={active ? undefined : onHover}
      onClick={onPick}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="max-w-full shrink-0 truncate font-medium">
          {name}
          {dir && "/"}
        </span>
        {parent && <span className="truncate text-xs text-muted-foreground">{parent}</span>}
      </span>
      {hit.folder && <span className={BADGE}>{hit.folder}</span>}
    </li>
  );
}
