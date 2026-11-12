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
import { BookOpen, Zap } from "lucide-react";
import { api } from "@/lib/api-client";
import {
  applySlashItem,
  filterSlashItems,
  type SlashItem,
  slashItems,
  type SlashToken,
  slashTokenAt,
} from "@/lib/slash-skills";
import type { OmpSkill } from "@/lib/types";
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

export interface SkillSlash {
  /** The picker, rendered right below the textarea; null while closed. */
  menu: ReactNode;
  /** Call first in the textarea's onKeyDown; true means the menu handled the key. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Attach as the textarea's onSelect, so caret moves open and close the menu. */
  onSelect: () => void;
}

/**
 * "/" picker for a card composer textarea: typing `/` (at the start or after whitespace) opens a
 * menu of every installed OMP skill plus OMP prompt shortcuts; picking one inserts its token
 * (`skill://<name>` or the keyword) into the text.
 */
export function useSkillSlash(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
  setText: (text: string) => void,
  enabled = true,
): SkillSlash {
  const [skills, setSkills] = useState<OmpSkill[] | null>(null);
  const [token, setToken] = useState<SlashToken | null>(null);
  const [index, setIndex] = useState(0);
  /** Start offset of the token Escape closed; that token stays closed until it changes. */
  const dismissedRef = useRef<number | null>(null);
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
    const next = el && enabled ? slashTokenAt(el.value, el.selectionStart ?? el.value.length) : null;
    if (next === null || dismissedRef.current !== next.start) {
      if (next === null) dismissedRef.current = null;
      setToken(next);
    }
  };

  // Typing changes the text (and the caret with it); caret-only moves are caught by onSelect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(sync, [text, enabled]);

  const items = useMemo(
    () => (token && skills ? filterSlashItems(slashItems(skills), token.query) : []),
    [skills, token],
  );
  const open = token !== null && (items.length > 0 || skills === null);

  useEffect(() => setIndex(0), [token?.start, token?.query]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index, open]);

  const apply = (item: SlashItem) => {
    const el = ref.current;
    if (!el || !token) return;
    const next = applySlashItem(el.value, token, item);
    setText(next.text);
    setToken(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const dismiss = () => {
    dismissedRef.current = token?.start ?? null;
    setToken(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return true;
    }
    if (items.length === 0) return false;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setIndex((current) => (current + step + items.length) % items.length);
        return true;
      }
      case "Enter":
      case "Tab": {
        // Ctrl/Cmd+Enter still submits the form.
        if (event.metaKey || event.ctrlKey) return false;
        event.preventDefault();
        apply(items[index] ?? items[0]);
        return true;
      }
      default:
        return false;
    }
  };

  const menu = open ? (
    <div className="overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-sm">
      <p className="border-b px-2.5 py-1.5 text-[11px] text-muted-foreground">
        OMP skills & shortcuts — <span className="font-medium text-foreground/70">↑↓</span> choose,{" "}
        <span className="font-medium text-foreground/70">↵</span> insert,{" "}
        <span className="font-medium text-foreground/70">esc</span> close
      </p>
      <ul ref={listRef} role="listbox" aria-label="OMP skills and shortcuts" className="max-h-48 overflow-y-auto p-1">
        {skills === null ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">Loading skills…</li>
        ) : (
          items.map((item, i) => (
            <li key={item.insert} role="option" aria-selected={i === index}>
              <button
                type="button"
                tabIndex={-1}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                  i === index && "bg-accent text-accent-foreground",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setIndex(i)}
                onClick={() => apply(item)}
              >
                <span className="flex w-full items-center gap-1.5 text-xs font-medium">
                  {item.kind === "skill" ? (
                    <BookOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <Zap className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="truncate">/{item.name}</span>
                  <span className="ml-auto shrink-0 rounded-full border px-1.5 py-px text-[10px] font-normal text-muted-foreground">
                    {item.kind === "skill" ? "skill" : "shortcut"}
                  </span>
                </span>
                {item.description && (
                  <span className="line-clamp-2 text-[11px] text-muted-foreground">{item.description}</span>
                )}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  ) : null;

  return { menu, onKeyDown, onSelect: sync };
}
