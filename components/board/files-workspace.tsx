"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FileCode,
  FileWarning,
  FolderTree,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  RotateCw,
  Save,
} from "lucide-react";
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
import { FilePicker } from "@/components/board/file-picker";
import { FileTree } from "@/components/board/file-tree";
import { errorMessage } from "@/components/board/format";
import { formatSize } from "@/components/viewer/common";
import { ApiRequestError } from "@/lib/api-client";
import { type FileSource, fileSourceFolders, fileSourceKey, readSourceFile, writeSourceFile } from "@/lib/file-source";
import { modKeyLabel } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";

/** The file in the editor: `content` is the text on disk as of `mtimeMs`, `draft` the edited text. */
interface OpenFile {
  path: string;
  content: string;
  draft: string;
  mtimeMs: number;
  size: number;
}

interface LoadError {
  title: string;
  detail: string;
  /** Whether trying again can help (not for files the editor can never open). */
  retry: boolean;
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
 * File tree, file search and a code editor, optionally next to an agent chat (the card panel's
 * Files tab, the Files page). Side by side on desktop (chat under the editor below lg), stacked on
 * phones. `chat` renders the thread and gets `openFile` so "@" mentions open the file in the
 * editor; without it the editor takes the full width. Fills its parent's height on desktop.
 */
export function FilesWorkspace({
  source,
  isMobile,
  chat,
  chatTitle = "Agent chat",
  chatHint = "@ a file to open it here",
  onDirtyChange,
  className,
}: {
  source: FileSource;
  isMobile: boolean;
  chat?: (openFile: (path: string) => void) => ReactNode;
  chatTitle?: string;
  chatHint?: string;
  /** Name of the file with unsaved edits, or null once there are none (also on unmount). */
  onDirtyChange?: (dirtyFile: string | null) => void;
  className?: string;
}) {
  /** Path id of the file shown (loaded, loading or failed); null before the first pick. */
  const [target, setTarget] = useState<string | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  const [saving, setSaving] = useState(false);
  /** File waiting on the discard-changes confirmation. */
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  /** Phones: whether the collapsible tree is expanded (open until a file is picked from it). */
  const [treeOpen, setTreeOpen] = useState(true);
  // Platform modifier for the save shortcut hint; read after mount (navigator isn't there on the server).
  const [modKey, setModKey] = useState("Ctrl");
  useEffect(() => setModKey(modKeyLabel()), []);

  const loadAbortRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  // Callers may pass a fresh source object every render; effects follow its key instead.
  const sourceKey = fileSourceKey(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  // Latest state for the stable callbacks below (the chat and the tree keep one `openFile`).
  const latestRef = useRef({ target, file, error, sourceKey });
  latestRef.current = { target, file, error, sourceKey };

  const dirty = file !== null && file.draft !== file.content;
  const dirtyFile = file && dirty ? baseName(file.path) : null;

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => onDirtyChangeRef.current?.(dirtyFile), [dirtyFile]);
  useEffect(() => () => onDirtyChangeRef.current?.(null), []);

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
    setPendingPath(null);
    setTreeOpen(true);
  }, [sourceKey]);

  /** Reads `path` into the editor, dropping any draft; a newer load cancels this one. */
  const load = useCallback(
    (path: string) => {
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      setTarget(path);
      setError(null);
      setLoading(true);
      // A reload keeps the stale text on screen until the fresh copy arrives.
      setFile((current) => (current?.path === path ? current : null));
      readSourceFile(sourceRef.current, path, { signal: controller.signal })
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
    },
    [],
  );

  useEffect(() => () => loadAbortRef.current?.abort(), []);

  /** Opens `path` in the editor, asking first when that would drop unsaved edits. */
  const openFile = useCallback(
    (path: string) => {
      const { target: shown, file: current, error: failed } = latestRef.current;
      // The same file again is a no-op, unless it failed to load (then it's a retry).
      if (path === shown && !failed) return;
      if (current && current.draft !== current.content) {
        setPendingPath(path);
        return;
      }
      load(path);
    },
    [load],
  );

  const save = useCallback(async () => {
    const current = latestRef.current.file;
    if (!current || current.draft === current.content || savingRef.current) return;
    const { path, draft } = current;
    const name = baseName(path);
    const savedSourceKey = latestRef.current.sourceKey;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await writeSourceFile(sourceRef.current, { path, content: draft, baseMtimeMs: current.mtimeMs });
      // Edits typed while saving stay in the draft (still dirty); a switched source has moved on.
      if (latestRef.current.sourceKey === savedSourceKey) {
        setFile((f) => (f?.path === path ? { ...f, content: draft, mtimeMs: saved.mtimeMs, size: saved.size } : f));
      }
      toast.success(`Saved ${name}`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        toast.error(`${name} changed on disk`, {
          description: "Reload to get the new version (drops your edits), or copy your edits first.",
          action: {
            label: "Reload",
            onClick: () => {
              if (latestRef.current.target === path && latestRef.current.sourceKey === savedSourceKey) load(path);
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

  const revert = () => setFile((f) => (f ? { ...f, draft: f.content } : f));

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

  // Desktop chat: start at the newest message and follow new ones while scrolled to the bottom.
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const hasChat = chat !== undefined;
  useEffect(() => {
    const el = chatScrollRef.current;
    if (isMobile || !hasChat || !el) return;
    let stick = true;
    el.scrollTop = el.scrollHeight;
    const onScroll = () => {
      stick = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    const observer = new MutationObserver(() => {
      if (stick) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el, { childList: true, subtree: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [isMobile, hasChat]);

  const name = target ? baseName(target) : null;
  const shownPath = target ? displayPath(target, fileSourceFolders(source).extraFolders) : null;
  const nameStart = shownPath ? shownPath.lastIndexOf("/") + 1 : 0;

  const tree = (
    <FileTree
      source={source}
      selectedPath={target}
      onOpenFile={(path) => {
        if (isMobile) setTreeOpen(false);
        openFile(path);
      }}
    />
  );

  const pathLabel = shownPath ? (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="min-w-0 truncate font-mono" title={target ?? undefined}>
        <span className="text-muted-foreground">{shownPath.slice(0, nameStart)}</span>
        <span className="font-medium text-foreground">{shownPath.slice(nameStart)}</span>
      </span>
      {dirty && (
        <span aria-label="Unsaved changes" title="Unsaved changes" className="size-2 shrink-0 rounded-full bg-primary" />
      )}
      {loading && <LoaderCircle aria-label="Loading" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
      {file && !isMobile && (
        <span className="shrink-0 text-muted-foreground tabular-nums">{formatSize(file.size)}</span>
      )}
    </span>
  ) : (
    <span className="min-w-0 truncate text-xs text-muted-foreground">No file open</span>
  );

  const revertButton = (
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
  );

  const saveButton = (
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
  );

  let editorPane: ReactNode;
  if (file) {
    const path = file.path;
    editorPane = (
      <CodeEditor
        value={file.draft}
        path={path}
        onChange={(value) => setFile((f) => (f?.path === path ? { ...f, draft: value } : f))}
        onSave={() => void save()}
        className="h-full"
        aria-label={`Edit ${baseName(path)}`}
      />
    );
  } else if (loading) {
    editorPane = (
      <div aria-busy className="flex flex-col gap-2.5 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    );
  } else if (error && target) {
    editorPane = (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileWarning className="size-5" />
        </span>
        <p className="text-sm font-medium">{error.title}</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          <span className="font-mono">{name}</span> — {error.detail}
        </p>
        {error.retry && (
          <Button variant="outline" size="sm" className="mt-1 pressable max-md:h-11" onClick={() => load(target)}>
            <RotateCw />
            Try again
          </Button>
        )}
      </div>
    );
  } else {
    editorPane = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileCode className="size-5" />
        </span>
        <p className="text-sm font-medium">No file open</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {hasChat
            ? "Pick a file from the tree, search with Open file…, or mention one with @ in the chat."
            : "Pick a file from the tree, or search with Open file…"}
        </p>
      </div>
    );
  }

  const pendingName = pendingPath ? baseName(pendingPath) : "";
  const discardDialog = (
    <AlertDialog open={pendingPath !== null} onOpenChange={(open) => !open && setPendingPath(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes to {file ? baseName(file.path) : "this file"}?</AlertDialogTitle>
          <AlertDialogDescription>
            Opening {pendingName} drops your edits. Save first to keep them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="max-md:h-11">Keep editing</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="max-md:h-11"
            onClick={() => {
              if (pendingPath) load(pendingPath);
              setPendingPath(null);
            }}
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const chatHeader = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4 md:px-3">
      <MessageSquare aria-hidden className="size-4 text-muted-foreground" />
      <span className="shrink-0 text-sm font-medium">{chatTitle}</span>
      {chatHint && <span className="min-w-0 truncate text-xs text-muted-foreground">{chatHint}</span>}
    </div>
  );

  if (isMobile) {
    // Every section keeps its natural/fixed height (shrink-0) so the stack works in any parent: in a
    // height-constrained flex column (the /files page) the parent scrolls instead of squashing the editor.
    return (
      <div className={cn("flex shrink-0 flex-col", className)}>
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <FilePicker source={source} onPick={openFile} className="min-w-0 flex-1" />
          {revertButton}
          {saveButton}
        </div>
        {target && <div className="flex min-h-9 shrink-0 items-center border-b px-4">{pathLabel}</div>}
        <div className="shrink-0 border-b">
          <Button
            variant="ghost"
            className="h-11 w-full justify-between rounded-none px-4 font-medium"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen((open) => !open)}
          >
            <span className="flex items-center gap-2">
              <FolderTree className="text-muted-foreground" />
              Files
            </span>
            <ChevronDown className={cn("text-muted-foreground transition-transform", treeOpen && "rotate-180")} />
          </Button>
          {treeOpen && (
            <div className="max-h-[40dvh] overflow-auto overscroll-contain border-t">{tree}</div>
          )}
        </div>
        <div className={cn("min-w-0 shrink-0 overflow-hidden", chat ? "h-[55dvh] border-b" : "h-[70dvh]")}>
          {editorPane}
        </div>
        {chat && (
          <>
            {chatHeader}
            <div className="shrink-0">{chat(openFile)}</div>
          </>
        )}
        {discardDialog}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid h-full min-h-0",
        chat
          ? "grid-rows-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:grid-rows-1"
          : "grid-rows-1",
        className,
      )}
    >
      <section
        aria-label={source.kind === "board" ? "Project files" : "Files"}
        className="flex min-h-0 min-w-0 flex-col"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-2">
          <FilePicker source={source} onPick={openFile} className="shrink-0" />
          <div className="flex min-w-0 flex-1 items-center">{pathLabel}</div>
          {revertButton}
          {saveButton}
        </div>
        <div className="grid min-h-0 flex-1 grid-rows-1 md:grid-cols-[14rem_minmax(0,1fr)]">
          <div className="scrollbar-subtle min-h-0 overflow-auto overscroll-contain border-r">{tree}</div>
          <div className="min-h-0 min-w-0 overflow-hidden">{editorPane}</div>
        </div>
      </section>
      {chat && (
        <aside aria-label={chatTitle} className="flex min-h-0 min-w-0 flex-col border-t lg:border-t-0 lg:border-l">
          {chatHeader}
          <div ref={chatScrollRef} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {chat(openFile)}
          </div>
        </aside>
      )}
      {discardDialog}
    </div>
  );
}
