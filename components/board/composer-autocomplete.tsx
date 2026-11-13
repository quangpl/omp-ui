"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BookOpen, FileText, Folder, Zap } from "lucide-react";
import { api } from "@/lib/api-client";
import {
  applyCompletion,
  type AutocompleteToken,
  autocompleteTokenAt,
  mentionText,
} from "@/lib/composer-autocomplete";
import { filterSlashItems, type SlashItem, slashItems } from "@/lib/slash-skills";
import type { OmpSkill, ProjectFileHit } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Skills are fetched once per page; every composer shares the promise. */
let skillsPromise: Promise<OmpSkill[]> | null = null;
function fetchSkills(): Promise<OmpSkill[]> {
  skillsPromise ??= api
    .skills()
    .then((response) => response.skills)
    .catch(() => {
      skillsPromise = null;
      return [];
    });
  return skillsPromise;
}

/** Recent "@" searches keyed `${boardId}\n${query}`, so backspacing and retyping is instant. */
const fileCache = new Map<string, ProjectFileHit[]>();
const FILE_CACHE_LIMIT = 100;
/** Pause after the last keystroke before asking the server, so fast typing sends one request. */
const FILE_SEARCH_DEBOUNCE_MS = 120;

function cacheFiles(key: string, hits: ProjectFileHit[]): void {
  fileCache.delete(key);
  fileCache.set(key, hits);
  // Maps iterate in insertion order: the first key is the oldest.
  if (fileCache.size > FILE_CACHE_LIMIT) fileCache.delete(fileCache.keys().next().value as string);
}

/** One pickable row: a skill or shortcut ("/" and "skill://") or a project file ("@"). */
type Entry = { type: "skill"; item: SlashItem; label: string } | { type: "file"; hit: ProjectFileHit };

/** File results for the "@" token starting at `start`; `key` is the search they answer. */
interface FileResults {
  start: number;
  key: string;
  hits: ProjectFileHit[];
}

const MENU_LABELS: Record<AutocompleteToken["trigger"], { hint: string; aria: string }> = {
  slash: { hint: "OMP skills & shortcuts", aria: "OMP skills and shortcuts" },
  mention: { hint: "Project files", aria: "Project files" },
  "skill-url": { hint: "Skills", aria: "Skills" },
};

export interface ComposerAutocomplete {
  /** The picker, rendered right below the textarea; null while closed. */
  menu: ReactNode;
  /** Whether the picker is showing (for `aria-expanded`, and so Escape closes only the picker). */
  open: boolean;
  /** Call first in the textarea's onKeyDown; true means the menu handled the key. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Attach as the textarea's onSelect, so caret moves open and close the menu. */
  onSelect: () => void;
}

/**
 * OMP-CLI-style completion for a card composer textarea:
 * - `/` (at the start or after whitespace) lists installed OMP skills plus OMP prompt shortcuts
 *   and inserts `skill://<name>` or the keyword;
 * - `skill://` lists skills by name;
 * - `@` fuzzy-searches the board's project files (only with a `boardId`); picking a directory
 *   inserts `@dir/` and keeps listing its children, picking a file inserts `@path `.
 */
