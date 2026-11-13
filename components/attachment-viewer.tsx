"use client";

import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ListIcon,
  MessageSquareQuoteIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  appFileOf,
  attachmentKind,
  fetchErrorMessage,
  formatSize,
  KIND_ICON,
  KIND_LABEL,
  MAX_TEXT_BYTES,
  PaneSkeleton,
  useFileBytes,
  ViewerFallback,
  WithFileBytes,
  type Attachment,
  type AttachmentKind,
  type PaneProps,
} from "@/components/viewer/common";
import { cn, copyText } from "@/lib/utils";

// Preview panes load on demand so the parsers only ship when such a file is opened.
const MarkdownPane = lazy(() => import("@/components/viewer/text-panes").then((m) => ({ default: m.MarkdownPane })));
const CsvPane = lazy(() => import("@/components/viewer/text-panes").then((m) => ({ default: m.CsvPane })));
const NotebookPane = lazy(() => import("@/components/viewer/text-panes").then((m) => ({ default: m.NotebookPane })));
const DocumentPane = lazy(() =>
  import("@/components/viewer/office-panes").then((m) => ({ default: m.DocumentPane })),
);
const SpreadsheetPane = lazy(() =>
  import("@/components/viewer/office-panes").then((m) => ({ default: m.SpreadsheetPane })),
);
const PresentationPane = lazy(() =>
  import("@/components/viewer/office-panes").then((m) => ({ default: m.PresentationPane })),
);
const EbookPane = lazy(() => import("@/components/viewer/office-panes").then((m) => ({ default: m.EbookPane })));
const ArchivePane = lazy(() => import("@/components/viewer/archive-pane").then((m) => ({ default: m.ArchivePane })));

export interface OpenAttachmentRequest extends Attachment {
  /** Sibling attachments for ←/→ navigation; must contain this one (matched by URL). */
  list?: Attachment[];
  /** Index of this attachment in `list` (defaults to the first one with the same URL). */
  index?: number;
  /** Adds a "Feedback" action to the header (e.g. quote the attachment in the comment box). */
  onFeedback?: (attachment: Attachment) => void;
}

const OPEN_EVENT = "omp-ui:open-attachment";

/** Mounted viewers, newest last; only the newest one answers `openAttachment`. */
const hosts: number[] = [];
let nextHostId = 0;

/** Bytes sniffed for NUL characters when deciding whether a file is text. */
const SNIFF_NUL_BYTES = 8000;
/** Bytes that must be valid UTF-8 for an unknown file to be shown as text. */
const SNIFF_UTF8_BYTES = 64 * 1024;

/** Swipe gesture: minimum horizontal travel (px), dominance over vertical travel, maximum duration (ms). */
const SWIPE_MIN_DX = 60;
const SWIPE_RATIO = 1.5;
const SWIPE_MAX_MS = 600;
/** Touches starting this close to the bottom of a video/audio element are on its controls. */
const MEDIA_CONTROLS_PX = 64;

/** Keys inside these elements belong to them (seeking, typing, menu/tab navigation), not the viewer. */
const OWN_KEYS_SELECTOR =
  "video, audio, input, textarea, select, [contenteditable='true'], [role='menu'], [role='tablist'], [role='radiogroup']";

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

/** Shared files force a save dialog with `?download=1`; other URLs download as they are. */
function downloadUrlOf(href: string): string {
  return appFileOf(href) ? `${href.split(/[?#]/)[0]}?download=1` : href;
}

/** Start a download of `url` through a temporary `<a download>`. */
function triggerDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

interface ViewerState {
  list: Attachment[];
  index: number;
  onFeedback?: (attachment: Attachment) => void;
}

