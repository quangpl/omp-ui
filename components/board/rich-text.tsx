import { type ReactNode, useMemo } from "react";
import { cn } from "@/lib/utils";

/**
 * Small, safe Markdown subset for agent/user text (React elements only, no HTML injection):
 * paragraphs (newlines kept), # headings (bold lines), - / * / 1. lists, ``` fences,
 * `code`, **bold**, *italic*, [links](https://…) and bare https URLs.
 */

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] };

const FENCE = /```[^\n`]*\n?([\s\S]*?)(?:```|$)/g;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;

function parseProse(source: string, blocks: Block[]) {
  let paragraph: string[] = [];
  // Cast (not annotation) so TS doesn't narrow to `null`; the flush helpers reassign it.
  let list = null as Extract<Block, { kind: "list" }> | null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const line of source.split("\n")) {
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { kind: "list", ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      }
      list.items.push(bullet ? bullet[1] : (numbered?.[2] ?? ""));
      continue;
    }
    if (list && /^\s+/.test(line)) {
      // Indented continuation of the previous list item.
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
}

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const start = match.index ?? 0;
    parseProse(source.slice(last, start), blocks);
    blocks.push({ kind: "code", text: match[1].replace(/\n$/, "") });
    last = start + match[0].length;
  }
  parseProse(source.slice(last), blocks);
  return blocks;
}

// One alternative per inline construct; earlier alternatives win at the same position.
const INLINE =
  /`([^`\n]+)`|\*\*(?=\S)([^\n]*?\S)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]])|\*(?=[^\s*])([^*\n]*?[^\s*])\*/g;

const LINK_CLASS = "font-medium underline underline-offset-2 break-all hover:opacity-80";

function renderInline(text: string, keyPrefix = ""): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const key = `${keyPrefix}${start}`;
    const [, code, bold, linkText, linkUrl, url, italic] = match;
    if (code !== undefined) {
      nodes.push(
        <code key={key} className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[0.85em]">
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderInline(bold, `${key}-`)}
        </strong>,
      );
    } else if (linkUrl !== undefined) {
      nodes.push(
        <a key={key} href={linkUrl} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          {renderInline(linkText, `${key}-`)}
        </a>,
      );
    } else if (url !== undefined) {
      nodes.push(
        <a key={key} href={url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          {url}
        </a>,
      );
    } else if (italic !== undefined) {
      nodes.push(<em key={key}>{renderInline(italic, `${key}-`)}</em>);
    }
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 break-words", className)}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "code":
            return (
              <pre
                key={index}
                className="max-w-full overflow-x-auto rounded-md bg-foreground/[0.06] px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre"
              >
                <code>{block.text}</code>
              </pre>
            );
          case "heading":
            return (
              <p key={index} className="font-semibold">
                {renderInline(block.text)}
              </p>
            );
          case "list": {
            const items = block.items.map((item, i) => (
              <li key={i} className="pl-0.5 whitespace-pre-wrap">
                {renderInline(item)}
              </li>
            ));
            return block.ordered ? (
              <ol key={index} start={block.start} className="flex list-decimal flex-col gap-1 pl-5">
                {items}
              </ol>
            ) : (
              <ul key={index} className="flex list-disc flex-col gap-1 pl-5">
                {items}
              </ul>
            );
          }
          default:
            return (
              <p key={index} className="whitespace-pre-wrap">
                {renderInline(block.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
