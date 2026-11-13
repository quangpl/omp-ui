"use client";

import { useState, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { ArrowUpRightIcon, DownloadIcon, FileXIcon, ImageOffIcon, PaperclipIcon } from "lucide-react";
import { openAttachment } from "@/components/attachment-viewer";
import { RichText } from "@/components/board/rich-text";
import { formatDateTime, formatRelative } from "@/components/board/format";
import { FOCUS_RING, cardHref, plural } from "@/components/home/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  attachmentKind,
  formatSize,
  isPlainClick,
  KIND_ICON,
  KIND_LABEL,
  type Attachment,
} from "@/components/viewer/common";
import { STATUS_LABELS, type ArtifactFile, type ArtifactResult, type TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const DOT_CLASS: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/50",
  in_progress: "bg-primary",
  done: "bg-success",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-[11px] font-medium text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", DOT_CLASS[status])} aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Forces a save dialog instead of an inline view. */
const downloadUrl = (file: ArtifactFile) => `${file.url.split(/[?#]/)[0]}?download=1`;

/** Label for a file: its last path segment (the full relative path goes in tooltips and accessible names). */
const baseName = (file: ArtifactFile) => file.name.slice(file.name.lastIndexOf("/") + 1);

function viewerClick(list: Attachment[], index: number) {
  return (event: ReactMouseEvent) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    openAttachment({ ...list[index], list, index });
  };
}

function ImageTile({ file, onClick }: { file: ArtifactFile; onClick: (event: ReactMouseEvent) => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      title={file.name}
      aria-label={`Preview ${file.name}`}
      onClick={onClick}
      className={cn(
        FOCUS_RING,
        "group/tile pressable flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card hover:border-foreground/20",
      )}
    >
      <span className="relative block aspect-[4/3] overflow-hidden bg-muted">
        {broken ? (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            <ImageOffIcon className="size-6" aria-hidden="true" />
          </span>
        ) : (
          // App-served files: native lazy loading, no image optimizer in between.
          <img
            src={file.url}
            alt={file.name}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className="size-full object-cover transition-transform duration-500 ease-(--ease-fluid) group-hover/tile:scale-[1.03] motion-reduce:transition-none"
          />
        )}
      </span>
      <span className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
        <span className="truncate font-medium">{baseName(file)}</span>
        {file.size !== null && (
          <span className="shrink-0 font-mono text-muted-foreground tabular-nums">{formatSize(file.size)}</span>
        )}
      </span>
    </a>
  );
}

function FileRow({ file, onClick }: { file: ArtifactFile; onClick: (event: ReactMouseEvent) => void }) {
  const kind = attachmentKind(file);
  const KindIcon = KIND_ICON[kind];
  return (
    <li className="flex min-w-0 items-center gap-1 py-1">
      <a
        href={file.url}
        target="_blank"
        rel="noopener noreferrer"
        title={file.name}
        aria-label={`Preview ${file.name}`}
        onClick={onClick}
        className={cn(FOCUS_RING, "pressable flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md px-2 hover:bg-muted md:min-h-10")}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
          <KindIcon className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{baseName(file)}</span>
          <span className="block text-xs text-muted-foreground">
            {KIND_LABEL[kind]}
            {file.size !== null && <span className="font-mono tabular-nums"> · {formatSize(file.size)}</span>}
          </span>
        </span>
      </a>
      <Button
        asChild
        variant="ghost"
        size="icon"
        className="size-11 shrink-0 text-muted-foreground md:size-8"
      >
        <a href={downloadUrl(file)} download="" aria-label={`Download ${file.name}`} title="Download">
          <DownloadIcon />
        </a>
      </Button>
    </li>
  );
}

function MissingRow({ file }: { file: ArtifactFile }) {
  return (
    <li
      className="flex min-h-11 min-w-0 items-center gap-3 px-2 py-1 text-muted-foreground md:min-h-10"
      aria-disabled="true"
      title={file.name}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed">
        <FileXIcon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm line-through decoration-muted-foreground/50">
          <span className="sr-only">{file.name}</span>
          <span aria-hidden="true">{baseName(file)}</span>
        </span>
        <span className="block text-xs">Unavailable: the file was moved or deleted</span>
      </span>
    </li>
  );
}

function Attachments({ files }: { files: ArtifactFile[] }) {
  // Missing files cannot be previewed, so the viewer only steps through the ones that exist.
  const available = files.filter((file) => file.size !== null);
  const list: Attachment[] = available.map((file) => ({ url: file.url, name: file.name, size: file.size }));
  const images = available.filter((file) => attachmentKind(file) === "image");
  const others = available.filter((file) => attachmentKind(file) !== "image");
  const missing = files.filter((file) => file.size === null);
  const clickFor = (file: ArtifactFile) => viewerClick(list, available.indexOf(file));

  return (
    <section aria-labelledby="artifact-attachments" className="flex flex-col gap-3">
      <h3 id="artifact-attachments" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <PaperclipIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        Attachments
        <span className="rounded-md bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground tabular-nums">
          {files.length}
        </span>
      </h3>
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
          {images.map((file) => (
            <ImageTile key={file.url} file={file} onClick={clickFor(file)} />
          ))}
        </div>
      )}
      {(others.length > 0 || missing.length > 0) && (
        <ul className="-mx-2 flex flex-col divide-y">
          {others.map((file) => (
            <FileRow key={file.url} file={file} onClick={clickFor(file)} />
          ))}
          {missing.map((file) => (
            <MissingRow key={file.url} file={file} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One card's final result: its last successful run summary and the files that summary delivers. */
export function ResultView({ result, now }: { result: ArtifactResult; now: number }) {
  return (
    <article className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg leading-snug font-semibold tracking-tight [overflow-wrap:anywhere] md:text-xl">
            {result.title}
          </h2>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <StatusBadge status={result.status} />
            <time dateTime={result.finishedAt} title={formatDateTime(result.finishedAt)}>
              Finished {formatRelative(result.finishedAt, now)}
            </time>
            <span aria-hidden="true">·</span>
            <span>{plural(result.attachments.length, "attachment")}</span>
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="h-11 shrink-0 self-start md:h-8">
          <Link href={cardHref({ boardId: result.boardId, id: result.taskId })}>
            Open card
            <ArrowUpRightIcon />
          </Link>
        </Button>
      </header>
      {result.attachments.length > 0 && <Attachments files={result.attachments} />}
      <section aria-labelledby="artifact-summary" className="flex flex-col gap-3">
        <h3 id="artifact-summary" className="text-sm font-semibold tracking-tight">
          Summary
        </h3>
        {/* Images render as chips here: the gallery above already shows them. */}
        <RichText text={result.summary} images="chip" className="max-w-[75ch] text-sm leading-relaxed" />
      </section>
    </article>
  );
}

export function ResultSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="flex flex-col gap-2 border-b pb-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-28" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-[4/3] w-full rounded-lg" />
          ))}
        </div>
      </div>
      <div className="flex max-w-[75ch] flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </div>
  );
}
