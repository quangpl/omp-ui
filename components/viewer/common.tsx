"use client";

// Shared pieces of the attachment viewer: file classification, URL helpers, the download/error
// fallback, and the size-capped byte loader the preview panes use.
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  BookOpenTextIcon,
  ClapperboardIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  ImageIcon,
  ImageOffIcon,
  NotebookTextIcon,
  PresentationIcon,
  SheetIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** A file or link the viewer can show: an app shared file or any URL. */
export interface Attachment {
  url: string;
  name: string;
  mime?: string | null;
  /** Bytes, when known (shared files list). */
  size?: number | null;
}

export type AttachmentKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "csv"
  | "notebook"
  | "text"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "ebook"
  | "archive"
  | "other";

/** Props every preview pane receives: the file, and the URL that downloads it. */
export interface PaneProps {
  attachment: Attachment;
  download: string;
}

/** Text-like files larger than this are never fetched into the viewer; it offers a download instead. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Binary formats parsed in the browser (Office, EPUB, archives) up to this size. */
export const MAX_BINARY_BYTES = 50 * 1024 * 1024;

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i;
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const CSV_EXT = /\.(csv|tsv)$/i;
const NOTEBOOK_EXT = /\.ipynb$/i;
const DOCUMENT_EXT = /\.(docx|docm)$/i;
const SPREADSHEET_EXT = /\.(xlsx|xlsm)$/i;
const PRESENTATION_EXT = /\.(pptx|pptm)$/i;
const EBOOK_EXT = /\.epub$/i;
const ARCHIVE_EXT = /\.(zip|jar|war|whl|nupkg|vsix|tar|tgz|tar\.gz)$/i;
const TEXT_EXT =
  /\.(txt|text|log|out|err|json|jsonc|json5|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|properties|xml|html?|css|scss|sass|less|[cm]?[jt]sx?|vue|svelte|astro|py|pyi|rb|go|rs|java|kt|kts|scala|swift|dart|c|h|cc|cpp|hpp|cs|fs|php|pl|lua|r|ex|exs|erl|hs|zig|nim|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|gql|proto|tf|hcl|gradle|cmake|mk|diff|patch|lock|rst|adoc|tex|bib|srt|vtt|svg)$/i;
/** Extension-less or dot files that are text. */
const TEXT_NAME =
  /(^|\/)(dockerfile|containerfile|makefile|gnumakefile|procfile|gemfile|rakefile|vagrantfile|jenkinsfile|license|licence|readme|changelog|authors|contributors|notice|copying|codeowners|\.gitignore|\.gitattributes|\.dockerignore|\.editorconfig|\.npmrc|\.nvmrc|\.prettierrc|\.eslintrc|\.env(\.[\w-]+)?)$/i;

const MIME_KIND: Record<string, AttachmentKind> = {
  "application/pdf": "pdf",
  "text/markdown": "markdown",
  "text/csv": "csv",
  "text/tab-separated-values": "csv",
  "application/x-ipynb+json": "notebook",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "presentation",
  "application/epub+zip": "ebook",
  "application/zip": "archive",
  "application/x-tar": "archive",
  "application/gzip": "archive",
  "application/json": "text",
};

