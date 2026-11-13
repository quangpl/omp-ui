"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Bot, CircleCheck, MessageSquare, Undo2 } from "lucide-react";
import { AttachmentViewer } from "@/components/attachment-viewer";
import { appFileOf, type Attachment } from "@/components/viewer/common";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { modKeyLabel } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import type { Comment, Run, Task } from "@/lib/types";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { RichText } from "@/components/board/rich-text";
import { parseRunReport, RunReport } from "@/components/board/run-report";

/** Enlarges the touch target of a compact control without changing its layout (44px tall on phones). */
const HIT_AREA = "relative after:absolute after:-inset-x-1 after:-inset-y-3 max-md:after:-inset-y-3.5";

function composerHint(task: Task): string {
  if (task.agentState === "running" || task.agentState === "queued") {
    return "Feedback is sent to the running agent";
  }
  if (task.status === "done") return "Sending feedback reopens this card and the agent continues";
  if (task.status === "todo") return "Feedback will be included when the agent starts";
  return "Sending feedback resumes the agent with your notes";
}

/** Resolved / Open state of a feedback comment, with the toggle. */
function ResolveControls({
  comment,
  now,
  onSetResolved,
}: {
  comment: Comment;
  now: number;
  onSetResolved: (comment: Comment, resolved: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const toggle = async (resolved: boolean) => {
    setBusy(true);
    await onSetResolved(comment, resolved);
    setBusy(false);
  };

  return comment.resolved ? (
    <>
      <span
        className="inline-flex items-center gap-1 font-medium text-success"
        title={comment.resolvedAt ? formatDateTime(comment.resolvedAt) : undefined}
      >
        <CircleCheck className="size-3.5" />
        Resolved{comment.resolvedAt ? ` ${formatRelative(comment.resolvedAt, now)}` : ""}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void toggle(false)}
        className={cn(
          HIT_AREA,
          "inline-flex items-center gap-1 rounded font-medium text-foreground/70 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50",
        )}
      >
        <Undo2 className="size-3.5" />
        Reopen
      </button>
    </>
  ) : (
    <>
      <Badge
        variant="outline"
        className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      >
        Open
      </Badge>
      <button
        type="button"
        disabled={busy}
        onClick={() => void toggle(true)}
        className={cn(
          HIT_AREA,
          "inline-flex items-center gap-1 rounded font-medium text-foreground/70 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50",
        )}
      >
        <CircleCheck className="size-3.5" />
        Resolve
      </button>
    </>
  );
}

function CommentItem({
  comment,
  now,
  cards,
  runs,
  onOpenCard,
  onSetResolved,
  onAttachmentFeedback,
}: {
  comment: Comment;
  now: number;
  cards: Task[];
  runs: Run[];
  onOpenCard: (taskId: string) => void;
  onSetResolved: (comment: Comment, resolved: boolean) => Promise<void>;
  onAttachmentFeedback: (attachment: Attachment) => void;
}) {
  const report = useMemo(() => parseRunReport(comment, runs), [comment, runs]);
  const time = (
    <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>
      {formatRelative(comment.createdAt, now)}
    </time>
  );

  if (comment.author === "agent") {
    const body = report ? report.body : comment.body;
    return (
      <li className="flex animate-fade-in-soft gap-2.5 pr-2 sm:pr-8">
        <Avatar size="sm" className="mt-0.5 shrink-0">
          <AvatarFallback className="bg-foreground text-background">
            <Bot className="size-3.5" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 items-baseline gap-2 text-xs">
            <span className="font-semibold text-foreground">Agent</span>
            <span className="text-muted-foreground tabular-nums">{time}</span>
          </div>
          {body.trim() && (
            <div className="mt-1 min-w-0 rounded-2xl rounded-tl-md border bg-card px-3.5 py-2.5 text-sm leading-relaxed shadow-xs [overflow-wrap:anywhere]">
              <RichText
                text={body}
                images={report && report.screenshots.length > 0 ? "chip" : "thumbnail"}
                onAttachmentFeedback={onAttachmentFeedback}
              />
            </div>
          )}
          {report && <RunReport report={report} onFeedback={onAttachmentFeedback} />}
        </div>
      </li>
    );
  }

  if (comment.fromTaskId) {
    // A message from another card's agent: feedback this card's agent must address.
    const sender = cards.find((card) => card.id === comment.fromTaskId);
    return (
      <li className="flex animate-fade-in-soft gap-2.5 pr-6 sm:pr-12">
        <Avatar size="sm" className="mt-0.5 shrink-0">
          <AvatarFallback className="bg-primary text-primary-foreground">
            <Bot className="size-3.5" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 min-w-0 items-baseline gap-2 text-xs">
            {sender ? (
              <span className="flex min-w-0 items-baseline gap-1 font-semibold text-primary">
                <span className="shrink-0">Agent ·</span>
                <button
                  type="button"
                  onClick={() => onOpenCard(sender.id)}
                  title={`Open “${sender.title}”`}
                  className={cn(
                    HIT_AREA,
                    "min-w-0 rounded text-left break-words underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  )}
                >
                  {sender.title}
                </button>
              </span>
            ) : (
              <span className="font-semibold text-primary">Another agent</span>
            )}
            <span className="shrink-0 text-muted-foreground tabular-nums">{time}</span>
          </div>
          <div
            className={cn(
              "mt-1 rounded-2xl rounded-tl-md border border-primary/30 bg-primary/5 px-3.5 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere] dark:bg-primary/10",
              comment.resolved && "text-muted-foreground",
            )}
          >
            <RichText text={comment.body} onAttachmentFeedback={onAttachmentFeedback} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <ResolveControls comment={comment} now={now} onSetResolved={onSetResolved} />
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="flex animate-fade-in-soft flex-col items-end pl-8 sm:pl-16">
      <div className="flex min-h-6 items-baseline gap-2 text-xs">
        <span className="font-semibold text-foreground">You</span>
        <span className="text-muted-foreground tabular-nums">{time}</span>
      </div>
      <div
        className={cn(
          "mt-1 max-w-full min-w-0 rounded-2xl rounded-tr-md bg-muted px-3.5 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere]",
          comment.resolved && "text-muted-foreground",
        )}
      >
        <RichText text={comment.body} onAttachmentFeedback={onAttachmentFeedback} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <ResolveControls comment={comment} now={now} onSetResolved={onSetResolved} />
      </div>
    </li>
  );
}

const NO_RUNS: Run[] = [];

export function CommentThread({
  task,
  comments,
  cards,
  runs = NO_RUNS,
  onOpenCard,
  onSend,
  onSetResolved,
}: {
  task: Task;
  /** Oldest first. */
  comments: Comment[];
  /** Cards of the board, to name the sender of agent-to-agent messages. */
  cards: Task[];
  /** The card's runs: matches the agent's result comments for the Report card (duration, outcome). */
  runs?: Run[];
  onOpenCard: (taskId: string) => void;
  /** Resolves true when the comment was posted. */
  onSend: (body: string) => Promise<boolean>;
  onSetResolved: (comment: Comment, resolved: boolean) => Promise<void>;
}) {
  const now = useNow();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Bumped to focus the composer (caret at the end) after a quote was inserted. */
  const [focusRequest, setFocusRequest] = useState(0);
  // Platform modifier for the send shortcut hint; read after mount (navigator isn't there on the server).
  const [modKey, setModKey] = useState("Ctrl");
  useEffect(() => setModKey(modKeyLabel()), []);

  useEffect(() => {
    const area = textareaRef.current;
    if (focusRequest === 0 || !area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    area.scrollIntoView({ block: "nearest" });
  }, [focusRequest]);

  /** Quote a screenshot/file in the composer so the next feedback refers to it. */
  const quoteAttachment = (attachment: Attachment) => {
    const quote = `> re: ${appFileOf(attachment.url)?.name ?? attachment.url}\n`;
    setBody((current) => (current.trim() ? `${current.trimEnd()}\n\n${quote}` : quote));
    setFocusRequest((n) => n + 1);
  };

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    const ok = await onSend(text);
    setSending(false);
    if (ok) setBody("");
  };

  return (
    <div className="flex min-h-full flex-col">
      {comments.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MessageSquare className="size-5" />
          </span>
          <p className="text-sm font-medium">No activity yet</p>
          <p className="max-w-xs text-sm text-muted-foreground">
            Leave feedback for the agent below — the agent&apos;s replies show up here too.
          </p>
        </div>
      ) : (
        <ol className="flex flex-1 flex-col gap-5 px-4 py-5 md:px-5">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              now={now}
              cards={cards}
              runs={runs}
              onOpenCard={onOpenCard}
              onSetResolved={onSetResolved}
              onAttachmentFeedback={quoteAttachment}
            />
          ))}
        </ol>
      )}
      <AttachmentViewer />

      <form
        data-vaul-no-drag
        className="glass-edge sticky bottom-0 z-10 border-t bg-popover/95 px-4 pt-3 pb-3 backdrop-blur supports-backdrop-filter:bg-popover/80 md:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border bg-background p-1.5 pl-1 shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
          <Textarea
            ref={textareaRef}
            value={body}
            rows={1}
            disabled={sending}
            placeholder="Leave feedback for the agent…"
            aria-label="Feedback"
            className="max-h-40 min-h-11 resize-none border-0 bg-transparent px-2.5 py-2.5 text-base shadow-none focus-visible:ring-0 md:min-h-9 md:py-2 md:text-sm dark:bg-transparent"
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            disabled={!body.trim() || sending}
            aria-label="Send feedback"
            title={`Send (${modKey}+Enter)`}
            className="size-11 shrink-0 rounded-xl pressable-icon md:size-9"
          >
            <ArrowUp />
          </Button>
        </div>
        <p className="mt-1.5 flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
          <span className="min-w-0">{composerHint(task)}</span>
          <span className="flex shrink-0 items-center gap-1 max-md:hidden" aria-hidden>
            <KbdGroup>
              <Kbd>{modKey}</Kbd>
              <Kbd>↵</Kbd>
            </KbdGroup>
            to send
          </span>
        </p>
      </form>
    </div>
  );
}