export function useComposerAutocomplete(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
  setText: (text: string) => void,
  { enabled = true, boardId = null }: { enabled?: boolean; boardId?: string | null } = {},
): ComposerAutocomplete {
  const [skills, setSkills] = useState<OmpSkill[] | null>(null);
  const [token, setToken] = useState<AutocompleteToken | null>(null);
  const [files, setFiles] = useState<FileResults | null>(null);
  const [index, setIndex] = useState(0);
  /** Start offset of the token Escape closed; that token stays closed until it changes. */
  const dismissedRef = useRef<number | null>(null);
  /** Bumped per file search, so a slow stale response never overwrites a newer one. */
  const fileSeqRef = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let active = true;
    fetchSkills().then((list) => {
      if (active) setSkills(list);
    });
    return () => {
      active = false;
    };
  }, []);

  const sync = () => {
    const el = ref.current;
    let next = el && enabled ? autocompleteTokenAt(el.value, el.selectionStart ?? el.value.length) : null;
    // File mentions need a project to search.
    if (next?.trigger === "mention" && !boardId) next = null;
    if (next === null || dismissedRef.current !== next.start) {
      if (next === null) dismissedRef.current = null;
      setToken(next);
    }
  };

  // Typing changes the text (and the caret with it); caret-only moves are caught by onSelect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(sync, [text, enabled, boardId]);

  const mentionQuery = token?.trigger === "mention" ? token.query : null;
  const mentionStart = token?.start ?? -1;
  useEffect(() => {
    if (mentionQuery === null || !boardId) {
      setFiles(null);
      return;
    }
    const key = `${boardId}\n${mentionQuery}`;
    const seq = ++fileSeqRef.current;
    const cached = fileCache.get(key);
    if (cached) {
      setFiles({ start: mentionStart, key, hits: cached });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.boards
        .projectFiles(boardId, mentionQuery, { signal: controller.signal })
        .then(({ files: hits }) => {
          cacheFiles(key, hits);
          return hits;
        })
        .catch(() => (controller.signal.aborted ? null : []))
        .then((hits) => {
          if (hits === null || seq !== fileSeqRef.current) return;
          setFiles({ start: mentionStart, key, hits });
        });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [boardId, mentionQuery, mentionStart]);

  // Results for this "@" token, possibly for an older query while the newer one loads; null until
  // the token's first search answers.
  const fileHits = token?.trigger === "mention" && files?.start === token.start ? files.hits : null;

  const entries = useMemo<Entry[]>(() => {
    if (!token) return [];
    if (token.trigger === "mention") return (fileHits ?? []).map<Entry>((hit) => ({ type: "file", hit }));
    if (!skills) return [];
    if (token.trigger === "slash") {
      return filterSlashItems(slashItems(skills), token.query).map<Entry>((item) => ({
        type: "skill",
        item,
        label: `/${item.name}`,
      }));
    }
    const skillItems = slashItems(skills).filter((item) => item.kind === "skill");
    return filterSlashItems(skillItems, token.query).map<Entry>((item) => ({ type: "skill", item, label: item.insert }));
  }, [skills, token, fileHits]);

  const loading = token?.trigger === "mention" ? fileHits === null : skills === null;
  const open = token !== null && (entries.length > 0 || loading);

  useEffect(() => setIndex(0), [token?.trigger, token?.start, token?.query]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index, open]);

  const apply = (entry: Entry) => {
    const el = ref.current;
    if (!el || !token) return;
    const next =
      entry.type === "file"
        ? applyCompletion(el.value, token, mentionText(entry.hit.insert), {
            // A directory keeps the caret inside the token so its children list right away.
            trailingSpace: entry.hit.kind !== "dir",
          })
        : applyCompletion(el.value, token, entry.item.insert);
    setText(next.text);
    setToken(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      // The caret is final only now; re-read the token (a directory mention reopens the menu).
      sync();
    });
  };

  const dismiss = () => {
    dismissedRef.current = token?.start ?? null;
    setToken(null);
  };

  /** `index` clamped to the list, which can shrink when newer file results arrive. */
  const selected = Math.min(index, entries.length - 1);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return true;
    }
    if (entries.length === 0) return false;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setIndex((step + selected + entries.length) % entries.length);
        return true;
      }
      case "Enter":
      case "Tab": {
        // Ctrl/Cmd+Enter still submits the form.
        if (event.metaKey || event.ctrlKey) return false;
        event.preventDefault();
        apply(entries[selected]);
        return true;
      }
      default:
        return false;
    }
  };

  const labels = token ? MENU_LABELS[token.trigger] : MENU_LABELS.slash;

  const menu = open ? (
    <div className="overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-sm">
      <p className="border-b px-2.5 py-1.5 text-[11px] text-muted-foreground">
        {labels.hint} — <span className="font-medium text-foreground/70">↑↓</span> choose,{" "}
        <span className="font-medium text-foreground/70">↵</span>/
        <span className="font-medium text-foreground/70">tab</span> insert,{" "}
        <span className="font-medium text-foreground/70">esc</span> close
      </p>
      <ul ref={listRef} role="listbox" aria-label={labels.aria} className="max-h-48 overflow-y-auto p-1">
        {entries.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">
            {token?.trigger === "mention" ? "Searching files…" : "Loading skills…"}
          </li>
        ) : (
          entries.map((entry, i) => (
            <li
              key={entry.type === "file" ? `file:${entry.hit.insert}` : entry.item.insert}
              role="option"
              aria-selected={i === selected}
            >
              <button
                type="button"
                tabIndex={-1}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                  i === selected && "bg-accent text-accent-foreground",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setIndex(i)}
                onClick={() => apply(entry)}
              >
                {entry.type === "file" ? <FileRow hit={entry.hit} /> : <SkillRow item={entry.item} label={entry.label} />}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  ) : null;

  return { menu, open, onKeyDown, onSelect: sync };
}

const BADGE = "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-normal text-muted-foreground";

function SkillRow({ item, label }: { item: SlashItem; label: string }) {
  return (
    <>
      <span className="flex w-full items-center gap-1.5 text-xs font-medium">
        {item.kind === "skill" ? (
          <BookOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <Zap className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="truncate">{label}</span>
        <span className={cn("ml-auto", BADGE)}>{item.kind === "skill" ? "skill" : "shortcut"}</span>
      </span>
      {item.description && <span className="line-clamp-2 text-[11px] text-muted-foreground">{item.description}</span>}
    </>
  );
}

function FileRow({ hit }: { hit: ProjectFileHit }) {
  const Icon = hit.kind === "dir" ? Folder : FileText;
  return (
    <span className="flex w-full items-center gap-1.5 text-xs font-medium">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{hit.path}</span>
      {hit.folder && <span className={BADGE}>{hit.folder}</span>}
      <span className={cn("ml-auto", BADGE)}>{hit.kind === "dir" ? "folder" : "file"}</span>
    </span>
  );
}
