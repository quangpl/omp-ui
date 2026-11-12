"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { isMacPlatform, isPlainKey } from "@/lib/hotkeys";

const KEYBOARD_HELP_EVENT = "omp-ui:keyboard-help";

/** Ask the global help dialog (mounted in `Providers`) to open. */
export function openKeyboardHelp(): void {
  window.dispatchEvent(new Event(KEYBOARD_HELP_EVENT));
}

/**
 * One way to trigger a shortcut: `+` joins keys pressed together, a space separates the steps of a
 * sequence ("G P" = G, then P). `Mod` renders as ⌘ on Apple platforms and Ctrl elsewhere.
 */
type Binding = string;

interface Shortcut {
  label: string;
  /** Alternative bindings; any of them works. */
  keys: Binding[];
}

interface ShortcutGroup {
  title: string;
  note?: string;
  shortcuts: Shortcut[];
}

/** Every keyboard shortcut of the app; the cheat sheet renders (and filters) this list. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "Everywhere",
    shortcuts: [
      { label: "Command palette", keys: ["Mod+K", "/"] },
      { label: "New card", keys: ["N", "C"] },
      { label: "Keyboard shortcuts (this sheet)", keys: ["?"] },
      { label: "Toggle sidebar", keys: ["Mod+B"] },
    ],
  },
  {
    title: "Go to",
    shortcuts: [
      { label: "Projects home", keys: ["G P", "G H"] },
      { label: "Visualize", keys: ["G V"] },
      { label: "Containers (Docker)", keys: ["G D"] },
      { label: "Stats", keys: ["G T"] },
      { label: "Memory", keys: ["G M"] },
      { label: "Settings", keys: ["G S"] },
    ],
  },
  {
    title: "Containers",
    shortcuts: [
      { label: "Focus the launcher", keys: ["L"] },
      { label: "Previous / next result", keys: ["↑", "↓"] },
      { label: "Run with defaults", keys: ["↵"] },
      { label: "Customize before running", keys: ["⇧+↵"] },
      { label: "Clear the launcher", keys: ["Esc"] },
    ],
  },
  {
    title: "Memory",
    shortcuts: [
      { label: "Focus search", keys: ["F"] },
      { label: "Previous / next memory", keys: ["K", "J"] },
      { label: "Open the selected memory", keys: ["↵"] },
      { label: "Close the detail", keys: ["Esc"] },
    ],
  },
  {
    title: "Board",
    shortcuts: [
      { label: "Previous card", keys: ["↑", "K"] },
      { label: "Next card", keys: ["↓", "J"] },
      { label: "Column left", keys: ["←", "H"] },
      { label: "Column right", keys: ["→", "L"] },
      { label: "Jump to To do / In progress / Done", keys: ["1", "2", "3"] },
      { label: "First card of the column", keys: ["Home"] },
      { label: "Last card of the column", keys: ["End"] },
      { label: "Open card", keys: ["↵", "O", "E"] },
      { label: "Duplicate card", keys: ["D"] },
      { label: "Delete card…", keys: ["⌫", "Delete"] },
      { label: "Copy card link", keys: ["Y"] },
      { label: "Card actions menu", keys: [".", "⇧+F10"] },
      { label: "Pick up / drop card (arrows move it)", keys: ["Space"] },
    ],
  },
  {
    title: "Selection & quick actions",
    note: "Quick actions apply to the selected cards, or to the focused card when nothing is selected.",
    shortcuts: [
      { label: "Toggle selection of the focused card", keys: ["X"] },
      { label: "Extend selection up", keys: ["⇧+↑", "⇧+K"] },
      { label: "Extend selection down", keys: ["⇧+↓", "⇧+J"] },
      { label: "Select all in the column (whole board if none focused)", keys: ["Mod+A"] },
      { label: "Clear selection, then unfocus", keys: ["Esc"] },
      { label: "Start / resume / retry agent", keys: ["R"] },
      { label: "Stop agent", keys: ["S"] },
      { label: "Revert to To do", keys: ["Z"] },
      { label: "Push to main (when available)", keys: ["P"] },
    ],
  },
  {
    title: "Card panel",
    shortcuts: [
      { label: "Next card", keys: ["J"] },
      { label: "Previous card", keys: ["K"] },
      { label: "Start / resume / retry agent", keys: ["R"] },
      { label: "Stop agent", keys: ["S"] },
      { label: "Revert to To do", keys: ["Z"] },
      { label: "Push to main (when available)", keys: ["P"] },
      { label: "Next tab", keys: ["]"] },
      { label: "Previous tab", keys: ["["] },
      { label: "Send feedback / save text", keys: ["Mod+↵"] },
      { label: "Close panel (or leave the field)", keys: ["Esc"] },
      { label: "Next / previous changed file (Changes tab)", keys: ["Alt+↓", "Alt+↑"] },
    ],
  },
  {
    title: "Home",
    shortcuts: [
      { label: "Next / previous Needs-you row", keys: ["J", "K"] },
      { label: "Open the focused card", keys: ["↵"] },
      { label: "Retry / resume the focused card", keys: ["R"] },
      { label: "Stop the focused card's agent", keys: ["S"] },
      { label: "Push the focused card to main", keys: ["P"] },
    ],
  },
  {
    title: "Attachment viewer",
    shortcuts: [
      { label: "Previous / next attachment", keys: ["←", "→"] },
      { label: "Toggle fit / 100% zoom", keys: ["Z"] },
      { label: "Close", keys: ["Esc"] },
    ],
  },
  {
    title: "Command palette",
    shortcuts: [
      { label: "Next result", keys: ["↓", "Ctrl+N", "Tab"] },
      { label: "Previous result", keys: ["↑", "Ctrl+P", "⇧+Tab"] },
      { label: "First / last result", keys: ["Home", "End"] },
      { label: "Page through results", keys: ["PageUp", "PageDown"] },
      { label: "Run the highlighted entry", keys: ["↵"] },
      { label: "Open a card in a new tab", keys: ["Mod+↵"] },
      { label: "Close", keys: ["Esc"] },
    ],
  },
];

/** Display text of one key (`Mod` resolved per platform). */
function keyLabel(key: string, mac: boolean): string {
  if (key === "Mod") return mac ? "⌘" : "Ctrl";
  if (key === "PageUp") return "PgUp";
  if (key === "PageDown") return "PgDn";
  return key;
}

