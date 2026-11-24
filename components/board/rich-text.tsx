"use client";

import { type MouseEvent as ReactMouseEvent, type ReactNode, useMemo, useState } from "react";
import { ImageOffIcon, SquareCheckIcon, SquareIcon } from "lucide-react";
import { openAttachment } from "@/components/attachment-viewer";
import {
  appFileOf,
  attachmentKind,
  isPlainClick,
  isViewableUrl,
  KIND_ICON,
  nameFromUrl,
  type Attachment,
} from "@/components/viewer/common";
import { inlineSources, type MdAlign, type MdBlock, type MdListItem, parseBlocks } from "@/lib/markdown/blocks";
import { isSafeUrl, type MdInline, parseInline } from "@/lib/markdown/inline";
import { cn } from "@/lib/utils";

/**
 * Safe GitHub-flavoured Markdown subset for agent/user text, parsed by `lib/markdown` and
 * rendered as React elements only (no HTML injection, no `dangerouslySetInnerHTML`):
 * ATX headings, paragraphs (newlines kept), bullet/ordered lists (nested, loose/tight,
 * `- [ ]` task items), `>` quotes, `---` rules, pipe tables with alignment, ``` / ~~~ fences
 * (language label, no highlighting), `code`, **bold**, *italic*, ~~strike~~, [links](…),
 * ![images](…), <autolinks>, bare https URLs and bare `/api/v1/…/files/…` paths.
 * Link and image targets are limited by `isSafeUrl` (http(s), mailto for links, `/api/v1/`);
 * anything else stays literal text. Images and links to shared files (`/api/v1/…/files/…`)
 * open in the attachment viewer; a modified click (⌘/Ctrl/Shift/middle) still opens them in a new tab.
 */

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

/** Where a block list sits: list nesting depth and whether paragraphs belong to a tight list item. */
interface BlockScope {
  listDepth: number;
  tight: boolean;
}

const ROOT_SCOPE: BlockScope = { listDepth: 0, tight: false };

function toAttachment(url: string): Attachment {
  return { url, name: nameFromUrl(url) };
}

function collectAttachments(nodes: MdInline[], into: Map<string, Attachment>) {
  for (const node of nodes) {
    switch (node.kind) {
      case "strong":
      case "em":
      case "strike":
        collectAttachments(node.children, into);
        break;
      case "link":
        if (isViewableUrl(node.url) && !into.has(node.url)) into.set(node.url, toAttachment(node.url));
        collectAttachments(node.children, into);
        break;
      case "image":
        if (!into.has(node.url)) into.set(node.url, toAttachment(node.url));
        break;
      case "url":
        if (isViewableUrl(node.url) && !into.has(node.url)) into.set(node.url, toAttachment(node.url));
        break;
      default:
        break;
    }
  }
}

/** Images and viewable files referenced by the text (outside code), in order, without repeats. */
export function extractAttachments(text: string): Attachment[] {
  const found = new Map<string, Attachment>();
  for (const source of inlineSources(parseBlocks(text))) collectAttachments(parseInline(source), found);
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
  const Icon = broken ? ImageOffIcon : KIND_ICON[attachmentKind(attachment)];
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

/** Plain text of inline nodes, used as an image's alt text / chip label. */
function plainLabel(nodes: MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        case "image":
          return node.alt;
        case "url":
          return node.url;
        default:
          return plainLabel(node.children);
      }
    })
    .join("");
}

function renderNodes(nodes: MdInline[], ctx: InlineContext, keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, ctx, `${keyPrefix}${index}`));
}

