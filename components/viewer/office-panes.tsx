"use client";

// Previews of Office and EPUB files, parsed in the browser into text and structure: Word documents
// as a page, workbooks as a grid per sheet, presentations as slide cards, e-books by chapter.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentBlocks } from "@/components/viewer/document-blocks";
import {
  MAX_BINARY_BYTES,
  PaneSkeleton,
  ViewerFallback,
  WithFileBytes,
  type PaneProps,
} from "@/components/viewer/common";
import type { DocBlock } from "@/lib/viewer/document";
import { readDocx, readEpub, readPptx, readXlsx, type Ebook, type Sheet, type Slide } from "@/lib/viewer/office";
import { openZip, type ZipArchive } from "@/lib/viewer/zip";
import { cn } from "@/lib/utils";

type ParseState<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; message: string };

/** A focusable scroll region filling the rest of a pane. */
const SCROLLER =
  "min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset";

/** Cell text that reads as a number (plain, grouped, currency, percent, scientific, accounting negatives). */
const NUMERIC = /^[-+(]?[$€£¥]?\s?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\s?%?\)?$/;

/**
 * Opens `bytes` as a zip and runs `read` on it, off the render path; results arriving after
 * unmount (or after `bytes` changed) are dropped.
 */
function Parsed<T>({
  attachment,
  download,
  bytes,
  noun,
  read,
  children,
}: PaneProps & {
  bytes: Uint8Array;
  noun: string;
  read: (zip: ZipArchive) => Promise<T>;
  children: (value: T) => ReactNode;
}) {
  const [state, setState] = useState<ParseState<T>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const value = await read(openZip(bytes));
        if (!cancelled) setState({ status: "ready", value });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, read]);

  if (state.status === "loading") return <PaneSkeleton />;
  if (state.status === "error") {
    return (
      <ViewerFallback
        attachment={attachment}
        download={download}
        message={`Couldn't preview this ${noun}: ${state.message}`}
      />
    );
  }
  return <>{children(state.value)}</>;
}

/** Pane root: the simplified-preview notice above the pane's own content. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-full flex-col overflow-hidden bg-background">
      <p className="shrink-0 truncate border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        Simplified preview: text and structure only. Download for full fidelity.
      </p>
      {children}
    </div>
  );
}

/** Word document (.docx): its text on a centered page. */
export function DocumentPane(props: PaneProps) {
  return (
    <WithFileBytes {...props} limit={MAX_BINARY_BYTES}>
      {(bytes) => (
        <Parsed {...props} bytes={bytes} noun="document" read={readDocx}>
          {(blocks) => <DocumentView blocks={blocks} />}
        </Parsed>
      )}
    </WithFileBytes>
  );
}

function DocumentView({ blocks }: { blocks: DocBlock[] }) {
  return (
    <Frame>
      <div tabIndex={0} className={cn(SCROLLER, "bg-muted/40 md:p-6")}>
        <article className="mx-auto min-h-full max-w-3xl bg-background p-6 shadow-sm md:min-h-0 md:rounded-sm md:p-10">
          <DocumentBlocks blocks={blocks} />
        </article>
      </div>
    </Frame>
  );
}

/** Workbook (.xlsx): one sheet at a time as a grid, with sheet tabs. */
export function SpreadsheetPane(props: PaneProps) {
  return (
    <WithFileBytes {...props} limit={MAX_BINARY_BYTES}>
      {(bytes) => (
        <Parsed {...props} bytes={bytes} noun="spreadsheet" read={readXlsx}>
          {(sheets) => <SpreadsheetView sheets={sheets} />}
        </Parsed>
      )}
    </WithFileBytes>
  );
}