/** `/api/v1/tasks/<id>/files/<path>` or `/api/v1/boards/<id>/files/<path>`, optionally absolute. */
const APP_FILE = /^(?:https?:\/\/[^/\s]+)?\/api\/v1\/(tasks|boards)\/([A-Za-z0-9_-]+)\/files\/([^?#\s]+)/;

/** "512 B", "1.2 KB", "34 MB"… */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`;
}

/** A file shared through this app (card or board files), if `url` points at one on this origin. */
export function appFileOf(url: string): { scope: "tasks" | "boards"; id: string; name: string } | null {
  const match = APP_FILE.exec(url);
  if (!match) return null;
  if (/^https?:/i.test(url) && (typeof window === "undefined" || new URL(url).host !== window.location.host)) {
    return null;
  }
  let name = match[3];
  try {
    name = name.split("/").map(decodeURIComponent).join("/");
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  return { scope: match[1] as "tasks" | "boards", id: match[2], name };
}

/** File name shown for a URL: its last path segment. */
export function nameFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, "");
  const last = path.slice(path.lastIndexOf("/") + 1) || path;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** How the viewer previews a file, from its MIME type (when known) and name. */
export function attachmentKind(attachment: Pick<Attachment, "url" | "name" | "mime">): AttachmentKind {
  const mime = attachment.mime?.toLowerCase().split(";")[0].trim() ?? "";
  const name = attachment.name || nameFromUrl(attachment.url);
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  // App-served SVGs are downloads (never rendered on this origin), so show their source.
  if (/\.svg$/i.test(name) && appFileOf(attachment.url)) return "text";
  if (IMAGE_EXT.test(name)) return "image";
  if (VIDEO_EXT.test(name)) return "video";
  if (AUDIO_EXT.test(name)) return "audio";
  if (MARKDOWN_EXT.test(name)) return "markdown";
  if (CSV_EXT.test(name)) return "csv";
  if (NOTEBOOK_EXT.test(name)) return "notebook";
  if (DOCUMENT_EXT.test(name)) return "document";
  if (SPREADSHEET_EXT.test(name)) return "spreadsheet";
  if (PRESENTATION_EXT.test(name)) return "presentation";
  if (EBOOK_EXT.test(name)) return "ebook";
  if (ARCHIVE_EXT.test(name)) return "archive";
  if (TEXT_EXT.test(name) || TEXT_NAME.test(name)) return "text";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (MIME_KIND[mime]) return MIME_KIND[mime];
  if (mime.startsWith("text/") || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
  return "other";
}

/** Whether a link should open in the viewer: app shared files, and media/PDF links anywhere. */
export function isViewableUrl(url: string): boolean {
  if (appFileOf(url)) return true;
  const kind = attachmentKind({ url, name: nameFromUrl(url) });
  return kind === "image" || kind === "video" || kind === "audio" || kind === "pdf";
}

/** Plain left click (no modifier): the viewer handles it; otherwise the browser opens the link. */
export function isPlainClick(event: ReactMouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  markdown: "Markdown",
  csv: "Table",
  notebook: "Notebook",
  text: "Text",
  document: "Word document",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  ebook: "EPUB",
  archive: "Archive",
  other: "File",
};

export const KIND_ICON: Record<AttachmentKind, LucideIcon> = {
  image: ImageIcon,
  video: ClapperboardIcon,
  audio: FileAudioIcon,
  pdf: FileTextIcon,
  markdown: FileTextIcon,
  csv: SheetIcon,
  notebook: NotebookTextIcon,
  text: FileCodeIcon,
  document: FileTextIcon,
  spreadsheet: FileSpreadsheetIcon,
  presentation: PresentationIcon,
  ebook: BookOpenTextIcon,
  archive: FileArchiveIcon,
  other: FileIcon,
};

/**
 * Centered card shown instead of a preview: the file name, size/type, why there is no preview,
 * and Open in new tab / Download (plus Try again when `onRetry` is given).
 */
export function ViewerFallback({
  attachment,
  download,
  message,
  broken,
  onRetry,
}: PaneProps & {
  message: string;
  broken?: boolean;
  onRetry?: () => void;
}) {
  const Icon = broken ? ImageOffIcon : KIND_ICON[attachmentKind(attachment)];
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-xl border bg-background text-muted-foreground">
        <Icon className="size-6" aria-hidden />
      </span>
      <div className="max-w-sm">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{attachment.name}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {[attachment.size != null ? formatSize(attachment.size) : null, attachment.mime].filter(Boolean).join(" · ")}
        </p>
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {onRetry && (
          <Button type="button" variant="ghost" className="h-11 md:h-8" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button asChild variant="outline" className="h-11 md:h-8">
          <a href={attachment.url} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon />
            Open in new tab
          </a>
        </Button>
        <Button asChild className="h-11 md:h-8">
          <a href={download} download="">
            <DownloadIcon />
            Download
          </a>
        </Button>
      </div>
    </div>
  );
}

/** Placeholder lines while a pane loads. */
export function PaneSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4" aria-busy="true">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-5/12" />
    </div>
  );
}

export type BytesState =
  | { status: "loading" }
  | { status: "ready"; bytes: Uint8Array }
  | { status: "too-large"; limit: number }
  | { status: "error"; message: string };

/** User-facing message for a failed file request. */
export function fetchErrorMessage(status: number): string {
  if (status === 404) return "The file was not found. It may have been moved or deleted.";
  if (status === 401 || status === 403) return "You don't have access to this file.";
  if (status >= 500) return `The server couldn't send the file (error ${status}).`;
  return `The server returned ${status}.`;
}

/**
 * Fetch a file's bytes, at most `limit` of them (known-too-large files are never requested;
 * a stream that overruns is cancelled). `retry` refetches after an error.
 */
export function useFileBytes(attachment: Attachment, limit: number): { state: BytesState; retry: () => void } {
  const tooLargeUpfront = attachment.size != null && attachment.size > limit;
  const [state, setState] = useState<BytesState>(() =>
    tooLargeUpfront ? { status: "too-large", limit } : { status: "loading" },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (tooLargeUpfront) {
      setState({ status: "too-large", limit });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        let res: Response;
        try {
          res = await fetch(attachment.url, { signal: controller.signal, credentials: "same-origin" });
        } catch (err) {
          if (controller.signal.aborted) return;
          throw new Error(
            `Network error: ${err instanceof Error ? err.message : String(err)}. Check your connection and try again.`,
          );
        }
        if (!res.ok) throw new Error(fetchErrorMessage(res.status));
        const declared = Number(res.headers.get("content-length"));
        if (declared > limit) {
          controller.abort();
          setState({ status: "too-large", limit });
          return;
        }
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
              await reader.cancel();
              setState({ status: "too-large", limit });
              return;
            }
            chunks.push(value);
          }
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        setState({ status: "ready", bytes });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => controller.abort();
  }, [attachment.url, limit, tooLargeUpfront, attempt]);

  return { state, retry: () => setAttempt((n) => n + 1) };
}

/**
 * Loads the file (up to `limit` bytes) and renders `children(bytes)` once it is in; meanwhile a
 * skeleton, and on failure or oversize a fallback with Download (and Try again for errors).
 */
export function WithFileBytes({
  attachment,
  download,
  limit,
  children,
}: PaneProps & { limit: number; children: (bytes: Uint8Array) => ReactNode }) {
  const { state, retry } = useFileBytes(attachment, limit);
  if (state.status === "too-large") {
    return (
      <ViewerFallback
        attachment={attachment}
        download={download}
        message={`This file is larger than ${formatSize(state.limit)}, too big to preview here; download it instead.`}
      />
    );
  }
  if (state.status === "error") {
    return (
      <ViewerFallback
        attachment={attachment}
        download={download}
        message={`Couldn't load the file. ${state.message}`}
        onRetry={retry}
      />
    );
  }
  if (state.status === "loading") return <PaneSkeleton />;
  return <>{children(state.bytes)}</>;
}