function renderNode(node: MdInline, ctx: InlineContext, key: string): ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "code": {
      // An app-served image path in code (`/api/v1/tasks/<id>/files/shot.png`) still shows the image.
      if (appFileOf(node.text) && isSafeUrl(node.text, "image") && attachmentKind(toAttachment(node.text)) === "image") {
        return <InlineImage key={key} attachment={toAttachment(node.text)} alt="" ctx={ctx} />;
      }
      return (
        <code key={key} className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[0.85em]">
          {node.text}
        </code>
      );
    }
    case "strong":
      return (
        <strong key={key} className="font-semibold">
          {renderNodes(node.children, ctx, `${key}-`)}
        </strong>
      );
    case "em":
      return <em key={key}>{renderNodes(node.children, ctx, `${key}-`)}</em>;
    case "strike":
      return (
        <del key={key} className="opacity-70">
          {renderNodes(node.children, ctx, `${key}-`)}
        </del>
      );
    case "image": {
      // The parser only emits safe targets; re-checked so a parser bug can't leak a dangerous URL.
      if (!isSafeUrl(node.url, "image")) return node.alt;
      const attachment = toAttachment(node.url);
      return attachmentKind(attachment) === "image" ? (
        <InlineImage key={key} attachment={attachment} alt={node.alt} ctx={ctx} />
      ) : (
        <AttachmentChip key={key} attachment={attachment} label={node.alt || attachment.name} ctx={ctx} />
      );
    }
    case "link": {
      const label = renderNodes(node.children, ctx, `${key}-`);
      if (isViewableUrl(node.url)) {
        const attachment = toAttachment(node.url);
        // Links to images show the image itself (a chip only when a gallery shows them elsewhere).
        if (attachmentKind(attachment) === "image") {
          return <InlineImage key={key} attachment={attachment} alt={plainLabel(node.children)} ctx={ctx} />;
        }
        return <AttachmentChip key={key} attachment={attachment} label={label} ctx={ctx} />;
      }
      return node.url.startsWith("mailto:") ? (
        <a key={key} href={node.url} className={LINK_CLASS}>
          {label}
        </a>
      ) : (
        <a key={key} href={node.url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          {label}
        </a>
      );
    }
    case "url":
      if (!isSafeUrl(node.url, "link")) return node.url;
      if (!isViewableUrl(node.url)) {
        return (
          <a key={key} href={node.url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
            {node.url}
          </a>
        );
      }
      return attachmentKind(toAttachment(node.url)) === "image" ? (
        <InlineImage key={key} attachment={toAttachment(node.url)} alt="" ctx={ctx} />
      ) : (
        <AttachmentChip key={key} attachment={toAttachment(node.url)} label={nameFromUrl(node.url)} ctx={ctx} />
      );
  }
}

function renderInline(text: string, ctx: InlineContext, keyPrefix: string): ReactNode[] {
  return renderNodes(parseInline(text), ctx, keyPrefix);
}

const HEADING_CLASS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "text-[1.25em] font-semibold",
  2: "text-[1.125em] font-semibold",
  3: "text-[1em] font-semibold",
  4: "text-[0.95em] font-semibold text-muted-foreground",
  5: "text-[0.95em] font-semibold text-muted-foreground",
  6: "text-[0.95em] font-semibold text-muted-foreground",
};

const BULLET_STYLE = ["list-disc", "list-[circle]", "list-[square]"];

const ALIGN_CLASS: Record<Exclude<MdAlign, null>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function renderListItem(
  item: MdListItem,
  ctx: InlineContext,
  key: string,
  scope: BlockScope,
  tight: boolean,
): ReactNode {
  const inner = renderBlocks(item.blocks, ctx, `${key}-`, { listDepth: scope.listDepth + 1, tight });
  const spacing = tight ? "[&>*+*]:mt-1" : "[&>*+*]:mt-2";
  if (item.checked === null) {
    return (
      <li key={key} className={cn("pl-0.5", spacing)}>
        {inner}
      </li>
    );
  }
  const Check = item.checked ? SquareCheckIcon : SquareIcon;
  return (
    <li key={key} className="flex list-none items-start gap-1.5">
      <span className="flex h-[1lh] shrink-0 items-center">
        <Check
          role="img"
          aria-label={item.checked ? "Done" : "Not done"}
          className={cn("size-[1em]", item.checked ? "text-foreground" : "text-muted-foreground")}
        />
      </span>
      <div className={cn("min-w-0 flex-1", spacing, item.checked && "text-muted-foreground")}>{inner}</div>
    </li>
  );
}

