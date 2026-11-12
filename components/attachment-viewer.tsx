"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  ImageOffIcon,
  MessageSquareQuoteIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, copyText } from "@/lib/utils";

/** A file or link the viewer can show: an app shared file or any URL. */
export interface Attachment {
  url: string;
  name: string;
  mime?: string | null;
  /** Bytes, when known (shared files list). */
  size?: number | null;
}

export type AttachmentKind = "image" | "video" | "audio" | "pdf" | "text" | "other";

export interface OpenAttachmentRequest extends Attachment {
  /** Sibling attachments for ←/→ navigation; must contain this one (matched by URL). */
  list?: Attachment[];
  /** Index of this attachment in `list` (defaults to the first one with the same URL). */
  index?: number;
  /** Adds a "Feedback" action to the header (e.g. quote the attachment in the comment box). */
  onFeedback?: (attachment: Attachment) => void;
}

const OPEN_EVENT = "omp-ui:open-attachment";
/** Text larger than this is never fetched into the viewer; it offers a download instead. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i;
const TEXT_EXT =
  /\.(txt|md|markdown|log|json|jsonl|ndjson|csv|tsv|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|diff|patch|lock|svg)$/i;
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

export function attachmentKind(attachment: Pick<Attachment, "url" | "name" | "mime">): AttachmentKind {
  const mime = attachment.mime?.toLowerCase() ?? "";
  const name = attachment.name || nameFromUrl(attachment.url);
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  // App-served SVGs are downloads (never rendered on this origin), so show their source.
  if (/\.svg$/i.test(name) && appFileOf(attachment.url)) return "text";
  if (mime.startsWith("image/") || IMAGE_EXT.test(name)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXT.test(name)) return "video";
  if (mime.startsWith("audio/") || AUDIO_EXT.test(name)) return "audio";
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXT.test(name)) return "text";
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

/** Mounted viewers, newest last; only the newest one answers `openAttachment`. */
const hosts: number[] = [];
let nextHostId = 0;

/**
 * Open the attachment in the dialog viewer. Without a mounted `AttachmentViewer` it falls back to
 * a new tab so the click is never lost.
 */
export function openAttachment(request: OpenAttachmentRequest): void {
  if (hosts.length === 0) {
    window.open(request.url, "_blank", "noopener,noreferrer");
    return;
  }
  window.dispatchEvent(new CustomEvent<OpenAttachmentRequest>(OPEN_EVENT, { detail: request }));
}

interface ViewerState {
  list: Attachment[];
  index: number;
  onFeedback?: (attachment: Attachment) => void;
}

/**
 * Lightbox dialog for attachments: images (fit / 100% zoom, drag to pan), video, audio, PDF,
 * text and code (fetched up to 2 MB), anything else as metadata with a download. ←/→ move
 * between the attachments of the same list; Esc closes. Several may be mounted; the newest
 * mounted instance handles `openAttachment`.
 */