/** Spreadsheet column label: 0 -> "A", 25 -> "Z", 26 -> "AA". */
function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function SpreadsheetView({ sheets }: { sheets: Sheet[] }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[Math.min(active, sheets.length - 1)];

  if (!sheet) {
    return (
      <Frame>
        <p className="p-6 text-center text-sm text-muted-foreground">This workbook has no sheets.</p>
      </Frame>
    );
  }

  const columns = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
  return (
    <Frame>
      {columns === 0 ? (
        <p className="min-h-0 flex-1 p-6 text-center text-sm text-muted-foreground">This sheet is empty.</p>
      ) : (
        // Keyed by sheet so switching tabs starts at the top-left corner.
        <div key={active} tabIndex={0} className={SCROLLER} aria-label={`Sheet ${sheet.name}`} role="region">
          <table className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-20 border-r border-b bg-muted" aria-hidden />
                {Array.from({ length: columns }, (_, c) => (
                  <th
                    key={c}
                    scope="col"
                    className="sticky top-0 z-10 min-w-12 border-r border-b bg-muted px-2 py-1 text-center font-medium text-muted-foreground"
                  >
                    {columnName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-r border-b bg-muted px-2 py-1 text-right font-normal text-muted-foreground tabular-nums"
                  >
                    {r + 1}
                  </th>
                  {Array.from({ length: columns }, (_, c) => {
                    const text = row[c] ?? "";
                    return (
                      <td
                        key={c}
                        title={text || undefined}
                        className={cn(
                          "max-w-[24rem] truncate border-r border-b px-2 py-1 whitespace-pre",
                          NUMERIC.test(text.trim()) && "text-right tabular-nums",
                        )}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sheet.truncated && (
        <p className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground">
          Large sheet: only the first 1,000 rows and 100 columns are shown. Download for the rest.
        </p>
      )}
      {sheets.length > 1 && (
        <div role="group" aria-label="Sheets" className="flex shrink-0 gap-1 overflow-x-auto border-t bg-muted/40 px-2 py-1">
          {sheets.map((s, i) => (
            <Button
              key={i}
              type="button"
              variant={i === active ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={i === active}
              onClick={() => setActive(i)}
              className={cn("h-11 max-w-48 md:h-7", i === active && "border-border bg-background")}
              title={s.name}
            >
              <span className="truncate">{s.name || `Sheet ${i + 1}`}</span>
            </Button>
          ))}
        </div>
      )}
    </Frame>
  );
}

/** Presentation (.pptx): slides as numbered cards with collapsible speaker notes. */
export function PresentationPane(props: PaneProps) {
  return (
    <WithFileBytes {...props} limit={MAX_BINARY_BYTES}>
      {(bytes) => (
        <Parsed {...props} bytes={bytes} noun="presentation" read={readPptx}>
          {(slides) => <PresentationView slides={slides} />}
        </Parsed>
      )}
    </WithFileBytes>
  );
}

function PresentationView({ slides }: { slides: Slide[] }) {
  return (
    <Frame>
      <div tabIndex={0} className={cn(SCROLLER, "bg-muted/40 p-3 md:p-6")}>
        <div className="mx-auto max-w-4xl">
          <p className="mb-3 text-xs text-muted-foreground">
            {slides.length === 1 ? "1 slide" : `${slides.length} slides`}
          </p>
          {slides.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">This presentation has no slides.</p>
          ) : (
            <ol className="flex flex-col gap-4 md:gap-6">
              {slides.map((slide, i) => (
                <li key={i} aria-label={`Slide ${i + 1}`}>
                  <section className="flex min-h-48 flex-col overflow-hidden rounded-lg border bg-background shadow-sm md:aspect-video md:min-h-0">
                    <header className="flex shrink-0 items-baseline gap-3 px-4 pt-4 md:px-8 md:pt-6">
                      <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">{i + 1}</span>
                      {slide.title && (
                        <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere] md:text-xl">
                          {slide.title}
                        </h2>
                      )}
                    </header>
                    <div
                      tabIndex={0}
                      className="min-h-0 flex-1 overflow-auto px-4 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset md:px-8 md:py-4"
                    >
                      {slide.blocks.length > 0 ? (
                        <DocumentBlocks blocks={slide.blocks} />
                      ) : (
                        !slide.title && <p className="text-sm text-muted-foreground">No text on this slide.</p>
                      )}
                    </div>
                  </section>
                  {slide.notes.length > 0 && (
                    <details className="mt-2 rounded-md border bg-background">
                      <summary className="cursor-pointer rounded-md px-3 py-3 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:py-1.5">
                        Speaker notes
                      </summary>
                      <DocumentBlocks blocks={slide.notes} className="px-3 pb-3" />
                    </details>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Frame>
  );
}

/** E-book (.epub): one chapter at a time with a chapter list. */
export function EbookPane(props: PaneProps) {
  return (
    <WithFileBytes {...props} limit={MAX_BINARY_BYTES}>
      {(bytes) => (
        <Parsed {...props} bytes={bytes} noun="e-book" read={readEpub}>
          {(ebook) => <EbookView ebook={ebook} fallbackTitle={props.attachment.name} />}
        </Parsed>
      )}
    </WithFileBytes>
  );
}

function EbookView({ ebook, fallbackTitle }: { ebook: Ebook; fallbackTitle: string }) {
  const [current, setCurrent] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { chapters } = ebook;
  const index = Math.min(current, Math.max(0, chapters.length - 1));
  const chapter = chapters[index];
  const titles = chapters.map((c, i) => c.title.trim() || `Chapter ${i + 1}`);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [index]);

  return (
    <Frame>
      <header className="flex shrink-0 flex-col gap-2 border-b px-4 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={ebook.title ?? fallbackTitle}>
            {ebook.title ?? fallbackTitle}
          </p>
          {ebook.author && <p className="truncate text-xs text-muted-foreground">{ebook.author}</p>}
        </div>
        {chapters.length > 1 && (
          <select
            aria-label="Chapter"
            value={index}
            onChange={(event) => setCurrent(Number(event.target.value))}
            className="h-11 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:hidden dark:bg-input/30"
          >
            {titles.map((title, i) => (
              <option key={i} value={i}>
                {title}
              </option>
            ))}
          </select>
        )}
      </header>
      {!chapter ? (
        <p className="min-h-0 flex-1 p-6 text-center text-sm text-muted-foreground">
          This e-book has no readable chapters.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          {chapters.length > 1 && (
            <nav aria-label="Chapters" className="hidden w-64 shrink-0 overflow-y-auto border-r p-2 md:block">
              <ol className="flex flex-col gap-0.5">
                {titles.map((title, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      aria-current={i === index ? "true" : undefined}
                      onClick={() => setCurrent(i)}
                      title={title}
                      className={cn(
                        "w-full truncate rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
                        i === index ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {title}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <div ref={scrollRef} tabIndex={0} className={SCROLLER}>
            <article className="mx-auto max-w-2xl px-4 py-6 md:px-8 md:py-10">
              <DocumentBlocks blocks={chapter.blocks} />
              {chapters.length > 1 && (
                <nav aria-label="Chapter navigation" className="mt-10 flex items-center justify-between gap-2 border-t pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 max-w-[48%] md:h-8"
                    disabled={index === 0}
                    onClick={() => setCurrent(index - 1)}
                    title={index > 0 ? titles[index - 1] : undefined}
                  >
                    <ChevronLeftIcon />
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {index + 1} / {chapters.length}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 max-w-[48%] md:h-8"
                    disabled={index === chapters.length - 1}
                    onClick={() => setCurrent(index + 1)}
                    title={index < chapters.length - 1 ? titles[index + 1] : undefined}
                  >
                    Next
                    <ChevronRightIcon />
                  </Button>
                </nav>
              )}
            </article>
          </div>
        </div>
      )}
    </Frame>
  );
}
