"use client";

import { type MouseEvent as ReactMouseEvent, type ReactNode, useMemo, useState } from "react";
import { FileIcon, ImageIcon, ImageOffIcon } from "lucide-react";
import {
  appFileOf,
  attachmentKind,
  isPlainClick,
  isViewableUrl,
  nameFromUrl,
  openAttachment,
  type Attachment,
} from "@/components/attachment-viewer";
import { cn } from "@/lib/utils";

/**
 * Small, safe Markdown subset for agent/user text (React elements only, no HTML injection):
 * paragraphs (newlines kept), # headings (bold lines), - / * / 1. lists, ``` fences,
 * `code`, **bold**, *italic*, [links](https://…), ![images](…) and bare https URLs.
 * Images and links to shared files (`/api/v1/…/files/…`) open in the attachment viewer;
 * a modified click (⌘/Ctrl/Shift/middle) still opens them in a new tab.
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
// Groups: 1 code, 2 bold, 3 image alt, 4 image url, 5 link text, 6 link url, 7 bare url, 8 italic.
const TARGET = String.raw`(?:https?:\/\/|\/api\/v1\/)[^\s)]+`;
const TITLE = String.raw`(?:\s+"[^"\n]*")?`;
const BARE_APP_FILE = String.raw`(?<![\w/.])\/api\/v1\/(?:tasks|boards)\/[A-Za-z0-9_-]+\/files\/[^\s<>]*[^\s<>.,;:!?'")\]]`;
const INLINE = new RegExp(
  [
    "`([^`\\n]+)`",
    String.raw`\*\*(?=\S)([^\n]*?\S)\*\*`,
    String.raw`!\[([^\]\n]*)\]\((${TARGET})${TITLE}\)`,
    String.raw`\[([^\]\n]+)\]\((${TARGET})${TITLE}\)`,
    String.raw`(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]|${BARE_APP_FILE})`,
    String.raw`\*(?=[^\s*])([^*\n]*?[^\s*])\*`,
  ].join("|"),
  "g",
);

const LINK_CLASS = "font-medium underline underline-offset-2 break-all hover:opacity-80";
const CHIP_CLASS =
  "inline-flex max-w-full items-center gap-1 rounded-md border bg-background/60 px-1.5 py-px align-baseline text-[0.85em] font-medium no-underline outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50";

interface InlineContext {
  /** Every viewable attachment of the text, in order: the viewer's ←/→ list. */
  attachments: Attachment[];
  /** "chip" when the images are shown elsewhere (e.g. a report gallery). */
  images: "thumbnail" | "chip";
  onFeedback?: (attachment: Attachment) => void;
}

function toAttachment(url: string): Attachment {
  return { url, name: nameFromUrl(url) };
}

function collectAttachments(text: string, into: Map<string, Attachment>) {
  for (const match of text.matchAll(INLINE)) {
    const [, , bold, , imageUrl, , linkUrl, url, italic] = match;
    if (bold !== undefined) collectAttachments(bold, into);
    else if (italic !== undefined) collectAttachments(italic, into);
    else {
      const target = imageUrl ?? linkUrl ?? url;
      if (target && (imageUrl !== undefined || isViewableUrl(target)) && !into.has(target)) {
        into.set(target, toAttachment(target));
      }
    }
  }
}

/** Images and viewable files referenced by the text (outside code), in order, without repeats. */
export function extractAttachments(text: string): Attachment[] {
  const found = new Map<string, Attachment>();
  for (const block of parseBlocks(text)) {
    if (block.kind === "code") continue;
    for (const part of block.kind === "list" ? block.items : [block.text]) collectAttachments(part, found);
  }
  return [...found.values()];
}

function viewerClick(attachment: Attachment, ctx: InlineContext) {
  return (event: ReactMouseEvent) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    openAttachment({ ...attachment, list: ctx.attachments, onFeedback: ctx.onFeedback });
  };
}

