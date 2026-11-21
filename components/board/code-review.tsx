"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Columns2,
  FileDiff,
  FolderGit2,
  FolderTree,
  FolderX,
  MessageSquare,
  Pencil,
  RefreshCw,
  Rows2,
  TextWrap,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  BaseNote,
  ChangesSkeleton,
  CopyButton,
  Counts,
  type DiffEntry,
  FileDiffBody,
  PathLabel,
  RefreshButton,
  RepoErrors,
  StateMessage,
  StatusLetter,
  type TaskDiffState,
  ToolButton,
  TruncatedNotice,
  diffEntries,
  useDiffSummary,
  useDiffViewPrefs,
} from "@/components/board/code-changes";
import {
  type EditorTarget,
  FileEditorActions,
  FileEditorDiscardDialog,
  FileEditorPane,
  FileEditorPathLabel,
  useFileEditor,
} from "@/components/board/file-editor";
import { FilePicker } from "@/components/board/file-picker";
import { FileTree } from "@/components/board/file-tree";
import { ReviewBar } from "@/components/board/review-bar";
import { type FileSource, fileSourceKey } from "@/lib/file-source";
import { isTypingTarget } from "@/lib/hotkeys";
import type { Board, Task, TaskReviewResult } from "@/lib/types";
import { cn } from "@/lib/utils";

type MainView = "diff" | "edit";
type NavMode = "changed" | "files";

const EMPTY_EDITOR_HINT = "Pick a file from the tree, search with Open file…, or mention one with @ in the chat.";

/**
 * Where a changed file is edited: workdir files by their relative path and extra-folder files by
 * their absolute path in the board's project files; any other folder is edited in place.
 */
function editorTargetOf(entry: DiffEntry, board: Board, source: FileSource): EditorTarget {
  const { repo, file } = entry;
  if (repo.folder === board.workdir) return { source, path: file.path };
  if (board.extraFolders.includes(repo.folder)) return { source, path: `${repo.folder}/${file.path}` };
  return { source: { kind: "folder", root: repo.folder }, path: file.path };
}

/**
 * The card panel's Review tab: the review decision bar, a file list (changed files or the whole
 * project tree), one changed file's diff or the editor, and the agent chat. Side by side on desktop
 * (chat under the diff below lg), stacked on phones. Fills its parent's height on desktop.
 * Alt+↓ / Alt+↑ step through the changed files while `visible`.
 */
