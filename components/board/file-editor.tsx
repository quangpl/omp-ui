"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode, FileWarning, LoaderCircle, RotateCcw, RotateCw, Save } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/board/code-editor";
import { errorMessage } from "@/components/board/format";
import { formatSize } from "@/components/viewer/common";
import { ApiRequestError } from "@/lib/api-client";
import { type FileSource, fileSourceFolders, fileSourceKey, readSourceFile, writeSourceFile } from "@/lib/file-source";
import { modKeyLabel } from "@/lib/hotkeys";
import type { FileOp, FileOpResult } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A file to edit: a path id inside a file source (the editor's default source or another, e.g. a card worktree). */
export interface EditorTarget {
  source: FileSource;
  path: string;
}

/** The file in the editor: `content` is the text on disk as of `mtimeMs`, `draft` the edited text. */
export interface OpenFile {
  path: string;
  content: string;
  draft: string;
  mtimeMs: number;
  size: number;
}

/** Why the target couldn't be opened. */
export interface LoadError {
  title: string;
  detail: string;
  /** Whether trying again can help (not for files the editor can never open). */
  retry: boolean;
}

/** Editor state and actions from `useFileEditor`, handed to the `FileEditor*` pieces. */
export interface FileEditor {
  /** File shown (loaded, loading or failed); null before the first pick. */
  target: EditorTarget | null;
  file: OpenFile | null;
  loading: boolean;
  error: LoadError | null;
  saving: boolean;
  dirty: boolean;
  /** Opens `path` in `source` (default: the hook's source); same target again is a no-op unless it failed; asks first (discard dialog) when that drops unsaved edits. */
  openFile: (path: string, source?: FileSource) => void;
  /** Re-reads the target from disk, dropping the draft. */
  reload: () => void;
  save: () => Promise<void>;
  revert: () => void;
  setDraft: (value: string) => void;
  /** Tree ops in the default source: follow renames, close deleted files. */
  onFileOp: (op: FileOp, result: FileOpResult) => void;
  /** File waiting on the discard-changes confirmation (shown by `FileEditorDiscardDialog`). */
  pending: EditorTarget | null;
  /** Drops the unsaved edits and opens `pending`. */
  confirmDiscard: () => void;
  /** Keeps the unsaved edits; `pending` is forgotten. */
  cancelDiscard: () => void;
}

/** Last segment of a path id ("src/app.ts" → "app.ts"). */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** Path id as shown: workdir files as they are, extra-folder files as `<folder name>/<rest>`. */
function displayPath(path: string, extraFolders: string[]): string {
  if (!path.startsWith("/")) return path;
  const folder = extraFolders.find((dir) => path.startsWith(`${dir.replace(/\/+$/, "")}/`));
  return folder ? `${baseName(folder)}/${path.slice(folder.replace(/\/+$/, "").length + 1)}` : path;
}

/** Whether two targets name the same file (sources compared by key). */
function sameTarget(a: EditorTarget | null, b: EditorTarget | null): boolean {
  if (!a || !b) return a === b;
  return a.path === b.path && fileSourceKey(a.source) === fileSourceKey(b.source);
}

function loadErrorOf(err: unknown): LoadError {
  const status = err instanceof ApiRequestError ? err.status : 0;
  switch (status) {
    case 413:
      return { title: "Too large to edit", detail: "The editor opens files up to 2 MB.", retry: false };
    case 415:
      return { title: "Binary file", detail: "Only text files can be edited here.", retry: false };
    case 404:
      return { title: "File not found", detail: "It may have been moved or deleted.", retry: true };
    default:
      return { title: "Couldn't open file", detail: errorMessage(err), retry: true };
  }
}

/**
 * State of one code editor: the file it shows, loading/saving, the unsaved draft and the
 * discard-changes confirmation. Files open from `source` unless `openFile` names another source.
 * Guards page unload while dirty; a different `source` (by key) starts with no file open.
 */
export function useFileEditor({
  source,
  onDirtyChange,
  onSaved,
}: {
  source: FileSource;
  /** Base name of the file with unsaved edits, or null (also on unmount). */
  onDirtyChange?: (name: string | null) => void;
  /** After a successful save (e.g. refresh the diff). */
  onSaved?: (target: EditorTarget) => void;
}): FileEditor {
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  const [saving, setSaving] = useState(false);
  /** File waiting on the discard-changes confirmation. */
  const [pending, setPending] = useState<EditorTarget | null>(null);

  const loadAbortRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  // Callers may pass a fresh source object every render; effects follow its key instead.
  const sourceKey = fileSourceKey(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  // Latest state for the stable callbacks below (the chat and the tree keep one `openFile`).
  const latestRef = useRef({ target, file, error, pending, sourceKey });
  latestRef.current = { target, file, error, pending, sourceKey };

  const dirty = file !== null && file.draft !== file.content;
  const dirtyFile = file && dirty ? baseName(file.path) : null;

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => onDirtyChangeRef.current?.(dirtyFile), [dirtyFile]);
  useEffect(() => () => onDirtyChangeRef.current?.(null), []);

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // A different source starts with no file open (callers confirm dropping unsaved edits first).
  const shownSourceRef = useRef(sourceKey);
  useEffect(() => {
    if (shownSourceRef.current === sourceKey) return;
    shownSourceRef.current = sourceKey;
    loadAbortRef.current?.abort();
    setTarget(null);
    setFile(null);
    setError(null);
    setLoading(false);
    setPending(null);
  }, [sourceKey]);

  /** Reads `next` into the editor, dropping any draft; a newer load cancels this one. */
  const load = useCallback((next: EditorTarget) => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    // A reload keeps the stale text on screen until the fresh copy arrives.
    const reloading = sameTarget(latestRef.current.target, next);
    setTarget(next);
    setError(null);
    setLoading(true);
    setFile((current) => (reloading && current?.path === next.path ? current : null));
    const { path } = next;
    readSourceFile(next.source, path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setFile({ path, content: data.content, draft: data.content, mtimeMs: data.mtimeMs, size: data.size });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setFile(null);
        setError(loadErrorOf(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => () => loadAbortRef.current?.abort(), []);

  const onFileOp = useCallback(
    (op: FileOp, result: FileOpResult) => {
      if (op.op !== "rename" && op.op !== "delete") return;
      const { target: shown, file: current, sourceKey: key } = latestRef.current;
      // Tree ops happen in the default source; a file from another source isn't affected.
      if (!shown || fileSourceKey(shown.source) !== key) return;
      const from = op.op === "rename" ? op.from : op.path;
      // A folder takes the open file with it.
      const folder = result.kind === "dir" ? (from.endsWith("/") ? from : `${from}/`) : null;
      if (folder ? !shown.path.startsWith(folder) : shown.path !== from) return;
      if (op.op === "rename") {
        const nextPath = folder
          ? `${result.path.replace(/\/*$/, "/")}${shown.path.slice(folder.length)}`
          : result.path;
        const next = { source: shown.source, path: nextPath };
        if (current?.path !== shown.path) {
          // Loading or failed: nothing to keep.
          load(next);
          return;
        }
        // Same text on disk under a new name: keep the draft and mtime.
        loadAbortRef.current?.abort();
        setLoading(false);
        setTarget(next);
        setFile((f) => (f?.path === shown.path ? { ...f, path: nextPath } : f));
        return;
      }
      loadAbortRef.current?.abort();
      setTarget(null);
      setFile(null);
      setError(null);
      setLoading(false);
      if (current && current.draft !== current.content) {
        toast.warning(`Unsaved edits to ${baseName(shown.path)} were discarded`);
      }
    },
    [load],
  );

  const openFile = useCallback(
    (path: string, from?: FileSource) => {
      const next = { source: from ?? sourceRef.current, path };
      const { target: shown, file: current, error: failed } = latestRef.current;
      // The same file again is a no-op, unless it failed to load (then it's a retry).
      if (sameTarget(shown, next) && !failed) return;
      if (current && current.draft !== current.content) {
        setPending(next);
        return;
      }
      load(next);
    },
    [load],
  );

  const reload = useCallback(() => {
    const shown = latestRef.current.target;
    if (shown) load(shown);
  }, [load]);

  const save = useCallback(async () => {
    const { file: current, target: shown } = latestRef.current;
    if (!current || !shown || current.draft === current.content || savingRef.current) return;
    const { path, draft } = current;
    const saved: EditorTarget = { source: shown.source, path };
    const name = baseName(path);
    savingRef.current = true;
    setSaving(true);
    try {
      const written = await writeSourceFile(saved.source, { path, content: draft, baseMtimeMs: current.mtimeMs });
      // Edits typed while saving stay in the draft (still dirty); a switched file or source has moved on.
      if (sameTarget(latestRef.current.target, saved)) {
        setFile((f) =>
          f?.path === path ? { ...f, content: draft, mtimeMs: written.mtimeMs, size: written.size } : f,
        );
      }
      toast.success(`Saved ${name}`);
      onSavedRef.current?.(saved);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        toast.error(`${name} changed on disk`, {
          description: "Reload to get the new version (drops your edits), or copy your edits first.",
          action: {
            label: "Reload",
            onClick: () => {
              if (sameTarget(latestRef.current.target, saved)) load(saved);
            },
          },
        });
      } else {
        toast.error(`Couldn't save ${name}`, { description: errorMessage(err) });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [load]);

  const revert = useCallback(() => setFile((f) => (f ? { ...f, draft: f.content } : f)), []);
  const setDraft = useCallback((value: string) => setFile((f) => (f ? { ...f, draft: value } : f)), []);

  const confirmDiscard = useCallback(() => {
    const next = latestRef.current.pending;
    if (next) load(next);
    setPending(null);
  }, [load]);
  const cancelDiscard = useCallback(() => setPending(null), []);

  // Closing or reloading the page would drop the draft.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return {
    target,
    file,
    loading,
    error,
    saving,
    dirty,
    openFile,
    reload,
    save,
    revert,
    setDraft,
    onFileOp,
    pending,
    confirmDiscard,
    cancelDiscard,
  };
}

/** Path (folder muted, name emphasised), dirty dot, spinner, size (desktop). "No file open" when none. */
export function FileEditorPathLabel({ editor, isMobile }: { editor: FileEditor; isMobile: boolean }) {
  const { target, file, dirty, loading } = editor;
  if (!target) return <span className="min-w-0 truncate text-xs text-muted-foreground">No file open</span>;
  const shownPath = displayPath(target.path, fileSourceFolders(target.source).extraFolders);
  const nameStart = shownPath.lastIndexOf("/") + 1;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="min-w-0 truncate font-mono" title={target.path}>
        <span className="text-muted-foreground">{shownPath.slice(0, nameStart)}</span>
        <span className="font-medium text-foreground">{shownPath.slice(nameStart)}</span>
      </span>
      {dirty && (
        <span aria-label="Unsaved changes" title="Unsaved changes" className="size-2 shrink-0 rounded-full bg-primary" />
      )}
      {loading && <LoaderCircle aria-label="Loading" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      {file && !isMobile && <span className="shrink-0 text-muted-foreground tabular-nums">{formatSize(file.size)}</span>}
    </span>
  );
}

/** Revert + Save buttons (Save tooltip shows ⌘/Ctrl S); icon-only touch-sized buttons on phones. */
export function FileEditorActions({ editor, isMobile }: { editor: FileEditor; isMobile: boolean }) {
  const { dirty, saving, revert, save } = editor;
  // Platform modifier for the save shortcut hint; read after mount (navigator isn't there on the server).
  const [modKey, setModKey] = useState("Ctrl");
  useEffect(() => setModKey(modKeyLabel()), []);

  return (
    <>
      <Button
        variant="ghost"
        size={isMobile ? "icon" : "sm"}
        className={cn("shrink-0 pressable", isMobile && "size-11 pressable-icon")}
        disabled={!dirty || saving}
        aria-label={isMobile ? "Revert changes" : undefined}
        title="Drop unsaved changes"
        onClick={revert}
      >
        <RotateCcw />
        {!isMobile && "Revert"}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size={isMobile ? "icon" : "sm"}
            className={cn("shrink-0 pressable", isMobile && "size-11 pressable-icon")}
            disabled={!dirty || saving}
            aria-label={isMobile ? "Save file" : undefined}
            onClick={() => void save()}
          >
            {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
            {!isMobile && "Save"}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Save to disk{" "}
          <KbdGroup>
            <Kbd>{modKey}</Kbd>
            <Kbd>S</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>
    </>
  );
}

/** CodeMirror for the open file / skeleton / load error with retry / empty state with `emptyHint`. Fills its parent (h-full). */
export function FileEditorPane({ editor, emptyHint }: { editor: FileEditor; emptyHint: string }) {
  const { file, loading, error, target } = editor;
  if (file) {
    return (
      <CodeEditor
        value={file.draft}
        path={file.path}
        onChange={editor.setDraft}
        onSave={() => void editor.save()}
        className="h-full"
        aria-label={`Edit ${baseName(file.path)}`}
      />
    );
  }
  if (loading) {
    return (
      <div aria-busy className="flex flex-col gap-2.5 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    );
  }
  if (error && target) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileWarning className="size-5" />
        </span>
        <p className="text-sm font-medium">{error.title}</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          <span className="font-mono">{baseName(target.path)}</span> — {error.detail}
        </p>
        {error.retry && (
          <Button variant="outline" size="sm" className="mt-1 pressable max-md:h-11" onClick={editor.reload}>
            <RotateCw />
            Try again
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <FileCode className="size-5" />
      </span>
      <p className="text-sm font-medium">No file open</p>
      <p className="max-w-xs text-xs text-muted-foreground">{emptyHint}</p>
    </div>
  );
}

/** "Discard unsaved changes to X?" dialog for openFile while dirty. Render once. */
export function FileEditorDiscardDialog({ editor }: { editor: FileEditor }) {
  const { pending, file, confirmDiscard, cancelDiscard } = editor;
  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && cancelDiscard()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes to {file ? baseName(file.path) : "this file"}?</AlertDialogTitle>
          <AlertDialogDescription>
            Opening {pending ? baseName(pending.path) : ""} drops your edits. Save first to keep them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="max-md:h-11">Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" className="max-md:h-11" onClick={confirmDiscard}>
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
