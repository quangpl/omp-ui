"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, FolderTree, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  FileEditorActions,
  FileEditorDiscardDialog,
  FileEditorPane,
  FileEditorPathLabel,
  useFileEditor,
} from "@/components/board/file-editor";
import { FilePicker } from "@/components/board/file-picker";
import { FileTree } from "@/components/board/file-tree";
import { type FileSource, fileSourceKey } from "@/lib/file-source";
import { cn } from "@/lib/utils";

/**
 * File tree, file search and a code editor, optionally next to an agent chat (the Files page; the
 * card panel's Review tab composes the same editor pieces itself). Side by side on desktop (chat
 * under the editor below lg), stacked on phones. `chat` renders the thread and gets `openFile` so
 * "@" mentions open the file in the editor; without it the editor takes the full width. Fills its
 * parent's height on desktop.
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
  const editor = useFileEditor({ source, onDirtyChange });
  const { target, openFile: openInEditor } = editor;
  /** Phones: whether the collapsible tree is expanded (open until a file is picked from it). */
  const [treeOpen, setTreeOpen] = useState(true);

  const sourceKey = fileSourceKey(source);
  // A different source starts with no file open, so the tree opens again.
  useEffect(() => setTreeOpen(true), [sourceKey]);

  /** Opens a path id of the workspace's source (picker, chat mentions). */
  const openFile = useCallback((path: string) => openInEditor(path), [openInEditor]);

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

  const tree = (
    <FileTree
      source={source}
      selectedPath={target && fileSourceKey(target.source) === sourceKey ? target.path : null}
      onFileOp={editor.onFileOp}
      onOpenFile={(path) => {
        if (isMobile) setTreeOpen(false);
        openFile(path);
      }}
    />
  );

  const pathLabel = <FileEditorPathLabel editor={editor} isMobile={isMobile} />;
  const actions = <FileEditorActions editor={editor} isMobile={isMobile} />;
  const editorPane = (
    <FileEditorPane
      editor={editor}
      emptyHint={
        hasChat
          ? "Pick a file from the tree, search with Open file…, or mention one with @ in the chat."
          : "Pick a file from the tree, or search with Open file…"
      }
    />
  );
  const discardDialog = <FileEditorDiscardDialog editor={editor} />;

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
          {actions}
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
          {actions}
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
