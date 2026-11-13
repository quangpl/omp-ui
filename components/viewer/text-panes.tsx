"use client";

// Previews for text-based documentation formats: rendered Markdown, CSV/TSV tables, and Jupyter
// notebooks. Each loads the file as text (capped at MAX_TEXT_BYTES) and renders React elements only.
import { useMemo, useState, type ReactNode } from "react";
import { RichText } from "@/components/board/rich-text";
import { MAX_TEXT_BYTES, ViewerFallback, WithFileBytes, type PaneProps } from "@/components/viewer/common";
import { parseDelimited } from "@/lib/viewer/csv";
import { parseNotebook, type Notebook, type NotebookCell, type NotebookOutput } from "@/lib/viewer/notebook";
import { cn } from "@/lib/utils";

/** Keyboard-scrollable region: focusable, with the same ring as the plain text view. */
const SCROLL_FOCUS = "outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset";
const SOURCE_PRE = "font-mono text-xs leading-relaxed whitespace-pre";

/** Two-or-more-way segmented switch (Preview / Source…); each button reports aria-pressed. */
function ViewToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label="View" className="inline-flex shrink-0 rounded-md border bg-muted/40 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-10 rounded-sm px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:h-7 md:px-2.5",
            option.value === value
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Sticky strip above a pane's content: summary on the left, view toggle on the right. */
function TopBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-20 flex shrink-0 items-center gap-3 border-b bg-background px-3 py-1.5">
      {children}
    </div>
  );
}

/** The raw file text, scrollable and focusable, like the plain text view. */
function SourceView({ text }: { text: string }) {
  return (
    <pre tabIndex={0} className={cn("min-h-0 flex-1 overflow-auto p-4", SOURCE_PRE, SCROLL_FOCUS)}>
      {text || <span className="text-muted-foreground">(empty file)</span>}
    </pre>
  );
}

const MARKDOWN_VIEWS = [
  { value: "preview" as const, label: "Preview" },
  { value: "source" as const, label: "Source" },
];