/**
 * Lightbox dialog for attachments. Previews: images (fit / 100% zoom, drag to pan), video, audio,
 * PDF, Markdown (rendered), CSV/TSV tables, Jupyter notebooks, Word (.docx), Excel (.xlsx),
 * PowerPoint (.pptx), EPUB, archives (zip family, tar, tar.gz contents), text and code (up to
 * 2 MB); unknown files are sniffed and shown as text when they are, otherwise metadata with a
 * download. A pane that fails (parser crash, chunk load error) falls back to the download card.
 *
 * Keys: ←/→ previous/next attachment of the same list, Home/End first/last, D download,
 * Z actual size / fit (images), Esc closes. On touch screens a horizontal swipe steps through
 * images, video, audio and unpreviewable files; long lists get a file switcher in the header.
 * Several viewers may be mounted; the newest mounted instance handles `openAttachment`.
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

  const jump = useCallback((index: number) => {
    setZoomed(false);
    setState((current) =>
      current && index >= 0 && index < current.list.length && index !== current.index
        ? { ...current, index }
        : current,
    );
  }, []);

  const current = state?.list[state.index] ?? null;
  const many = state != null && state.list.length > 1;

  /** The previous and next attachments (each once, never the current one), for preloading. */
  const neighbours = useMemo(() => {
    if (!state || state.list.length < 2) return [];
    const count = state.list.length;
    const indexes = new Set([(state.index - 1 + count) % count, (state.index + 1) % count]);
    indexes.delete(state.index);
    return [...indexes].map((i) => state.list[i]);
  }, [state]);

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
          if (target.closest(OWN_KEYS_SELECTOR)) return;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            step(-1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            step(1);
          } else if (event.key === "Home" || event.key === "End") {
            // Single files keep Home/End for scrolling the pane.
            if (!state || !many) return;
            event.preventDefault();
            jump(event.key === "Home" ? 0 : state.list.length - 1);
          } else if (event.key === "d" || event.key === "D") {
            if (!current) return;
            event.preventDefault();
            triggerDownload(downloadUrlOf(current.url));
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
            position={many ? `${state.index + 1} / ${state.list.length}` : null}
            onStep={many ? step : null}
            switcher={many ? { list: state.list, index: state.index, onSelect: jump } : null}
            neighbours={neighbours}
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

/** Whether `target` (or an ancestor below `container`) scrolls sideways, so a swipe there is a scroll. */
function scrollsHorizontally(target: Element, container: Element): boolean {
  for (let el: Element | null = target; el && el !== container; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
  }
  return false;
}

/** Whether a touch at `clientY` on `target` lands on native video/audio controls (seek bar, volume). */
function onMediaControls(target: Element, clientY: number): boolean {
  const media = target.closest("video, audio");
  return media != null && clientY > media.getBoundingClientRect().bottom - MEDIA_CONTROLS_PX;
}

function ViewerBody({
  attachment,
  zoomed,
  onZoom,
  position,
  onStep,
  switcher,
  neighbours,
  onFeedback,
}: {
  attachment: Attachment;
  zoomed: boolean;
  onZoom: (zoomed: boolean | ((zoomed: boolean) => boolean)) => void;
  position: string | null;
  onStep: ((delta: number) => void) | null;
  switcher: { list: Attachment[]; index: number; onSelect: (index: number) => void } | null;
  /** Previous/next attachments; images among them are preloaded once the current image is in. */
  neighbours: Attachment[];
  onFeedback: (() => void) | null;
}) {
  const kind = attachmentKind(attachment);
  const KindIcon = KIND_ICON[kind];
  const href = attachment.url;
  const download = downloadUrlOf(href);
  /** Touch that may become a swipe: start point and time. */
  const swipeRef = useRef<{ x: number; y: number; time: number } | null>(null);
  // Panes with their own horizontal gestures (PDF viewer, tables, zoomed images) keep them.
  const swipeEnabled =
    onStep != null && ((kind === "image" && !zoomed) || kind === "video" || kind === "audio" || kind === "other");

  const copyLink = async () => {
    try {
      await copyText(new URL(href, window.location.href).href);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const preloadNeighbours = () => {
    for (const item of neighbours) {
      if (attachmentKind(item) !== "image") continue;
      const image = new Image();
      image.src = item.url;
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
        <KindIcon className="mr-1.5 size-4 shrink-0 text-muted-foreground max-md:hidden" aria-hidden />
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
        {switcher && <FileSwitcher {...switcher} />}
        {kind === "image" && (
          <HeaderButton
            label={zoomed ? "Fit to screen (Z)" : "Actual size (Z)"}
            keyShortcuts="Z"
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
        <HeaderButton label="Download (D)" keyShortcuts="D" href={download} download>
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

      <div
        className="relative min-h-0 flex-1 bg-muted/40"
        onTouchStart={(event) => {
          swipeRef.current = null;
          if (!swipeEnabled || event.touches.length !== 1) return;
          const touch = event.touches[0];
          const target = event.target as Element;
          if (onMediaControls(target, touch.clientY) || scrollsHorizontally(target, event.currentTarget)) return;
          swipeRef.current = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
        }}
        onTouchEnd={(event) => {
          const start = swipeRef.current;
          swipeRef.current = null;
          if (!start || !onStep || event.touches.length > 0) return;
          const touch = event.changedTouches[0];
          if (!touch || event.timeStamp - start.time > SWIPE_MAX_MS) return;
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (Math.abs(dx) > SWIPE_MIN_DX && Math.abs(dx) > SWIPE_RATIO * Math.abs(dy)) onStep(dx < 0 ? 1 : -1);
        }}
        onTouchCancel={() => {
          swipeRef.current = null;
        }}
      >
        <PaneErrorBoundary key={attachment.url} attachment={attachment} download={download}>
          <Suspense fallback={<PaneSkeleton />}>
            {kind === "image" ? (
              <ImageView
                attachment={attachment}
                zoomed={zoomed}
                onZoom={onZoom}
                onLoaded={preloadNeighbours}
                download={download}
              />
            ) : (
              <KindPane kind={kind} attachment={attachment} download={download} />
            )}
          </Suspense>
        </PaneErrorBoundary>

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

/** The preview for every kind but images (which need the zoom state). */
function KindPane({ kind, attachment, download }: PaneProps & { kind: Exclude<AttachmentKind, "image"> }) {
  const props = { attachment, download };
  switch (kind) {
    case "video":
    case "audio":
      return <MediaView kind={kind} {...props} />;
    case "pdf":
      return <PdfView {...props} />;
    case "markdown":
      return <MarkdownPane {...props} />;
    case "csv":
      return <CsvPane {...props} />;
    case "notebook":
      return <NotebookPane {...props} />;
    case "text":
      return <TextView {...props} />;
    case "document":
      return <DocumentPane {...props} />;
    case "spreadsheet":
      return <SpreadsheetPane {...props} />;
    case "presentation":
      return <PresentationPane {...props} />;
    case "ebook":
      return <EbookPane {...props} />;
    case "archive":
      return <ArchivePane {...props} />;
    case "other":
      return <SniffView {...props} />;
  }
}

/** Catches a pane that throws (parser bug, failed chunk load) and shows the download card instead. */
class PaneErrorBoundary extends Component<PaneProps & { children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <ViewerFallback
          attachment={this.props.attachment}
          download={this.props.download}
          message="Something went wrong while previewing this file."
        />
      );
    }
    return this.props.children;
  }
}

/** Header menu listing every file of the list, for jumping around long lists. */
function FileSwitcher({
  list,
  index,
  onSelect,
}: {
  list: Attachment[];
  index: number;
  onSelect: (index: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Jump to file"
          title="Jump to file"
          className="size-11 shrink-0 text-muted-foreground hover:text-foreground max-sm:hidden md:size-8"
        >
          <ListIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup value={String(index)} onValueChange={(value) => onSelect(Number(value))}>
          {list.map((item, i) => {
            const Icon = KIND_ICON[attachmentKind(item)];
            return (
              <DropdownMenuRadioItem key={`${i}:${item.url}`} value={String(i)} title={item.name}>
                <Icon className="text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate">{item.name}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HeaderButton({
  label,
  keyShortcuts,
  onClick,
  href,
  download,
  className,
  children,
}: {
  label: string;
  /** `aria-keyshortcuts` value, e.g. "D". */
  keyShortcuts?: string;
  onClick?: () => void;
  href?: string;
  download?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn("size-11 shrink-0 text-muted-foreground hover:text-foreground md:size-8", className);
  if (href) {
    return (
      <Button asChild variant="ghost" size="icon" className={classes}>
        <a
          href={href}
          aria-label={label}
          aria-keyshortcuts={keyShortcuts}
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
      aria-keyshortcuts={keyShortcuts}
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
      aria-keyshortcuts={side === "left" ? "ArrowLeft" : "ArrowRight"}
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

function MediaFrame({ children }: { children: ReactNode }) {
  return <div className="flex size-full items-center justify-center p-3 md:p-6">{children}</div>;
}

/** Native video/audio player; a format the browser can't play falls back to the download card. */
function MediaView({ kind, attachment, download }: PaneProps & { kind: "video" | "audio" }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <ViewerFallback
        attachment={attachment}
        download={download}
        message={`This ${kind} couldn't be played. Your browser may not support its format.`}
      />
    );
  }
  return (
    <MediaFrame>
      {kind === "video" ? (
        <video
          src={attachment.url}
          controls
          playsInline
          preload="metadata"
          onError={() => setFailed(true)}
          className="max-h-full max-w-full rounded-md bg-zinc-950"
        />
      ) : (
        <audio
          src={attachment.url}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          className="w-full max-w-lg"
        />
      )}
    </MediaFrame>
  );
}

/** Whether `url` is served by this app's origin (relative, or same host), so it can be probed. */
function isSameOrigin(url: string): boolean {
  if (appFileOf(url)) return true;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

type ProbeState = { status: "probing" } | { status: "ok" } | { status: "error"; message: string };

/**
 * PDF in the browser's viewer. Same-origin files are probed first (one byte via Range) so a
 * missing or forbidden file shows the fallback instead of the server's error body in the frame.
 */
function PdfView({ attachment, download }: PaneProps) {
  const probe = isSameOrigin(attachment.url);
  const [state, setState] = useState<ProbeState>(() => (probe ? { status: "probing" } : { status: "ok" }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!probe) return;
    const controller = new AbortController();
    setState({ status: "probing" });
    void (async () => {
      let res: Response;
      try {
        res = await fetch(attachment.url, {
          method: "GET",
          headers: { range: "bytes=0-0" },
          credentials: "same-origin",
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: `Network error: ${err instanceof Error ? err.message : String(err)}. Check your connection and try again.`,
        });
        return;
      }
      res.body?.cancel().catch(() => {});
      if (controller.signal.aborted) return;
      setState(res.ok ? { status: "ok" } : { status: "error", message: fetchErrorMessage(res.status) });
    })();
    return () => controller.abort();
  }, [attachment.url, probe, attempt]);

  if (state.status === "probing") return <PaneSkeleton />;
  if (state.status === "error") {
    return (
      <ViewerFallback
        attachment={attachment}
        download={download}
        message={`Couldn't load the file. ${state.message}`}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  return <iframe src={attachment.url} title={attachment.name} className="size-full border-0 bg-white" />;
}

function ImageView({
  attachment,
  zoomed,
  onZoom,
  onLoaded,
  download,
}: {
  attachment: Attachment;
  zoomed: boolean;
  onZoom: (zoomed: boolean) => void;
  /** Called once the image has loaded. */
  onLoaded: () => void;
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
      <ViewerFallback attachment={attachment} download={download} message="This image couldn't be loaded." broken />
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
          onLoad={() => {
            setStatus("ready");
            onLoaded();
          }}
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

/** Plain text in a scrollable, focusable monospace block. */
function TextContent({ text }: { text: string }) {
  return (
    <pre
      tabIndex={0}
      className="size-full overflow-auto bg-background p-4 font-mono text-xs leading-relaxed whitespace-pre outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      {text || <span className="text-muted-foreground">(empty file)</span>}
    </pre>
  );
}

/** Text and code files (up to 2 MB); JSON is pretty-printed. */
function TextView({ attachment, download }: PaneProps) {
  return (
    <WithFileBytes attachment={attachment} download={download} limit={MAX_TEXT_BYTES}>
      {(bytes) => <TextFile attachment={attachment} download={download} bytes={bytes} />}
    </WithFileBytes>
  );
}

function TextFile({ attachment, download, bytes }: PaneProps & { bytes: Uint8Array }) {
  const text = useMemo(() => {
    const decoded = new TextDecoder().decode(bytes);
    if (decoded.slice(0, 8 * 1024).includes("\0")) return null;
    if (!/\.json$/i.test(attachment.name)) return decoded;
    try {
      return JSON.stringify(JSON.parse(decoded), null, 2);
    } catch {
      // Show invalid JSON as is.
      return decoded;
    }
  }, [bytes, attachment.name]);

  if (text === null) {
    return (
      <ViewerFallback
        attachment={attachment}
        download={download}
        message="This looks like a binary file; no preview available."
      />
    );
  }
  return <TextContent text={text} />;
}

/** Whether the bytes look like UTF-8 text: no NUL early on and a valid UTF-8 head. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, SNIFF_NUL_BYTES).includes(0)) return false;
  try {
    // `stream` tolerates a multi-byte character split at the end of the slice.
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, SNIFF_UTF8_BYTES), { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Unknown file types: shown as text when the content is text (up to 2 MB), else the download card. */
function SniffView({ attachment, download }: PaneProps) {
  const { state, retry } = useFileBytes(attachment, MAX_TEXT_BYTES);
  const text = useMemo(
    () => (state.status === "ready" && looksLikeText(state.bytes) ? new TextDecoder().decode(state.bytes) : null),
    [state],
  );

  if (state.status === "loading") return <PaneSkeleton />;
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
  if (text === null) {
    return <ViewerFallback attachment={attachment} download={download} message="No preview for this file type." />;
  }
  return <TextContent text={text} />;
}
