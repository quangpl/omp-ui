"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  HomeIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api-client";
import type { FsBrowseResult } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Crumb {
  label: string;
  path: string;
}

/** Splits an absolute path into clickable segments. Handles POSIX and Windows-style paths. */
function breadcrumbs(path: string): Crumb[] {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  const root = sep === "/" ? "/" : `${parts.shift() ?? ""}\\`;
  const crumbs: Crumb[] = [{ label: root, path: root }];
  let acc = root;
  for (const part of parts) {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/**
 * Browse the server's folders and pick one. Dialog on desktop, bottom sheet on mobile.
 * Starts at `initialPath` (falls back to the workspace folder if it can't be opened).
 */
export function FolderPicker({
  open,
  onOpenChange,
  initialPath,
  onSelect,
  title = "Choose a folder",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath?: string;
  onSelect: (path: string) => void;
  title?: string;
}) {
  const isMobile = useIsMobile();
  const [data, setData] = useState<FsBrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const requestId = useRef(0);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [mkdirPending, setMkdirPending] = useState(false);
  const [mkdirError, setMkdirError] = useState<string | null>(null);

  const resetNewFolder = useCallback(() => {
    setCreating(false);
    setNewName("");
    setMkdirPending(false);
    setMkdirError(null);
  }, []);

  const go = useCallback(async (path?: string, fallbackToRoot = false) => {
    const id = ++requestId.current;
    resetNewFolder();
    setLoading(true);
    setError(null);
    try {
      let result: FsBrowseResult;
      try {
        result = await api.fs.browse(path);
      } catch (err) {
        if (!fallbackToRoot || !path) throw err;
        result = await api.fs.browse();
      }
      if (id !== requestId.current) return;
      setData(result);
      setPathInput(result.path);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error && err.message ? err.message : "Couldn't open this folder.");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [resetNewFolder]);

  useEffect(() => {
    if (!open) {
      resetNewFolder();
      return;
    }
    setData(null);
    setPathInput(initialPath ?? "");
    void go(initialPath || undefined, true);
  }, [open, initialPath, go, resetNewFolder]);

  // Keep the deepest breadcrumb in view.
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [data?.path]);

  function choose() {
    if (!data) return;
    onSelect(data.path);
    onOpenChange(false);
  }

  async function createFolder() {
    const name = newName.trim();
    if (!data || !name || mkdirPending) return;
    // Any navigation while the request is in flight bumps the request id; ignore stale results then.
    const id = requestId.current;
    setMkdirPending(true);
    setMkdirError(null);
    try {
      const created = await api.fs.mkdir(data.path, name);
      if (id !== requestId.current) return;
      // Opening the new folder makes it the pick, so "Use this folder" confirms it right away.
      void go(created.path);
    } catch (err) {
      if (id !== requestId.current) return;
      setMkdirError(err instanceof Error && err.message ? err.message : "Couldn't create this folder.");
      setMkdirPending(false);
    }
  }

  // Escape closes the inline "New folder" row instead of the whole dialog.
  function handleEscape(e: KeyboardEvent) {
    if (!creating) return;
    e.preventDefault();
    if (!mkdirPending) resetNewFolder();
  }

  const description = "Tap a folder to open it, then choose “Use this folder”.";

  const newFolderRow = creating && data && (
    <form
      className="border-b p-2"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void createFolder();
      }}
    >
      <div className="flex items-center gap-2">
        <FolderPlusIcon className="ml-2.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          autoFocus
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            if (mkdirError) setMkdirError(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            if (!mkdirPending) resetNewFolder();
          }}
          placeholder="Folder name"
          aria-label="New folder name"
          aria-invalid={!!mkdirError}
          aria-describedby={mkdirError ? "folder-picker-mkdir-error" : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 md:h-9"
        />
        <Button type="submit" className="h-11 shrink-0 px-4 md:h-9" disabled={!newName.trim() || mkdirPending}>
          {mkdirPending && <Loader2Icon className="animate-spin" />}
          Create
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0 px-3 md:h-9"
          onClick={resetNewFolder}
          disabled={mkdirPending}
        >
          Cancel
        </Button>
      </div>
      {mkdirError && (
        <p
          id="folder-picker-mkdir-error"
          role="alert"
          className="mt-1.5 px-2.5 text-sm [overflow-wrap:anywhere] text-destructive"
        >
          {mkdirError}
        </p>
      )}
    </form>
  );

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex gap-2 px-4 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const value = pathInput.trim();
          if (value) void go(value);
        }}
      >
        <Input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder="Paste a folder path"
          aria-label="Folder path"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          className="h-11 min-w-0 flex-1 font-mono md:h-9"
        />
        <Button type="submit" variant="outline" className="h-11 px-4 md:h-9" disabled={!pathInput.trim()}>
          Go
        </Button>
      </form>

      <div className="flex items-center gap-1 border-y bg-muted/40 px-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 md:size-9"
          onClick={() => data?.parent && void go(data.parent)}
          disabled={!data?.parent || loading}
          aria-label="Up one folder"
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 md:size-9"
          onClick={() => data && void go(data.workspaceRoot)}
          disabled={!data || loading || data.path === data.workspaceRoot}
          aria-label="Go to the workspace folder"
        >
          <HomeIcon />
        </Button>
        <nav
          ref={crumbsRef}
          aria-label="Current folder"
          className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {data &&
            breadcrumbs(data.path).map((crumb, i, all) => {
              const last = i === all.length - 1;
              return (
                <span key={crumb.path} className="flex shrink-0 items-center">
                  {i > 1 && <ChevronRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />}
                  <button
                    type="button"
                    onClick={() => !last && void go(crumb.path)}
                    aria-current={last ? "location" : undefined}
                    className={cn(
                      "flex h-11 items-center rounded-md px-1.5 font-mono text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9",
                      last ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {crumb.label}
                  </button>
                </span>
              );
            })}
        </nav>
        {loading && <Loader2Icon className="mr-2 size-4 shrink-0 animate-spin text-muted-foreground" />}
        <Button
          type="button"
          variant="ghost"
          className="h-11 min-w-11 shrink-0 gap-1.5 px-2.5 md:h-9 md:min-w-0"
          onClick={() => setCreating(true)}
          disabled={!data || loading || !!error || creating}
          aria-label="New folder"
          title="New folder"
        >
          <FolderPlusIcon />
          <span className="hidden md:inline">New folder</span>
        </Button>
      </div>

      <div className="h-[42dvh] overflow-y-auto overscroll-contain md:h-80" aria-busy={loading}>
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-full text-sm [overflow-wrap:anywhere] text-destructive">{error}</p>
            <Button
              type="button"
              variant="outline"
              className="h-11 md:h-9"
              onClick={() => void go(data?.path)}
            >
              <RefreshCwIcon />
              Try again
            </Button>
          </div>
        ) : !data ? (
          <div className="space-y-1 p-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex h-12 items-center gap-3 px-2">
                <Skeleton className="size-5 rounded" />
                <Skeleton className="h-4 flex-1" style={{ maxWidth: `${40 + ((i * 17) % 45)}%` }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-full flex-col">
            {newFolderRow}
            {data.entries.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-6 text-center">
                <FolderIcon className="mb-2 size-8 text-muted-foreground/60" />
                <p className="text-sm font-medium">No folders inside</p>
                <p className="text-sm text-muted-foreground">You can use this folder as it is.</p>
              </div>
            ) : (
              <ul className={cn("p-2", loading && "opacity-60")}>
                {data.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => void go(entry.path)}
                      disabled={loading}
                      className="flex h-12 w-full items-center gap-3 rounded-lg px-2.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted"
                    >
                      <FolderIcon
                        className={cn("size-5 shrink-0", entry.isGitRepo ? "text-primary" : "text-muted-foreground")}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-[0.95rem]">{entry.name}</span>
                      {entry.isGitRepo && (
                        <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 text-xs font-medium text-primary">
                          <GitBranchIcon className="size-3" aria-hidden="true" />
                          Git
                        </span>
                      )}
                      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:flex-row-reverse md:items-center md:pb-4">
        <Button
          type="button"
          onClick={choose}
          disabled={!data || loading || !!error}
          className="h-12 min-w-0 flex-col items-stretch gap-0 px-4 text-base md:h-10 md:max-w-xs md:text-sm"
        >
          <span>Use this folder</span>
          {data && (
            <span className="truncate font-mono text-xs font-normal opacity-80 md:hidden">{data.path}</span>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          className="h-11 md:mr-auto md:h-10"
        >
          Cancel
        </Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          className="data-[vaul-drawer-direction=bottom]:max-h-[92dvh]"
          onEscapeKeyDown={handleEscape}
        >
          <DrawerHeader className="text-left">
            <DrawerTitle className="text-lg">{title}</DrawerTitle>
            <DrawerDescription>{description}</DrawerDescription>
          </DrawerHeader>
          {body}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-lg" onEscapeKeyDown={handleEscape}>
        <DialogHeader className="p-4 pr-12">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