function MarkdownView({ bytes }: { bytes: Uint8Array }) {
  const text = useMemo(() => new TextDecoder().decode(bytes), [bytes]);
  const [view, setView] = useState<"preview" | "source">("preview");
  return (
    <div className="flex size-full flex-col overflow-auto bg-background">
      <TopBar>
        <span className="min-w-0 flex-1" />
        <ViewToggle options={MARKDOWN_VIEWS} value={view} onChange={setView} />
      </TopBar>
      {view === "source" ? (
        <SourceView text={text} />
      ) : (
        <div tabIndex={0} className={cn("min-h-0 flex-1 overflow-auto", SCROLL_FOCUS)}>
          <div className="mx-auto max-w-3xl p-4 md:p-6">
            {text.trim() ? (
              <RichText text={text} className="text-sm leading-relaxed" />
            ) : (
              <p className="text-sm text-muted-foreground">(empty file)</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Markdown rendered as rich text, with a Preview / Source toggle. */
export function MarkdownPane({ attachment, download }: PaneProps) {
  return (
    <WithFileBytes attachment={attachment} download={download} limit={MAX_TEXT_BYTES}>
      {(bytes) => <MarkdownView bytes={bytes} />}
    </WithFileBytes>
  );
}

const CSV_VIEWS = [
  { value: "table" as const, label: "Table" },
  { value: "source" as const, label: "Source" },
];

function CsvView({ bytes, delimiter }: { bytes: Uint8Array; delimiter: string }) {
  const text = useMemo(() => new TextDecoder().decode(bytes), [bytes]);
  const [view, setView] = useState<"table" | "source">("table");
  const { rows, truncated } = useMemo(() => parseDelimited(text, { delimiter }), [text, delimiter]);
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const [header, ...body] = rows;
  return (
    <div className="flex size-full flex-col overflow-auto bg-background">
      <TopBar>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {body.length.toLocaleString()}
          {truncated ? "+" : ""} {body.length === 1 && !truncated ? "row" : "rows"} · {columns.toLocaleString()}{" "}
          {columns === 1 ? "column" : "columns"}
        </span>
        <ViewToggle options={CSV_VIEWS} value={view} onChange={setView} />
      </TopBar>
      {view === "source" ? (
        <SourceView text={text} />
      ) : !header ? (
        <p className="p-4 text-sm text-muted-foreground">(empty file)</p>
      ) : (
        <>
          <div tabIndex={0} className={cn("min-h-0 flex-1 overflow-auto", SCROLL_FOCUS)}>
            <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="sticky top-0 left-0 z-10 border-r border-b bg-background px-2 py-1.5 text-right font-normal text-muted-foreground"
                  >
                    <span className="sr-only">Row</span>
                  </th>
                  {Array.from({ length: columns }, (_, column) => (
                    <th
                      key={column}
                      scope="col"
                      className="sticky top-0 border-r border-b bg-background px-2 py-1.5 text-left font-medium"
                    >
                      <div className="max-w-[24rem] overflow-hidden text-ellipsis whitespace-pre" title={header[column]}>
                        {header[column] ?? ""}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, index) => (
                  <tr key={index} className="hover:bg-muted/40">
                    <th
                      scope="row"
                      className="sticky left-0 border-r border-b bg-background px-2 py-1 text-right font-mono font-normal text-muted-foreground tabular-nums"
                    >
                      {index + 1}
                    </th>
                    {Array.from({ length: columns }, (_, column) => (
                      <td key={column} className="border-r border-b px-2 py-1 align-top">
                        <div className="max-w-[24rem] overflow-hidden text-ellipsis whitespace-pre" title={row[column]}>
                          {row[column] ?? ""}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {truncated && (
            <p role="status" className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground">
              Showing first {body.length.toLocaleString()} rows
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** CSV/TSV as a table (first row as the sticky header, row numbers), with a Table / Source toggle. */
export function CsvPane({ attachment, download }: PaneProps) {
  const delimiter = /\.tsv$/i.test(attachment.name) ? "\t" : ",";
  return (
    <WithFileBytes attachment={attachment} download={download} limit={MAX_TEXT_BYTES}>
      {(bytes) => <CsvView bytes={bytes} delimiter={delimiter} />}
    </WithFileBytes>
  );
}

function CellOutput({ output }: { output: NotebookOutput }) {
  if (output.kind === "image") {
    return <img src={output.dataUrl} alt="Cell output" className="max-w-full rounded-sm bg-white" />;
  }
  if (output.kind === "markdown") return <RichText text={output.text} className="text-sm leading-relaxed" />;
  return (
    <pre
      tabIndex={0}
      className={cn(
        "overflow-x-auto rounded-sm p-2",
        SOURCE_PRE,
        SCROLL_FOCUS,
        output.error && "bg-destructive/5 text-destructive",
      )}
    >
      {output.text}
    </pre>
  );
}

function NotebookCellView({ cell }: { cell: NotebookCell }) {
  if (cell.type === "markdown") {
    return cell.source.trim() ? <RichText text={cell.source} className="text-sm leading-relaxed" /> : null;
  }
  if (cell.type === "raw") {
    return (
      <pre tabIndex={0} className={cn("overflow-x-auto px-2 py-1 text-muted-foreground", SOURCE_PRE, SCROLL_FOCUS)}>
        {cell.source}
      </pre>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
        <span className="shrink-0 pt-2 font-mono text-xs text-muted-foreground sm:w-14 sm:text-right" aria-hidden>
          In [{cell.executionCount ?? " "}]:
        </span>
        <pre
          tabIndex={0}
          className={cn("min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/40 p-2", SOURCE_PRE, SCROLL_FOCUS)}
        >
          {cell.source}
        </pre>
      </div>
      {cell.outputs.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2 sm:pl-16">
          {cell.outputs.map((output, index) => (
            <CellOutput key={index} output={output} />
          ))}
        </div>
      )}
    </div>
  );
}

function NotebookView({ bytes, ...pane }: PaneProps & { bytes: Uint8Array }) {
  const result = useMemo((): { ok: true; notebook: Notebook } | { ok: false; error: string } => {
    try {
      return { ok: true, notebook: parseNotebook(new TextDecoder().decode(bytes)) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [bytes]);
  if (!result.ok) {
    return (
      <ViewerFallback
        {...pane}
        message={`Couldn't preview this notebook: ${result.error.replace(/^Invalid notebook: /, "")}`}
      />
    );
  }
  const { language, cells } = result.notebook;
  return (
    <div tabIndex={0} className={cn("size-full overflow-auto bg-background", SCROLL_FOCUS)}>
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-6">
        <p className="text-xs text-muted-foreground">
          {[language, `${cells.length.toLocaleString()} ${cells.length === 1 ? "cell" : "cells"}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {cells.map((cell, index) => (
          <NotebookCellView key={index} cell={cell} />
        ))}
      </div>
    </div>
  );
}

/** Jupyter notebook: markdown cells rendered, code cells with their outputs. */
export function NotebookPane({ attachment, download }: PaneProps) {
  return (
    <WithFileBytes attachment={attachment} download={download} limit={MAX_TEXT_BYTES}>
      {(bytes) => <NotebookView attachment={attachment} download={download} bytes={bytes} />}
    </WithFileBytes>
  );
}
