"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BookOpen, FileText, Folder, Zap } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
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
import { suggestWord, type WordModel, wordCompletionQuery, wordModelFromData, type WordQuery } from "@/lib/word-completion";

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

/** The word model (learned from past prompts) is fetched once per page and shared like the skills. */
let wordModelPromise: Promise<WordModel> | null = null;
function fetchWordModel(): Promise<WordModel> {
  wordModelPromise ??= api
    .wordCompletions()
    .then((response) => wordModelFromData(response.model))
    .catch(() => {
      wordModelPromise = null;
      return wordModelFromData(null);
    });
  return wordModelPromise;
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

/** The inline word suggestion at the caret, plus what the ghost overlay needs to line up with it. */
interface WordSuggestion {
  /** The textarea value the suggestion was made for. */
  value: string;
  query: WordQuery;
  /** Rest of the word, appended after `query.prefix`. */
  suffix: string;
  /** Overlay box and text layout mirrored from the textarea. */
  box: CSSProperties;
  scrollTop: number;
  scrollLeft: number;
}

/**
 * The textarea's text layout for the ghost overlay, so the suggestion lands right after the caret.
 * The box is the textarea's border box minus any scrollbar (client size plus borders): with
 * inset-0 a vertical scrollbar would leave the overlay's lines wider than the textarea's.
 */
function ghostBox(el: HTMLTextAreaElement): CSSProperties {
  const style = getComputedStyle(el);
  const px = (value: string) => Number.parseFloat(value) || 0;
  return {
    boxSizing: "border-box",
    width: el.clientWidth + px(style.borderLeftWidth) + px(style.borderRightWidth),
    height: el.clientHeight + px(style.borderTopWidth) + px(style.borderBottomWidth),
    borderStyle: "solid",
    borderColor: "transparent",
    borderTopWidth: style.borderTopWidth,
    borderRightWidth: style.borderRightWidth,
    borderBottomWidth: style.borderBottomWidth,
    borderLeftWidth: style.borderLeftWidth,
    paddingTop: style.paddingTop,
    paddingRight: style.paddingRight,
    paddingBottom: style.paddingBottom,
    paddingLeft: style.paddingLeft,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    fontStretch: style.fontStretch,
    fontFeatureSettings: style.fontFeatureSettings,
    fontKerning: style.fontKerning as CSSProperties["fontKerning"],
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    textIndent: style.textIndent,
    textTransform: style.textTransform,
    textAlign: style.textAlign as CSSProperties["textAlign"],
    direction: style.direction as CSSProperties["direction"],
    tabSize: style.tabSize,
    wordSpacing: style.wordSpacing,
    whiteSpace: "pre-wrap",
    overflowWrap: style.overflowWrap === "normal" ? "break-word" : (style.overflowWrap as CSSProperties["overflowWrap"]),
    wordBreak: style.wordBreak as CSSProperties["wordBreak"],
  };
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
  /** Call first in the textarea's onKeyDown; true means the menu or the word suggestion handled the key. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Attach as the textarea's onSelect, so caret moves open and close the menu and the word suggestion. */
  onSelect: () => void;
  /**
   * Dim inline rest-of-word after the caret; render right after the textarea inside a `relative`
   * wrapper whose top-left corner is the textarea's. Null without a suggestion.
   */
  ghost: ReactNode;
  /**
   * Tappable chip with the suggested word (touch has no Tab), rendered below the textarea and
   * right-aligned; mobile only (desktop has Tab and the ghost). Null without a suggestion.
   */
  suggestion: ReactNode;
  /** Whether a word suggestion is showing, so Escape only hides it (like `open` for the picker). */
  suggesting: boolean;
}

/**
 * OMP-CLI-style completion for a card composer textarea:
 * - `/` (at the start or after whitespace) lists installed OMP skills plus OMP prompt shortcuts
 *   and inserts `skill://<name>` or the keyword;
 * - `skill://` lists skills by name;
 * - `@` fuzzy-searches the board's project files (only with a `boardId`); picking a directory
 *   inserts `@dir/` and keeps listing its children, picking a file inserts `@path `; either pick
 *   is also reported to `onPickFile` (e.g. to open the file next to the composer);
 * - elsewhere, typing a prose word shows the rest of the likeliest word (learned from past
 *   prompts and this draft) as ghost text after the caret; Tab or → inserts it, Esc hides it.
 *   Enter is never taken.
 */
export function useComposerAutocomplete(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
  setText: (text: string) => void,
  {
    enabled = true,
    boardId = null,
    onPickFile,
  }: { enabled?: boolean; boardId?: string | null; onPickFile?: (hit: ProjectFileHit) => void } = {},
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
  const [wordModel, setWordModel] = useState<WordModel | null>(null);
  const [word, setWord] = useState<WordSuggestion | null>(null);
  /** Start offset of the word Escape hid; that word stays bare until the caret leaves it. */
  const wordDismissedRef = useRef<number | null>(null);
  /** True during IME composition, when the ghost would sit inside the uncommitted text. */
  const composingRef = useRef(false);
  const isMobile = useIsMobile();
  /** Latest `onPickFile`, so callers can pass an inline callback. */
  const onPickFileRef = useRef(onPickFile);
  useEffect(() => {
    onPickFileRef.current = onPickFile;
  });

  useEffect(() => {
    let active = true;
    fetchSkills().then((list) => {
      if (active) setSkills(list);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetchWordModel().then((model) => {
      if (active) setWordModel(model);
    });
    return () => {
      active = false;
    };
  }, []);

  const suggestionAt = (el: HTMLTextAreaElement): WordSuggestion | null => {
    if (!wordModel || composingRef.current || el.ownerDocument.activeElement !== el) return null;
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) return null;
    const query = wordCompletionQuery(el.value, caret);
    if (query === null) {
      wordDismissedRef.current = null;
      return null;
    }
    if (wordDismissedRef.current === query.start) return null;
    const suffix = suggestWord(wordModel, el.value, query);
    if (!suffix) return null;
    return { value: el.value, query, suffix, box: ghostBox(el), scrollTop: el.scrollTop, scrollLeft: el.scrollLeft };
  };

  const sync = () => {
    const el = ref.current;
    let next = el && enabled ? autocompleteTokenAt(el.value, el.selectionStart ?? el.value.length) : null;
    // File mentions need a project to search.
    if (next?.trigger === "mention" && !boardId) next = null;
    if (next === null || dismissedRef.current !== next.start) {
      if (next === null) dismissedRef.current = null;
      setToken(next);
    }
    // Words complete only outside trigger tokens: there the menu owns Tab and the arrows.
    setWord(el && enabled && next === null ? suggestionAt(el) : null);
  };

  // Typing changes the text (and the caret with it); caret-only moves are caught by onSelect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(sync, [text, enabled, boardId, wordModel]);

  // Focus, blur and IME composition change whether the ghost belongs there without an onSelect.
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const hide = () => setWord(null);
    const onCompositionStart = () => {
      composingRef.current = true;
      hide();
    };
    const onCompositionEnd = () => {
      composingRef.current = false;
      sync();
    };
    el.addEventListener("focus", sync);
    el.addEventListener("blur", hide);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    return () => {
      composingRef.current = false;
      el.removeEventListener("focus", sync);
      el.removeEventListener("blur", hide);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, enabled, boardId, wordModel]);

  // While the ghost shows, follow the textarea's scrolling and resizing (the page layout's flex
  // height, the dialog's content sizing, window resizes) so it stays on the caret.
  const suggesting = word !== null;
  useEffect(() => {
    const el = ref.current;
    if (!suggesting || !el) return;
    const onScroll = () => {
      setWord((current) => current && { ...current, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft });
    };
    el.addEventListener("scroll", onScroll);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => setWord((current) => current && { ...current, box: ghostBox(el) }));
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [ref, suggesting]);

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
    if (entry.type === "file") onPickFileRef.current?.(entry.hit);
  };

  const dismiss = () => {
    dismissedRef.current = token?.start ?? null;
    setToken(null);
  };

  /** Inserts the suggested rest of the word at the caret (no trailing space, like the OMP CLI). */
  const acceptWord = (): boolean => {
    const el = ref.current;
    if (!el || !word) return false;
    const { query, suffix } = word;
    // Only the exact state the suggestion was made for; anything else waits for the next sync.
    if (el.value !== word.value || el.selectionStart !== query.end || el.selectionEnd !== query.end) return false;
    const next = el.value.slice(0, query.end) + suffix + el.value.slice(query.end);
    const caret = query.end + suffix.length;
    // Write the DOM first so the caret is already after the word when React commits the same
    // value (and leaves it alone); the text effect then reads the final caret, no frame later.
    el.value = next;
    el.setSelectionRange(caret, caret);
    el.focus();
    setWord(null);
    setText(next);
    return true;
  };

  const onWordKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!word || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      wordDismissedRef.current = word.query.start;
      setWord(null);
      return true;
    }
    if (event.key !== "Tab" && event.key !== "ArrowRight") return false;
    // Shift+Tab keeps moving focus back; modified arrows keep selecting and jumping words.
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (!acceptWord()) return false;
    event.preventDefault();
    return true;
  };

  /** `index` clamped to the list, which can shrink when newer file results arrive. */
  const selected = Math.min(index, entries.length - 1);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return onWordKeyDown(event);
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

  const ghost = word ? (
    <div aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-hidden select-none" style={word.box}>
      {/* The whole value keeps wrapping identical to the textarea; only the suffix is visible. */}
      <div style={{ transform: `translate(${-word.scrollLeft}px, ${-word.scrollTop}px)` }}>
        <span className="text-transparent">{word.value.slice(0, word.query.end)}</span>
        <span className="text-muted-foreground/70">{word.suffix}</span>
        <span className="text-transparent">{word.value.slice(word.query.end)}</span>
      </div>
    </div>
  ) : null;

  const suggestion = word && isMobile ? (
    <div className="flex justify-end">
      <button
        type="button"
        tabIndex={-1}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        aria-label={`Complete word: ${word.query.prefix}${word.suffix}`}
        // Keep the textarea focused (and its caret) through the tap.
        onMouseDown={(event) => event.preventDefault()}
        onClick={acceptWord}
      >
        <span className="truncate">
          <span className="text-foreground">{word.query.prefix}</span>
          {word.suffix}
        </span>
      </button>
    </div>
  ) : null;

  return { menu, open, onKeyDown, onSelect: sync, ghost, suggestion, suggesting };
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