/** Searchable text of a binding: "G then P", "Ctrl K"… */
function bindingText(binding: Binding, mac: boolean): string {
  return binding
    .split(" ")
    .map((step) =>
      step
        .split("+")
        .map((key) => keyLabel(key, mac))
        .join(" "),
    )
    .join(" then ");
}

function BindingKeys({ binding, mac }: { binding: Binding; mac: boolean }) {
  const steps = binding.split(" ");
  return (
    <span className="inline-flex items-center gap-1">
      {steps.map((step, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-[11px] text-muted-foreground">then</span>}
          <KbdGroup>
            {step.split("+").map((key) => (
              <Kbd key={key}>{keyLabel(key, mac)}</Kbd>
            ))}
          </KbdGroup>
        </Fragment>
      ))}
    </span>
  );
}

function ShortcutRow({ shortcut, mac }: { shortcut: Shortcut; mac: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="min-w-0 text-sm text-muted-foreground">{shortcut.label}</span>
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
        {shortcut.keys.map((binding, i) => (
          <Fragment key={binding}>
            {i > 0 && (
              <span className="text-xs text-muted-foreground/60" aria-hidden>
                /
              </span>
            )}
            <BindingKeys binding={binding} mac={mac} />
          </Fragment>
        ))}
      </span>
    </div>
  );
}

/** Groups whose title, rows or keys match every word of `query` (a matching title keeps the whole group). */
function filterGroups(query: string, mac: boolean): ShortcutGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...SHORTCUT_GROUPS];
  const matches = (text: string) => words.every((word) => text.includes(word));
  const result: ShortcutGroup[] = [];
  for (const group of SHORTCUT_GROUPS) {
    if (matches(group.title.toLowerCase())) {
      result.push(group);
      continue;
    }
    const shortcuts = group.shortcuts.filter((shortcut) =>
      matches(
        `${group.title} ${shortcut.label} ${shortcut.keys.map((binding) => bindingText(binding, mac)).join(" ")}`.toLowerCase(),
      ),
    );
    if (shortcuts.length > 0) result.push({ ...group, shortcuts });
  }
  return result;
}

/** Global "?" cheat sheet of every keyboard shortcut, filterable by typing. */
export function KeyboardHelpDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mac, setMac] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pathname = usePathname();
  const signedOut = pathname === "/login";

  useEffect(() => {
    setMac(isMacPlatform());
  }, []);

  useEffect(() => {
    if (signedOut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainKey(event, "?")) return;
      event.preventDefault();
      setOpen(true);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(KEYBOARD_HELP_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(KEYBOARD_HELP_EVENT, onOpen);
    };
  }, [signedOut]);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const groups = useMemo(() => filterGroups(query, mac), [query, mac]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          // Focus the filter for keyboard users; touch devices would pop the on-screen keyboard.
          event.preventDefault();
          if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
        }}
      >
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Drive the whole board without the mouse.</DialogDescription>
        </DialogHeader>
        <div className="mx-5 mb-1 flex items-center gap-2 rounded-lg border bg-transparent px-2.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter shortcuts…"
            aria-label="Filter shortcuts"
            className="h-9 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-5">
          {groups.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No shortcuts match “{query.trim()}”.</p>
          ) : (
            <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              {groups.map((group) => (
                <section key={group.title} aria-label={group.title}>
                  <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {group.title}
                  </h3>
                  {group.note && <p className="mb-1 text-xs text-muted-foreground/80">{group.note}</p>}
                  {group.shortcuts.map((shortcut) => (
                    <ShortcutRow key={shortcut.label} shortcut={shortcut} mac={mac} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