export function CodeReview({
  task,
  board,
  source,
  diffState,
  active,
  visible,
  isMobile,
  onDirtyChange,
  onReviewed,
  chat,
}: {
  task: Task;
  board: Board;
  /** Board project files (tree, picker, default editor source). */
  source: FileSource;
  diffState: TaskDiffState;
  /** The card's agent is queued or running (the summary waits until it finishes). */
  active: boolean;
  /** Tab shown: Alt+↑/↓ keys work, the summary is fetched. */
  visible: boolean;
  isMobile: boolean;
  /** Base name of the file with unsaved edits, or null once there are none (also on unmount). */
  onDirtyChange: (name: string | null) => void;
  /** Called with the API result after an approve / request-changes decision. */
  onReviewed: (result: TaskReviewResult) => void;
  /** Renders the agent chat; `openFile` opens an "@" mentioned file in the editor. */
  chat: (openFile: (path: string) => void) => ReactNode;
}) {
  const { diff, error, loading, refresh } = diffState;
  const rootRef = useRef<HTMLDivElement>(null);
  const editor = useFileEditor({ source, onDirtyChange, onSaved: () => refresh() });
  const summary = useDiffSummary(task.id, diff, visible && !active);
  const [prefs, setPrefs] = useDiffViewPrefs();
  const split = prefs.split && !isMobile;

  const entries = useMemo(() => diffEntries(diff), [diff]);
  // Null until the user picks: follow the default (changed files in diff mode once there are any).
  const [view, setView] = useState<MainView | null>(null);
  const [nav, setNav] = useState<NavMode | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** Phones: whether the collapsible file list is expanded. */
  const [navOpen, setNavOpen] = useState(false);

  const noChanges = diff !== null && entries.length === 0;
  const shownView: MainView = view ?? (noChanges ? "edit" : "diff");
  const navMode: NavMode = nav ?? (noChanges ? "files" : "changed");
  // A file gone from a refreshed diff falls back to the first one.
  const selected = entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null;
  const selectedIndex = selected ? entries.indexOf(selected) : -1;

  const sourceKey = fileSourceKey(source);
  const editorTarget = editor.target;
  // The changed file shown in the editor, if any (offers the way back to its diff).
  const editedEntry = useMemo(() => {
    if (!editorTarget) return null;
    const targetKey = fileSourceKey(editorTarget.source);
    return (
      entries.find((entry) => {
        const target = editorTargetOf(entry, board, source);
        return target.path === editorTarget.path && fileSourceKey(target.source) === targetKey;
      }) ?? null
    );
  }, [editorTarget, entries, board, source]);
  const treeSelection = editorTarget && fileSourceKey(editorTarget.source) === sourceKey ? editorTarget.path : null;

  const openFile = editor.openFile;
  /** Opens a project file (tree, picker, chat "@") in the editor. */
  const openProjectFile = useCallback(
    (path: string) => {
      openFile(path);
      setView("edit");
    },
    [openFile],
  );

  const showDiff = (entry: DiffEntry) => {
    setSelectedKey(entry.key);
    setView("diff");
  };

  const editEntry = (entry: DiffEntry) => {
    const target = editorTargetOf(entry, board, source);
    setSelectedKey(entry.key);
    openFile(target.path, target.source);
    setView("edit");
  };

  const pickEntry = (entry: DiffEntry) => {
    if (isMobile) setNavOpen(false);
    if (shownView === "edit" && entry.file.status !== "D") editEntry(entry);
    else showDiff(entry);
  };

  // Alt+↓ / Alt+↑: next / previous changed file (J/K and [/] belong to the panel), stepping from
  // the file shown — the changed file open in the editor, else the selected diff.
  const stepRef = useRef<(delta: 1 | -1) => void>(() => undefined);
  stepRef.current = (delta) => {
    if (entries.length === 0) return;
    const fromIndex = shownView === "edit" && editedEntry ? entries.indexOf(editedEntry) : selectedIndex;
    const next =
      fromIndex === -1
        ? delta === 1
          ? 0
          : entries.length - 1
        : (fromIndex + delta + entries.length) % entries.length;
    const entry = entries[next];
    if (shownView === "edit" && entry === editedEntry) {
      setSelectedKey(entry.key);
      setView("edit");
    } else {
      showDiff(entry);
    }
  };
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !event.altKey) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const panel = rootRef.current?.closest("[role='dialog']");
      const target = event.target;
      if (!(target instanceof HTMLElement) || !(target === document.body || panel?.contains(target))) return;
      if (isTypingTarget(target)) return;
      event.preventDefault();
      stepRef.current(event.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  // Desktop chat: start at the newest message and follow new ones while scrolled to the bottom.
  const chatScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (isMobile || !el) return;
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
  }, [isMobile]);

  const gitRepos = diff ? diff.repos.filter((repo) => repo.isRepo) : [];
  const repoErrors = diff ? diff.repos.filter((repo) => repo.error) : [];
  const truncatedRepos = diff ? diff.repos.filter((repo) => repo.truncated) : [];
  const multi = (diff?.repos.length ?? 0) > 1;

  const navSwitch = (
    <div role="group" aria-label="Files to list" className="grid grid-cols-2 rounded-md border bg-muted/40 p-0.5">
      {(
        [
          { value: "changed", label: "Changed", count: entries.length },
          { value: "files", label: "All files", count: null },
        ] as const
      ).map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={navMode === option.value}
          onClick={() => setNav(option.value)}
          className={cn(
            "flex h-10 items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:h-7",
            navMode === option.value
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
          {option.count !== null && diff && <span className="tabular-nums text-muted-foreground">{option.count}</span>}
        </button>
      ))}
    </div>
  );

  let changedList: ReactNode;
  if (!diff || entries.length === 0) {
    changedList = (
      <p className="px-3 py-3 text-xs text-muted-foreground">
        {!diff
          ? error
            ? "Couldn't load the changes."
            : "Loading changes…"
          : gitRepos.length === 0
            ? "Not a git repository."
            : "No code changes yet."}
      </p>
    );
  } else {
    changedList = (
      <div className="flex flex-col p-1.5">
        {diff.repos.map((repo) => (
          <div key={repo.folder} className="flex flex-col">
            {multi && (
              <p className="flex items-center gap-1 truncate px-1.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                <FolderGit2 className="size-3.5 shrink-0" />
                {repo.name}/
              </p>
            )}
            {multi && repo.isRepo && (
              <p className="-mt-1 flex min-w-0 pr-1.5 pb-1 pl-6 text-[11px] text-muted-foreground">
                <BaseNote repo={repo} />
              </p>
            )}
            {!repo.isRepo && <p className="px-1.5 pb-1 text-xs text-muted-foreground">Not a git repository</p>}
            <ul className="flex flex-col">
              {entries
                .filter((entry) => entry.repo === repo)
                .map((entry) => {
                  const current = entry.key === selected?.key;
                  return (
                    <li key={entry.key}>
                      <button
                        type="button"
                        title={entry.file.path}
                        aria-current={current ? "true" : undefined}
                        onClick={() => pickEntry(entry)}
                        className={cn(
                          "flex min-h-11 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs hover:bg-accent md:min-h-7",
                          current && "bg-accent",
                        )}
                      >
                        <StatusLetter file={entry.file} />
                        <PathLabel path={entry.file.path} className="min-w-0 flex-1" />
                        <Counts additions={entry.file.additions} deletions={entry.file.deletions} compact />
                      </button>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  const tree = (
    <FileTree
      source={source}
      selectedPath={treeSelection}
      onFileOp={editor.onFileOp}
      onOpenFile={(path) => {
        if (isMobile) setNavOpen(false);
        openProjectFile(path);
      }}
    />
  );
  const navList = navMode === "changed" ? changedList : tree;

  let diffPane: ReactNode;
  /** A state message (loading, error, no changes) rather than a file's diff, which scrolls itself. */
  let diffPaneIsState = true;
  if (!diff) {
    diffPane = error ? (
      <StateMessage
        icon={TriangleAlert}
        tone="error"
        title="Couldn't load the changes"
        detail={error}
        action={<RefreshButton onClick={refresh} loading={loading} label="Try again" />}
      />
    ) : (
      <ChangesSkeleton />
    );
  } else if (gitRepos.length === 0) {
    const missing = diff.repos.find((repo) => repo.error);
    diffPane = (
      <StateMessage
        icon={FolderX}
        title="Not a git repository"
        detail={
          missing?.error ??
          `${diff.repos.map((repo) => `${repo.name}/`).join(", ")} ${diff.repos.length === 1 ? "is" : "are"} not tracked by git, so changes can't be shown.`
        }
        action={<RefreshButton onClick={refresh} loading={loading} />}
      />
    );
  } else if (!selected) {
    diffPane = (
      <div className="flex flex-col">
        <RepoErrors repos={repoErrors} className="px-3 pt-3" />
        <StateMessage
          icon={FileDiff}
          title="No code changes yet"
          detail={
            active
              ? "The agent is working; changed files appear here."
              : `Files the agent changes in ${gitRepos.map((repo) => `${repo.name}/`).join(", ")} appear here for review.`
          }
          action={<RefreshButton onClick={refresh} loading={loading} />}
        />
      </div>
    );
  } else {
    diffPaneIsState = false;
    const { file } = selected;
    diffPane = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "flex shrink-0 items-center gap-1 border-b px-2",
            isMobile ? "flex-wrap py-1" : "h-11",
          )}
        >
          <div className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-xs", isMobile && "basis-full px-2 py-1")}>
            <StatusLetter file={file} />
            {file.oldPath && file.oldPath !== file.path ? (
              <span className="flex min-w-0 items-center gap-1" title={`${file.oldPath} → ${file.path}`}>
                <PathLabel path={file.oldPath} className="min-w-0 text-muted-foreground" />
                <ArrowRight aria-label="renamed to" className="size-3 shrink-0 text-muted-foreground" />
                <PathLabel path={file.path} className="min-w-0" />
              </span>
            ) : (
              <PathLabel path={file.path} className="min-w-0" />
            )}
            <Counts additions={file.additions} deletions={file.deletions} />
            <CopyButton text={file.path} label="Copy path" />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {entries.length > 1 && (
              <>
                <ToolButton label="Previous file (Alt+↑)" onClick={() => stepRef.current(-1)}>
                  <ChevronUp />
                </ToolButton>
                <ToolButton label="Next file (Alt+↓)" onClick={() => stepRef.current(1)}>
                  <ChevronDown />
                </ToolButton>
              </>
            )}
            {!isMobile && (
              <ToolButton
                label={prefs.split ? "Unified view" : "Split view"}
                pressed={prefs.split}
                onClick={() => setPrefs({ split: !prefs.split })}
              >
                {prefs.split ? <Rows2 /> : <Columns2 />}
              </ToolButton>
            )}
            <ToolButton label="Wrap long lines" pressed={prefs.wrap} onClick={() => setPrefs({ wrap: !prefs.wrap })}>
              <TextWrap />
            </ToolButton>
            <ToolButton label="Refresh changes" onClick={refresh}>
              <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} />
            </ToolButton>
            {file.status !== "D" && (
              <Button
                variant="outline"
                size={isMobile ? "icon" : "sm"}
                className={cn("ml-1 shrink-0 pressable", isMobile && "size-11 pressable-icon")}
                aria-label={isMobile ? "Edit file" : undefined}
                title="Edit this file"
                onClick={() => editEntry(selected)}
              >
                <Pencil />
                {!isMobile && "Edit"}
              </Button>
            )}
          </div>
        </div>
        <div className="scrollbar-subtle min-h-0 flex-1 overflow-auto overscroll-contain">
          {(error || repoErrors.length > 0 || truncatedRepos.length > 0) && (
            <div className="flex flex-col gap-2 px-3 pt-3">
              {error && (
                <p role="status" className="flex items-center gap-1.5 text-xs text-destructive">
                  <TriangleAlert className="size-3.5" />
                  Couldn't refresh: {error}
                </p>
              )}
              <RepoErrors repos={repoErrors} />
              {truncatedRepos.length > 0 && <TruncatedNotice repos={truncatedRepos} />}
            </div>
          )}
          <FileDiffBody key={selected.key} file={file} split={split} wrap={prefs.wrap} />
        </div>
      </div>
    );
  }

  const diffButton = editedEntry && (
    <Button
      variant="ghost"
      size={isMobile ? "icon" : "sm"}
      className={cn("shrink-0 pressable", isMobile && "size-11 pressable-icon")}
      aria-label={isMobile ? "Show the diff" : undefined}
      title="Show this file's changes"
      onClick={() => showDiff(editedEntry)}
    >
      <FileDiff />
      {!isMobile && "Diff"}
    </Button>
  );

  const editPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex shrink-0 items-center gap-2 border-b", isMobile ? "min-h-11 px-3 py-1" : "h-11 px-2")}>
        <div className="flex min-w-0 flex-1 items-center">
          <FileEditorPathLabel editor={editor} isMobile={isMobile} />
        </div>
        {diffButton}
        <FileEditorActions editor={editor} isMobile={isMobile} />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <FileEditorPane editor={editor} emptyHint={EMPTY_EDITOR_HINT} />
      </div>
    </div>
  );

  // The one "Open file…" picker (⌘P/Ctrl P), in the always-visible nav header so the shortcut works
  // in both views; only one instance is mounted, or ⌘P would open two.
  const filePicker = (
    <FilePicker
      source={source}
      onPick={(path) => {
        if (isMobile) setNavOpen(false);
        openProjectFile(path);
      }}
      className="w-full"
    />
  );

  const main =
    shownView === "edit" ? (
      editPane
    ) : diffPaneIsState ? (
      <div className="scrollbar-subtle min-h-0 flex-1 overflow-auto overscroll-contain">{diffPane}</div>
    ) : (
      diffPane
    );

  const chatHeader = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4 md:px-3">
      <MessageSquare aria-hidden className="size-4 text-muted-foreground" />
      <span className="shrink-0 text-sm font-medium">Agent chat</span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">@ a file to open it here</span>
    </div>
  );

  const reviewBar = (
    <div className="shrink-0 border-b px-4 py-3">
      <ReviewBar task={task} diff={diff} summary={summary} active={active} isMobile={isMobile} onReviewed={onReviewed} />
    </div>
  );

  if (isMobile) {
    return (
      <div ref={rootRef} className="flex flex-col">
        {reviewBar}
        <div className="shrink-0 border-b px-3 py-2">{filePicker}</div>
        <div className="shrink-0 border-b">
          <Button
            variant="ghost"
            className="h-11 w-full justify-between rounded-none px-4 font-medium"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <span className="flex min-w-0 items-center gap-2">
              {navMode === "changed" ? (
                <FileDiff className="text-muted-foreground" />
              ) : (
                <FolderTree className="text-muted-foreground" />
              )}
              {navMode === "changed" ? "Changed files" : "All files"}
              {navMode === "changed" && diff && (
                <span className="text-xs text-muted-foreground tabular-nums">{entries.length}</span>
              )}
            </span>
            <ChevronDown className={cn("text-muted-foreground transition-transform", navOpen && "rotate-180")} />
          </Button>
          {navOpen && (
            <div className="flex flex-col gap-1 border-t">
              <div className="px-3 pt-2">{navSwitch}</div>
              <nav
                aria-label={navMode === "changed" ? "Changed files" : "Project files"}
                className="max-h-[40dvh] overflow-auto overscroll-contain"
              >
                {navList}
              </nav>
            </div>
          )}
        </div>
        <section aria-label="Review" className="flex h-[60dvh] min-w-0 shrink-0 flex-col overflow-hidden border-b">
          {main}
        </section>
        {chatHeader}
        <div className="shrink-0">{chat(openProjectFile)}</div>
        <FileEditorDiscardDialog editor={editor} />
      </div>
    );
  }

  return (
    <div ref={rootRef} className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      {reviewBar}
      <div className="grid min-h-0 grid-cols-[15rem_minmax(0,1fr)] grid-rows-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-cols-[15rem_minmax(0,1fr)_minmax(20rem,22rem)] lg:grid-rows-1">
        <div className="flex min-h-0 min-w-0 flex-col border-r">
          <div className="flex shrink-0 flex-col gap-2 border-b p-2">
            {filePicker}
            {navSwitch}
          </div>
          <nav
            aria-label={navMode === "changed" ? "Changed files" : "Project files"}
            className="scrollbar-subtle min-h-0 flex-1 overflow-auto overscroll-contain"
          >
            {navList}
          </nav>
          {navMode === "changed" && entries.length > 1 && (
            <p className="flex shrink-0 items-center gap-1 border-t px-3 py-2 text-[11px] text-muted-foreground">
              <Kbd>Alt</Kbd> <Kbd>↓</Kbd> / <Kbd>↑</Kbd> next / previous
            </p>
          )}
        </div>
        <section aria-label="Review" className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {main}
        </section>
        <aside
          aria-label="Agent chat"
          className="col-span-2 flex min-h-0 min-w-0 flex-col border-t lg:col-span-1 lg:border-t-0 lg:border-l"
        >
          {chatHeader}
          <div ref={chatScrollRef} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {chat(openProjectFile)}
          </div>
        </aside>
      </div>
      <FileEditorDiscardDialog editor={editor} />
    </div>
  );
}