function AttachmentChip({
  attachment,
  label,
  ctx,
  broken,
}: {
  attachment: Attachment;
  label: ReactNode;
  ctx: InlineContext;
  broken?: boolean;
}) {
  const Icon = broken ? ImageOffIcon : attachmentKind(attachment) === "image" ? ImageIcon : FileIcon;
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={viewerClick(attachment, ctx)}
      title={`Preview ${attachment.name}`}
      className={CHIP_CLASS}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </a>
  );
}

function InlineImage({ attachment, alt, ctx }: { attachment: Attachment; alt: string; ctx: InlineContext }) {
  const [broken, setBroken] = useState(false);
  if (broken || ctx.images === "chip") {
    return <AttachmentChip attachment={attachment} label={alt || attachment.name} ctx={ctx} broken={broken} />;
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={viewerClick(attachment, ctx)}
      title={`Preview ${attachment.name}`}
      className="group/img my-1 mr-2 inline-block max-w-full overflow-hidden rounded-lg border bg-muted align-top outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <img
        src={attachment.url}
        alt={alt || attachment.name}
        loading="lazy"
        decoding="async"
        referrerPolicy={appFileOf(attachment.url) ? undefined : "no-referrer"}
        onError={() => setBroken(true)}
        className="block max-h-56 max-w-full object-contain transition-opacity group-hover/img:opacity-90"
      />
    </a>
  );
}

function renderInline(text: string, ctx: InlineContext, keyPrefix = ""): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const key = `${keyPrefix}${start}`;
    const [, code, bold, imageAlt, imageUrl, linkText, linkUrl, url, italic] = match;
    if (code !== undefined) {
      nodes.push(
        <code key={key} className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[0.85em]">
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderInline(bold, ctx, `${key}-`)}
        </strong>,
      );
    } else if (imageUrl !== undefined) {
      const attachment = toAttachment(imageUrl);
      nodes.push(
        attachmentKind(attachment) === "image" ? (
          <InlineImage key={key} attachment={attachment} alt={imageAlt} ctx={ctx} />
        ) : (
          <AttachmentChip key={key} attachment={attachment} label={imageAlt || attachment.name} ctx={ctx} />
        ),
      );
    } else if (linkUrl !== undefined) {
      nodes.push(
        isViewableUrl(linkUrl) ? (
          <AttachmentChip
            key={key}
            attachment={toAttachment(linkUrl)}
            label={renderInline(linkText, ctx, `${key}-`)}
            ctx={ctx}
          />
        ) : (
          <a key={key} href={linkUrl} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
            {renderInline(linkText, ctx, `${key}-`)}
          </a>
        ),
      );
    } else if (url !== undefined) {
      nodes.push(
        isViewableUrl(url) ? (
          <AttachmentChip key={key} attachment={toAttachment(url)} label={nameFromUrl(url)} ctx={ctx} />
        ) : (
          <a key={key} href={url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
            {url}
          </a>
        ),
      );
    } else if (italic !== undefined) {
      nodes.push(<em key={key}>{renderInline(italic, ctx, `${key}-`)}</em>);
    }
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function RichText({
  text,
  className,
  images = "thumbnail",
  onAttachmentFeedback,
}: {
  text: string;
  className?: string;
  /** How markdown images render: inline thumbnails (default) or compact chips. */
  images?: "thumbnail" | "chip";
  /** Adds a "Feedback" action to the attachment viewer opened from this text. */
  onAttachmentFeedback?: (attachment: Attachment) => void;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const attachments = useMemo(() => extractAttachments(text), [text]);
  const ctx: InlineContext = { attachments, images, onFeedback: onAttachmentFeedback };
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
                {renderInline(block.text, ctx)}
              </p>
            );
          case "list": {
            const items = block.items.map((item, i) => (
              <li key={i} className="pl-0.5 whitespace-pre-wrap">
                {renderInline(item, ctx)}
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
                {renderInline(block.text, ctx)}
              </p>
            );
        }
      })}
    </div>
  );
}
