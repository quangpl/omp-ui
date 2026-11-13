"use client";

import { useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Annotation, Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

export interface CodeEditorProps {
  value: string;
  /** Path id of the open file; picks the language and resets the doc when it changes. */
  path: string;
  onChange: (value: string) => void;
  /** Mod-S. */
  onSave?: () => void;
  readOnly?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** Marks doc replacements coming from props so they are not echoed through onChange. */
const external = Annotation.define<boolean>();

/** Colors come from the app's CSS variables, so `.dark` on <html> restyles it for free. */
const appTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "inherit",
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 55%, transparent)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
  },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklch, var(--primary) 14%, transparent)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--primary) 22%, transparent)",
    outline: "none",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--destructive) 22%, transparent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    border: "1px solid var(--border)",
    color: "var(--muted-foreground)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "calc(var(--radius) - 2px)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-panels": {
    backgroundColor: "var(--muted)",
    color: "var(--foreground)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-textfield": {
    backgroundColor: "var(--background)",
    border: "1px solid var(--input)",
    borderRadius: "calc(var(--radius) - 4px)",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--background)",
    border: "1px solid var(--border)",
    borderRadius: "calc(var(--radius) - 4px)",
  },
});

function themeExtension(dark: boolean): Extension {
  return [
    EditorView.theme({}, { dark }),
    syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle),
  ];
}

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

function labelExtension(label: string | undefined): Extension {
  return label ? EditorView.contentAttributes.of({ "aria-label": label }) : [];
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * CodeMirror 6 editor. Uncontrolled inside: user edits flow out through onChange, while a
 * new `path` (fresh doc + history) or a `value` that differs from the doc (load/revert)
 * replaces the content. Fills its container's height.
 */
export function CodeEditor({
  value,
  path,
  onChange,
  onSave,
  readOnly = false,
  className,
  "aria-label": ariaLabel,
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Path the current EditorState was built for. */
  const pathRef = useRef(path);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  const compartments = useRef({
    language: new Compartment(),
    theme: new Compartment(),
    readOnly: new Compartment(),
    label: new Compartment(),
  }).current;

  /** Full extension list for a new EditorState, compartments set from the current props. */
  const extensionsRef = useRef<() => Extension[]>(null!);
  extensionsRef.current = () => [
    basicSetup,
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSaveRef.current?.();
          return true;
        },
      },
      {
        // Leave the editor so the surrounding sheet's hotkeys / Escape take over.
        key: "Escape",
        run: (view) => {
          view.contentDOM.blur();
          return true;
        },
      },
      indentWithTab,
    ]),
    appTheme,
    compartments.language.of([]),
    compartments.theme.of(themeExtension(dark)),
    compartments.readOnly.of(readOnlyExtension(readOnly)),
    compartments.label.of(labelExtension(ariaLabel)),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (update.transactions.some((tr) => tr.annotation(external))) return;
      onChangeRef.current(update.state.doc.toString());
    }),
  ];

  // Create the view once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: value, extensions: extensionsRef.current() }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props are synced by the effects below
  }, []);

  // New file: fresh state (doc, selection at 0, no undo history, scroll to top).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || pathRef.current === path) return;
    pathRef.current = path;
    view.setState(EditorState.create({ doc: value, extensions: extensionsRef.current() }));
    view.scrollDOM.scrollTop = 0;
    view.scrollDOM.scrollLeft = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value is read only on path change
  }, [path]);

  // External reset (load / revert / reload from disk) of the same file.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.head, value.length) },
      // Not undoable: undoing a load would otherwise empty the editor.
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  // Language, loaded lazily per file name; stale loads are dropped.
  useEffect(() => {
    let cancelled = false;
    const view = viewRef.current;
    if (!view) return;
    const desc = LanguageDescription.matchFilename(languages, basename(path));
    if (!desc) {
      view.dispatch({ effects: compartments.language.reconfigure([]) });
      return;
    }
    if (desc.support) {
      view.dispatch({ effects: compartments.language.reconfigure(desc.support) });
      return;
    }
    view.dispatch({ effects: compartments.language.reconfigure([]) });
    desc
      .load()
      .then((support) => {
        if (cancelled || viewRef.current !== view || pathRef.current !== path) return;
        view.dispatch({ effects: compartments.language.reconfigure(support) });
      })
      .catch(() => {
        // Unknown/failed mode: stay plain text.
      });
    return () => {
      cancelled = true;
    };
  }, [path, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.theme.reconfigure(themeExtension(dark)) });
  }, [dark, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.readOnly.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.label.reconfigure(labelExtension(ariaLabel)) });
  }, [ariaLabel, compartments]);

  return (
    <div
      ref={hostRef}
      data-vaul-no-drag
      className={cn("h-full min-h-0 overflow-hidden font-mono text-base md:text-[13px]", className)}
    />
  );
}
