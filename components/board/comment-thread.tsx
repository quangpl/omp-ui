"use client";

import { useState } from "react";
import { ArrowUp, Bot, CircleCheck, Undo2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Comment, Task } from "@/lib/types";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { RichText } from "@/components/board/rich-text";

/** Enlarges the touch target of a compact control without changing its layout. */
const HIT_AREA = "relative after:absolute after:-inset-x-1 after:-inset-y-3";

function composerHint(task: Task): string {
  if (task.agentState === "running" || task.agentState === "queued") {
    return "Feedback is sent to the running agent";
  }
  if (task.status === "done") return "Sending feedback reopens this card and the agent continues";
  if (task.status === "todo") return "Feedback will be included when the agent starts";
  return "Sending feedback resumes the agent with your notes";
}

function CommentItem({
  comment,
  now,
  onSetResolved,
}: {
  comment: Comment;
  now: number;
  onSetResolved: (comment: Comment, resolved: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const time = (
    <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>
      {formatRelative(comment.createdAt, now)}
    </time>
  );

  if (comment.author === "agent") {
    return (
      <li className="flex gap-2.5">
        <Avatar size="sm" className="mt-0.5">
          <AvatarFallback className="bg-foreground text-background">
            <Bot className="size-3.5" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="font-medium text-foreground">Agent</span>
            <span className="text-muted-foreground">{time}</span>
          </div>
          <div className="mt-1 rounded-xl rounded-tl-sm border bg-card px-3 py-2 text-sm leading-relaxed">
            <RichText text={comment.body} />
          </div>
        </div>
      </li>
    );
  }

  const toggle = async (resolved: boolean) => {
    setBusy(true);
    await onSetResolved(comment, resolved);
    setBusy(false);
  };

  return (
    <li className="flex flex-col items-end pl-6 sm:pl-10">
      <div
        className={cn(
          "max-w-full min-w-0 rounded-xl rounded-tr-sm bg-muted px-3 py-2 text-sm leading-relaxed",
          comment.resolved && "text-muted-foreground",
        )}
      >
        <RichText text={comment.body} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <span>You · {time}</span>
        {comment.resolved ? (
          <>
            <span
              className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400"
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
        )}
      </div>
    </li>
  );
}

export function CommentThread({
  task,
  comments,
  onSend,
  onSetResolved,
}: {
  task: Task;
  /** Oldest first. */
  comments: Comment[];
  /** Resolves true when the comment was posted. */
  onSend: (body: string) => Promise<boolean>;
  onSetResolved: (comment: Comment, resolved: boolean) => Promise<void>;
}) {
  const now = useNow();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    const ok = await onSend(text);
    setSending(false);
    if (ok) setBody("");
  };

  return (
    <div className="flex flex-col">
      {comments.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          No activity yet. Leave feedback for the agent below — the agent&apos;s replies show up here
          too.
        </div>
      ) : (
        <ol className="flex flex-col gap-4 px-4 py-4">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              now={now}
              onSetResolved={onSetResolved}
            />
          ))}
        </ol>
      )}

      <form
        data-vaul-no-drag
        className="sticky bottom-0 z-10 border-t bg-popover/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur supports-backdrop-filter:bg-popover/80"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-2">
          <Textarea
            value={body}
            rows={1}
            disabled={sending}
            placeholder="Leave feedback for the agent…"
            aria-label="Feedback"
            className="max-h-40 min-h-11 resize-none bg-background text-base md:text-base"
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
            className="size-11 shrink-0 rounded-full"
          >
            <ArrowUp />
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {composerHint(task)}
          <span className="max-md:hidden"> · Ctrl/⌘+Enter to send</span>
        </p>
      </form>
    </div>
  );
}