function renderBlock(block: MdBlock, ctx: InlineContext, key: string, scope: BlockScope): ReactNode {
  switch (block.kind) {
    case "code":
      return (
        <div key={key} className="max-w-full min-w-0 overflow-hidden rounded-md bg-foreground/[0.06]">
          {block.lang && (
            <div className="border-b border-foreground/[0.06] px-2.5 py-1 font-mono text-[0.7rem] leading-none text-muted-foreground select-none">
              {block.lang}
            </div>
          )}
          <pre className="max-w-full overflow-x-auto px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre">
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case "heading": {
      const Tag = `h${block.level}` as const;
      return (
        <Tag key={key} className={cn(HEADING_CLASS[block.level], "leading-snug [&:not(:first-child)]:mt-1")}>
          {renderInline(block.text, ctx, `${key}-`)}
        </Tag>
      );
    }
    case "paragraph":
      return scope.tight ? (
        <div key={key} className="whitespace-pre-wrap">
          {renderInline(block.text, ctx, `${key}-`)}
        </div>
      ) : (
        <p key={key} className="whitespace-pre-wrap">
          {renderInline(block.text, ctx, `${key}-`)}
        </p>
      );
    case "list": {
      const items = block.items.map((item, i) => renderListItem(item, ctx, `${key}-${i}`, scope, block.tight));
      const allTasks = block.items.length > 0 && block.items.every((item) => item.checked !== null);
      const gap = block.tight ? "gap-1" : "gap-2";
      if (block.ordered) {
        return (
          <ol key={key} start={block.start} className={cn("flex list-decimal flex-col", gap, allTasks ? "pl-0.5" : "pl-5")}>
            {items}
          </ol>
        );
      }
      const bullet = BULLET_STYLE[Math.min(scope.listDepth, BULLET_STYLE.length - 1)];
      return (
        <ul key={key} className={cn("flex flex-col", gap, allTasks ? "list-none pl-0.5" : cn(bullet, "pl-5"))}>
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote key={key} className="flex min-w-0 flex-col gap-2 border-l-2 pl-3 text-muted-foreground">
          {renderBlocks(block.blocks, ctx, `${key}-`, { listDepth: scope.listDepth, tight: false })}
        </blockquote>
      );
    case "rule":
      return <hr key={key} className="border-border" />;
    case "table": {
      const hasRows = block.rows.length > 0;
      return (
        <div key={key} className="max-w-full overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-[0.9em]">
            <thead className="bg-muted/50">
              <tr>
                {block.header.map((cell, c) => (
                  <th
                    key={c}
                    scope="col"
                    className={cn(
                      "px-2.5 py-1.5 align-top font-semibold",
                      hasRows && "border-b",
                      ALIGN_CLASS[block.align[c] ?? "left"],
                    )}
                  >
                    {renderInline(cell, ctx, `${key}-h${c}-`)}
                  </th>
                ))}
              </tr>
            </thead>
            {hasRows && (
              <tbody className="[&>tr:last-child>td]:border-b-0">
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        className={cn("border-b px-2.5 py-1.5 align-top", ALIGN_CLASS[block.align[c] ?? "left"])}
                      >
                        {renderInline(cell, ctx, `${key}-${r}-${c}-`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    }
  }
}

/** Renders a block sequence; shared by the root, list items and quotes. */
function renderBlocks(blocks: MdBlock[], ctx: InlineContext, keyPrefix: string, scope: BlockScope = ROOT_SCOPE): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, ctx, `${keyPrefix}${index}`, scope));
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
    <div className={cn("flex min-w-0 flex-col gap-2 break-words", className)}>{renderBlocks(blocks, ctx, "b")}</div>
  );
}