export function AttachmentViewer() {
  const [state, setState] = useState<ViewerState | null>(null);
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  /** Set when an action (Feedback) moves focus elsewhere; the dialog then skips restoring it. */
  const keepFocusRef = useRef(false);

  useEffect(() => {
    const id = ++nextHostId;
    hosts.push(id);
    const onOpen = (event: Event) => {
      if (hosts[hosts.length - 1] !== id) return;
      const { list, index, onFeedback, ...attachment } = (event as CustomEvent<OpenAttachmentRequest>).detail;
      const items = list && list.length > 0 ? list : [attachment];
      const at =
        index !== undefined && items[index]?.url === attachment.url
          ? index
          : Math.max(0, items.findIndex((item) => item.url === attachment.url));
      setState({ list: items, index: at, onFeedback });
      setZoomed(false);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      hosts.splice(hosts.indexOf(id), 1);
    };
  }, []);

  const step = useCallback((delta: number) => {
    setZoomed(false);
    setState((current) =>
      current && current.list.length > 1
        ? { ...current, index: (current.index + delta + current.list.length) % current.list.length }
        : current,
    );
  }, []);

  const current = state?.list[state.index] ?? null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        /* React events bubble through the portal into a mobile card drawer; keep its drag off. */
        data-vaul-no-drag
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0 sm:max-w-none md:h-[min(88vh,900px)] md:w-[min(92vw,1200px)] md:max-w-none",
          "max-md:inset-0 max-md:h-dvh max-md:w-screen max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:ring-0",
        )}
        onCloseAutoFocus={(event) => {
          if (!keepFocusRef.current) return;
          keepFocusRef.current = false;
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          // Keep the card panel's single-key shortcuts (J/K, R, S…) quiet while the viewer is up.
          if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation();
          if (event.repeat || event.nativeEvent.isComposing) return;
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          const target = event.target as HTMLElement;
          if (target.closest("video, audio, input, textarea, select")) return;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            step(-1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            step(1);
          } else if (event.key === "z" || event.key === "Z") {
            if (current && attachmentKind(current) === "image") setZoomed((z) => !z);
          }
        }}
      >
        {current && state ? (
          <ViewerBody
            key={current.url}
            attachment={current}
            zoomed={zoomed}
            onZoom={setZoomed}
            position={state.list.length > 1 ? `${state.index + 1} / ${state.list.length}` : null}
            onStep={state.list.length > 1 ? step : null}
            onFeedback={
              state.onFeedback
                ? () => {
                    keepFocusRef.current = true;
                    setOpen(false);
                    state.onFeedback?.(current);
                  }
                : null
            }
          />
        ) : (
          <>
            <DialogTitle className="sr-only">Attachment</DialogTitle>
            <DialogDescription className="sr-only">Attachment preview</DialogDescription>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ViewerBody({
  attachment,
  zoomed,
  onZoom,
  position,
  onStep,
  onFeedback,
}: {
  attachment: Attachment;
  zoomed: boolean;
  onZoom: (zoomed: boolean | ((zoomed: boolean) => boolean)) => void;
  position: string | null;
  onStep: ((delta: number) => void) | null;
  onFeedback: (() => void) | null;
}) {
  const kind = attachmentKind(attachment);
  const href = attachment.url;
  // Shared files force a save dialog with `?download=1`; other URLs download as they are.
  const download = appFileOf(href) ? `${href.split(/[?#]/)[0]}?download=1` : href;

  const copyLink = async () => {
    try {
      await copyText(new URL(href, window.location.href).href);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const meta = [
    attachment.size != null ? formatSize(attachment.size) : null,
    KIND_LABEL[kind],
    position,
  ].filter(Boolean);

  return (
    <>
      <header className="flex min-w-0 items-center gap-1 border-b py-1.5 pr-1.5 pl-3 max-md:pt-[max(0.375rem,env(safe-area-inset-top))]">
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-sm font-medium" title={attachment.name}>
            {attachment.name}
          </DialogTitle>
          <DialogDescription className="truncate text-xs text-muted-foreground">{meta.join(" · ")}</DialogDescription>
        </div>
        {onFeedback && (
          <Button type="button" variant="outline" size="sm" className="h-11 md:h-7" onClick={onFeedback}>
            <MessageSquareQuoteIcon />
            <span className="max-sm:sr-only">Feedback</span>
          </Button>
        )}
        {kind === "image" && (
          <HeaderButton
            label={zoomed ? "Fit to screen (Z)" : "Actual size (Z)"}
            onClick={() => onZoom((z) => !z)}
            className="max-md:hidden"
          >
            {zoomed ? <ZoomOutIcon /> : <ZoomInIcon />}
          </HeaderButton>
        )}
        <HeaderButton label="Copy link" onClick={() => void copyLink()} className="max-sm:hidden">
          <CopyIcon />
        </HeaderButton>
        <HeaderButton label="Open in new tab" href={href}>
          <ExternalLinkIcon />
        </HeaderButton>
        <HeaderButton label="Download" href={download} download>
          <DownloadIcon />
        </HeaderButton>
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close (Esc)"
            title="Close (Esc)"
            className="size-11 shrink-0 text-muted-foreground hover:text-foreground md:size-8"
          >
            <XIcon />
          </Button>
        </DialogClose>
      </header>

      <div className="relative min-h-0 flex-1 bg-muted/40">
        {kind === "image" ? (
          <ImageView attachment={attachment} zoomed={zoomed} onZoom={onZoom} download={download} />
        ) : kind === "video" ? (
          <MediaFrame>
            <video src={href} controls playsInline preload="metadata" className="max-h-full max-w-full rounded-md bg-black" />
          </MediaFrame>
        ) : kind === "audio" ? (
          <MediaFrame>
            <audio src={href} controls preload="metadata" className="w-full max-w-lg" />
          </MediaFrame>
        ) : kind === "pdf" ? (
          <iframe src={href} title={attachment.name} className="size-full border-0 bg-white" />
        ) : kind === "text" ? (
          <TextView attachment={attachment} download={download} />
        ) : (
          <Fallback attachment={attachment} download={download} message="No preview for this file type." />
        )}

        {onStep && (
          <>
            <StepButton side="left" onClick={() => onStep(-1)} />
            <StepButton side="right" onClick={() => onStep(1)} />
          </>
        )}
      </div>
    </>
  );
}

const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  text: "Text",
  other: "File",
};

function HeaderButton({
  label,
  onClick,
  href,
  download,
  className,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  download?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const classes = cn("size-11 shrink-0 text-muted-foreground hover:text-foreground md:size-8", className);
  if (href) {
    return (
      <Button asChild variant="ghost" size="icon" className={classes}>
        <a
          href={href}
          aria-label={label}
          title={label}
          {...(download ? { download: "" } : { target: "_blank", rel: "noopener noreferrer" })}
        >
          {children}
        </a>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className={classes}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function StepButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      aria-label={side === "left" ? "Previous attachment (←)" : "Next attachment (→)"}
      title={side === "left" ? "Previous (←)" : "Next (→)"}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 size-11 -translate-y-1/2 rounded-full border bg-background/85 shadow-sm backdrop-blur md:size-9",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      {side === "left" ? <ChevronLeftIcon /> : <ChevronRightIcon />}
    </Button>
  );
}

function MediaFrame({ children }: { children: React.ReactNode }) {
  return <div className="flex size-full items-center justify-center p-3 md:p-6">{children}</div>;
}

function ImageView({
  attachment,
  zoomed,
  onZoom,
  download,
}: {
  attachment: Attachment;
  zoomed: boolean;
  onZoom: (zoomed: boolean) => void;
  download: string;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /** Pointer drag in progress (100% view); `moved` tells a pan from a click. */
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  /** Point (fractions of the image) to center after switching to 100%. */
  const focusRef = useRef<{ fx: number; fy: number } | null>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    const img = imgRef.current;
    if (!zoomed || !scroller || !img) return;
    const focus = focusRef.current ?? { fx: 0.5, fy: 0.5 };
    focusRef.current = null;
    scroller.scrollLeft = focus.fx * img.naturalWidth - scroller.clientWidth / 2;
    scroller.scrollTop = focus.fy * img.naturalHeight - scroller.clientHeight / 2;
  }, [zoomed]);

  if (status === "error") {
    return (
      <Fallback attachment={attachment} download={download} message="This image couldn't be loaded." broken />
    );
  }

  return (
    <div
      ref={scrollRef}
      className={cn(
        "size-full touch-pan-x touch-pan-y",
        zoomed ? "cursor-grab overflow-auto active:cursor-grabbing" : "overflow-hidden",
      )}
      onPointerDown={(event) => {
        if (!zoomed || event.button !== 0 || !scrollRef.current) return;
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          left: scrollRef.current.scrollLeft,
          top: scrollRef.current.scrollTop,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || !scrollRef.current) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        scrollRef.current.scrollLeft = drag.left - dx;
        scrollRef.current.scrollTop = drag.top - dy;
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (drag && !drag.moved) onZoom(false);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      <div
        className={cn(
          "flex items-center justify-center",
          zoomed ? "min-h-full w-max min-w-full" : "size-full p-3 md:p-6",
        )}
      >
        {status === "loading" && <Skeleton className="absolute inset-6 m-auto size-48 max-h-[60%] max-w-[60%]" />}
        <img
          ref={imgRef}
          src={attachment.url}
          alt={attachment.name}
          draggable={false}
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
          onClick={(event) => {
            if (zoomed) return;
            const rect = event.currentTarget.getBoundingClientRect();
            focusRef.current = {
              fx: (event.clientX - rect.left) / rect.width,
              fy: (event.clientY - rect.top) / rect.height,
            };
            onZoom(true);
          }}
          className={cn(
            "select-none",
            zoomed
              ? "max-w-none"
              : "max-h-full max-w-full cursor-zoom-in rounded-sm object-contain shadow-sm",
            status !== "ready" && "opacity-0",
          )}
        />
      </div>
    </div>
  );
}

type TextState =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "too-large" }
  | { status: "error"; message: string };

function TextView({ attachment, download }: { attachment: Attachment; download: string }) {
  const [state, setState] = useState<TextState>(() =>
    attachment.size != null && attachment.size > MAX_TEXT_BYTES ? { status: "too-large" } : { status: "loading" },
  );
  const [attempt, setAttempt] = useState(0);
  const tooLargeUpfront = attachment.size != null && attachment.size > MAX_TEXT_BYTES;

  useEffect(() => {
    if (tooLargeUpfront) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const res = await fetch(attachment.url, { signal: controller.signal, credentials: "same-origin" });
        if (!res.ok) throw new Error(`The server answered ${res.status}`);
        const declared = Number(res.headers.get("content-length"));
        if (declared > MAX_TEXT_BYTES) {
          controller.abort();
          setState({ status: "too-large" });
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
            if (total > MAX_TEXT_BYTES) {
              await reader.cancel();
              setState({ status: "too-large" });
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
        let text = new TextDecoder().decode(bytes);
        if (/\.json$/i.test(attachment.name)) {
          try {
            text = JSON.stringify(JSON.parse(text), null, 2);
          } catch {
            // Show invalid JSON as is.
          }
        }
        setState({ status: "ready", text });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => controller.abort();
  }, [attachment.url, attachment.name, tooLargeUpfront, attempt]);

  if (state.status === "too-large") {
    return (
      <Fallback
        attachment={attachment}
        download={download}
        message={`This file is larger than ${formatSize(MAX_TEXT_BYTES)}; download it to read it.`}
      />
    );
  }
  if (state.status === "error") {
    return (
      <Fallback
        attachment={attachment}
        download={download}
        message={`Couldn't load the file: ${state.message}`}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (state.status === "loading") {
    return (
      <div className="flex flex-col gap-2 p-4" aria-busy="true">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-5/12" />
      </div>
    );
  }
  return (
    <pre
      tabIndex={0}
      className="size-full overflow-auto bg-background p-4 font-mono text-xs leading-relaxed whitespace-pre outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      {state.text || <span className="text-muted-foreground">(empty file)</span>}
    </pre>
  );
}

function Fallback({
  attachment,
  download,
  message,
  broken,
  onRetry,
}: {
  attachment: Attachment;
  download: string;
  message: string;
  broken?: boolean;
  onRetry?: () => void;
}) {
  const Icon = broken ? ImageOffIcon : FileIcon;
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
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
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
