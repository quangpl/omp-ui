"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  Loader2Icon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AttachmentViewer, formatSize, isPlainClick, openAttachment, type Attachment } from "@/components/attachment-viewer";
import { errorMessage, formatDateTime, formatRelative } from "@/components/board/format";
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
import { Skeleton } from "@/components/ui/skeleton";
import { subscribeBoardStreams, useBoardStreams } from "@/hooks/use-board";
import { api, subscribeEvents, type FileScope } from "@/lib/api-client";
import type { ServerEvent, SharedFile, SharedFiles } from "@/lib/types";
import { cn, copyText } from "@/lib/utils";

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Files shared on a card (`scope` "tasks") or on a whole project (`scope` "boards"): list,
 * preview, download, delete, and upload by button or drag-and-drop. Refreshes live on
 * `files.updated`, reusing the board page's event stream when one is open.
 */
export function FilesPanel({
  scope,
  id,
  className,
  emptyHint,
}: {
  scope: FileScope;
  id: string;
  className?: string;
  emptyHint?: string;
}) {
  const [data, setData] = useState<SharedFiles | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState<SharedFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  /** Latest list request; older responses are dropped. */
  const requestRef = useRef(0);
  /** The listed files as viewer attachments (←/→ steps through them in list order). */
  const attachments = useMemo<Attachment[]>(
    () =>
      (data?.files ?? []).map((file) => ({
        url: `${api.files.url(scope, id, file.name)}?v=${encodeURIComponent(file.modifiedAt)}`,
        name: file.name,
        size: file.size,
      })),
    [data, scope, id],
  );

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await api.files.list(scope, id);
      if (request !== requestRef.current) return;
      setData(next);
      setLoadError(null);
    } catch (err) {
      if (request === requestRef.current) setLoadError(errorMessage(err));
    }
  }, [scope, id]);

  /** Apply a mutation response unless a newer list request already went out. */
  const apply = useCallback((next: SharedFiles) => {
    requestRef.current += 1;
    setData(next);
    setLoadError(null);
  }, []);

  useEffect(() => {
    setData(null);
    setLoadError(null);
    void load();
  }, [load]);

  // Live refresh: piggyback on the board page's stream when it covers these files.
  const streams = useBoardStreams();
  const shared = scope === "tasks" ? streams.length > 0 : streams.includes(id);
  useEffect(() => {
    const matches = (event: ServerEvent) =>
      event.type === "files.updated" &&
      (scope === "tasks" ? event.taskId === id : event.taskId === null && event.boardId === id);
    if (shared) {
      return subscribeBoardStreams((event) => {
        if (event.type === "stream.reconnected" || matches(event)) void load();
      });
    }
    return subscribeEvents(
      (event) => {
        if (matches(event)) void load();
      },
      { boardId: scope === "boards" ? id : undefined, onReconnect: () => void load() },
    );
  }, [shared, scope, id, load]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        apply(await api.files.upload(scope, id, file, file.name));
      } catch (err) {
        toast.error(`Couldn't upload ${file.name}`, { description: errorMessage(err) });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const remove = async (file: SharedFile) => {
    setDeleting(true);
    try {
      apply(await api.files.remove(scope, id, file.name));
      setConfirming(null);
    } catch (err) {
      toast.error(`Couldn't delete ${file.name}`, { description: errorMessage(err) });
    } finally {
      setDeleting(false);
    }
  };

  const copyFolder = async () => {
    if (!data) return;
    try {
      await copyText(data.folder);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy the folder path");
    }
  };

  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");

  return (
    <div
      className={cn(
        "relative flex flex-col gap-3 rounded-xl transition-colors",
        dragging && "bg-primary/5 ring-2 ring-primary/40",
        className,
      )}
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragging(false);
        void upload(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => inputRef.current?.click()}
          disabled={uploading > 0}
          className="h-11 md:h-8"
        >
          {uploading > 0 ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}
          {uploading > 0 ? `Uploading ${uploading}…` : "Upload files"}
        </Button>
        <span className="hidden text-xs text-muted-foreground md:inline">or drop files here</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void upload(files);
          }}
        />
      </div>

      {loadError && !data ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span className="min-w-0 [overflow-wrap:anywhere]">{loadError}</span>
          <Button type="button" variant="ghost" className="h-11 md:h-8" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : !data ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : data.files.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {emptyHint ?? "No files yet. Upload or drop files to share them."}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {data.files.map((file, index) => {
            const href = attachments[index].url;
            return (
              <li key={file.name} className="flex min-h-14 items-center gap-3 py-1.5 pr-1 pl-2">
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  title={`Preview ${file.name}`}
                  onClick={(event) => {
                    if (!isPlainClick(event)) return;
                    event.preventDefault();
                    openAttachment({ ...attachments[index], list: attachments, index });
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {IMAGE_FILE.test(file.name) ? (
                    <img
                      src={href}
                      alt=""
                      loading="lazy"
                      className="size-10 shrink-0 rounded-md border bg-muted object-cover"
                    />
                  ) : (
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <FileIcon className="size-4" aria-hidden />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" title={file.name}>
                      {file.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {formatSize(file.size)} ·{" "}
                      <time dateTime={file.modifiedAt} title={formatDateTime(file.modifiedAt)}>
                        {formatRelative(file.modifiedAt)}
                      </time>
                    </span>
                  </span>
                </a>
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0 text-muted-foreground md:size-8"
                >
                  <a href={api.files.url(scope, id, file.name, true)} download aria-label={`Download ${file.name}`}>
                    <DownloadIcon />
                  </a>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setConfirming(file)}
                  className="size-11 shrink-0 text-muted-foreground hover:text-destructive md:size-8"
                  aria-label={`Delete ${file.name}`}
                >
                  <Trash2Icon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {data && (
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">Folder:</span>
          <span className="min-w-0 truncate font-mono" title={data.folder}>
            {data.folder}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void copyFolder()}
            className="size-11 shrink-0 md:size-7"
            aria-label="Copy folder path"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-background/70 text-sm font-medium text-primary">
          Drop to upload
        </div>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && !deleting && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirming?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The file is removed from the server. Agents can no longer read it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="max-md:h-11" disabled={deleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="max-md:h-11"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                if (confirming) void remove(confirming);
              }}
            >
              {deleting ? "Deleting…" : "Delete file"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AttachmentViewer />
    </div>
  );
}
