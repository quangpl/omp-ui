"use client";

// Renders the shared document model (Word, PowerPoint, EPUB previews) as readable prose. Plain
// React elements only: the model carries text and structure, never markup.
import type { ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import type { DocBlock, Run } from "@/lib/viewer/document";
import { cn } from "@/lib/utils";

type ListItem = Extract<DocBlock, { kind: "list-item" }>;

/** Rendering units: a run of consecutive list items is one group. */
type Group = { kind: "list"; items: ListItem[] } | { kind: "block"; block: Exclude<DocBlock, ListItem> };

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

const HEADING_CLASS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "text-2xl font-semibold tracking-tight",
  2: "text-xl font-semibold tracking-tight",
  3: "text-lg font-semibold",
  4: "text-base font-semibold",
  5: "text-sm font-semibold",
  6: "text-sm font-medium text-muted-foreground",
};

/** Bullets by nesting depth, cycling. */
const BULLETS = ["•", "◦", "▪"];

/** Blocks worth showing (blank paragraphs used as spacing in Word files are dropped), grouped. */
function groupBlocks(blocks: DocBlock[]): Group[] {
  const groups: Group[] = [];
  for (const block of blocks) {
    if (block.kind === "paragraph" && !block.runs.some((run) => run.text.trim() !== "")) continue;
    if (block.kind === "list-item") {
      const last = groups.at(-1);
      if (last?.kind === "list") last.items.push(block);
      else groups.push({ kind: "list", items: [block] });
    } else {
      groups.push({ kind: "block", block });
    }
  }
  return groups;
}

/** Marker per list item: bullets by depth; ordered items numbered per level, restarting when a shallower item or a switch between ordered/unordered at that level interrupts the sequence. */
function listMarkers(items: ListItem[]): string[] {
  const counters: { ordered: boolean; count: number }[] = [];
  return items.map((item) => {
    const level = Math.max(0, item.level);
    counters.length = Math.min(counters.length, level + 1);
    const current = counters[level];
    const count = current && current.ordered === item.ordered ? current.count + 1 : 1;
    counters[level] = { ordered: item.ordered, count };
    return item.ordered ? `${count}.` : BULLETS[level % BULLETS.length];
  });
}

function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((run, i) => {
        let node: ReactNode = run.code ? (
          <code className="rounded bg-muted px-1 font-mono text-[0.9em]">{run.text}</code>
        ) : (
          run.text
        );
        const style = cn(
          run.bold && "font-semibold",
          run.italic && "italic",
          run.underline && "underline",
          run.strike && "line-through",
        );
        if (style) node = <span className={style}>{node}</span>;
        if (run.href) {
          node = (
            <a href={run.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {node}
            </a>
          );
        }
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

function ListGroup({ items }: { items: ListItem[] }) {
  const markers = listMarkers(items);
  const ordered = items[0]?.ordered && items.every((item) => item.ordered);
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag role="list" className="flex flex-col gap-1 text-sm leading-relaxed">
      {items.map((item, i) => (
        <li
          key={i}
          className="flex gap-2"
          style={{ paddingLeft: `${Math.max(0, item.level) * 1.25}rem` }}
        >
          <span aria-hidden className="min-w-5 shrink-0 text-right text-muted-foreground tabular-nums">
            {markers[i]}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
            <Runs runs={item.runs} />
          </span>
        </li>
      ))}
    </Tag>
  );
}

function Block({ block }: { block: Exclude<DocBlock, ListItem> }) {
  switch (block.kind) {
    case "heading": {
      const Tag = HEADING_TAGS[block.level - 1] ?? "h6";
      return (
        <Tag className={cn("mt-4 whitespace-pre-wrap first:mt-0 [overflow-wrap:anywhere]", HEADING_CLASS[block.level])}>
          <Runs runs={block.runs} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          <Runs runs={block.runs} />
        </p>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="border-collapse text-sm">
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border px-2 py-1 align-top whitespace-pre-wrap">
                      <Runs runs={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre">
          {block.text}
        </pre>
      );
    case "image":
      return (
        <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <ImageIcon className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">{block.alt ? `Image: ${block.alt}` : "Image"}</span>
        </div>
      );
    case "rule":
      return <hr className="border-border" />;
  }
}

/** A document's blocks as prose: sized headings, indented lists, scrollable bordered tables, code, image placeholders. */
export function DocumentBlocks({ blocks, className }: { blocks: DocBlock[]; className?: string }) {
  const groups = groupBlocks(blocks);
  if (groups.length === 0) {
    return <p className={cn("text-sm text-muted-foreground", className)}>This document has no text content.</p>;
  }
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {groups.map((group, i) =>
        group.kind === "list" ? <ListGroup key={i} items={group.items} /> : <Block key={i} block={group.block} />,
      )}
    </div>
  );
}
