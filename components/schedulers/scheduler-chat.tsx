"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  Bot,
  CalendarClock,
  ChevronDown,
  FolderGit2,
  Loader2,
  PencilLine,
  Plus,
  Repeat,
  RotateCw,
  Sparkles,
  Square,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/components/board/format";
import { RichText } from "@/components/board/rich-text";
import { SchedulePreview, browserTimeZone } from "@/components/schedulers/schedule-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import type { BoardWithCounts, SchedulerDraft } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** The draft the assistant proposed in this turn. */
  draft?: SchedulerDraft | null;
}

/** Starters shown before the first message; a click sends one as typed. */
const SUGGESTIONS = [
  "Every weekday at 9:00, review open pull requests and summarize what needs attention",
  "Every Monday at 8:00, update dependencies, run the tests and open a PR if all pass",
  "Every night at 2:00, run the full test suite and fix any failing tests",
  "On the 1st of every month, write a changelog of last month's commits",
] as const;

/**
 * "Create with Agent": the user describes a scheduler in plain language, the scheduler assistant
 * (POST /api/v1/schedulers/chat) proposes a validated draft, and the user creates it with one click,
 * keeps chatting to revise it, or opens it in the form (`onEditInForm`). `boardId` is the project
 * the conversation defaults to (shared with the form).
 */
export function SchedulerChat({
  boards,
  boardId,
  onBoardIdChange,
  onEditInForm,
}: {
  boards: BoardWithCounts[];
  boardId: string;
  onBoardIdChange: (boardId: string) => void;
  onEditInForm: (draft: SchedulerDraft) => void;
}) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  /** Progress line while the assistant works; null when idle. */
  const [activity, setActivity] = useState<string | null>(null);
  /** Why the last request failed (Retry resends it); null when it did not. */
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const nextIdRef = useRef(1);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLLIElement>(null);
  const [timezone] = useState(browserTimeZone);
  const busy = activity !== null;
  const latestDraftTurn = [...turns].reverse().find((turn) => turn.draft);

  // Keep the newest message, the progress line or the error in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns.length, busy, failure]);

  // Leaving the page cancels the request in flight.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const ask = async (history: Turn[]) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setFailure(null);
    setActivity("Thinking…");
    try {
      const result = await api.schedulers.chat(
        {
          messages: history.map((turn) => ({ role: turn.role, text: turn.text })),
          timezone,
          boardId,
          draft: [...history].reverse().find((turn) => turn.draft)?.draft ?? null,
        },
        (text) => {
          if (controllerRef.current === controller) setActivity(text);
        },
        controller.signal,
      );
      if (controllerRef.current !== controller) return;
      setTurns((prev) => [...prev, { id: nextIdRef.current++, role: "assistant", text: result.reply, draft: result.draft }]);
    } catch (err) {
      // Superseded by "Start over": that conversation is gone.
      if (controllerRef.current !== controller) return;
      setFailure(controller.signal.aborted ? "Stopped." : errorMessage(err));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setActivity(null);
        inputRef.current?.focus();
      }
    }
  };

  const send = (text: string) => {
    const value = text.trim();
    if (!value || busy) return;
    // After a failed turn its message stays in the history and the new one follows it.
    const history: Turn[] = [...turns, { id: nextIdRef.current++, role: "user", text: value }];
    setTurns(history);
    setInput("");
    void ask(history);
  };

  const retry = () => {
    if (!busy && turns.at(-1)?.role === "user") void ask(turns);
  };

  const create = async (draft: SchedulerDraft) => {
    if (creating) return;
    setCreating(true);
    try {
      const scheduler = await api.schedulers.create(draft);
      toast.success("Scheduler created", { description: scheduler.name });
      router.push(`/schedulers/${encodeURIComponent(scheduler.id)}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setCreating(false);
    }
  };

  const startOver = () => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.abort();
    setActivity(null);
    setTurns([]);
    setFailure(null);
    setInput("");
    inputRef.current?.focus();
  };

  const projectName = (id: string) => boards.find((board) => board.id === id)?.name ?? "Unknown project";

  return (
    <section aria-label="Create a scheduler with the agent" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2 sm:w-72">
          <Label htmlFor="scheduler-chat-project">Default project</Label>
          <Select value={boardId} onValueChange={onBoardIdChange} disabled={busy}>
            <SelectTrigger id="scheduler-chat-project" className="w-full data-[size=default]:h-11 md:data-[size=default]:h-9">
              <SelectValue placeholder="Pick a project" />
            </SelectTrigger>
            <SelectContent>
              {boards.map((board) => (
                <SelectItem key={board.id} value={board.id} className="max-md:min-h-11">
                  {board.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {turns.length > 0 && (
          <Button variant="ghost" className="h-11 self-start sm:self-auto md:h-9" onClick={startOver}>
            <Plus aria-hidden />
            Start over
          </Button>
        )}
      </div>

      <div className="flex min-h-[22rem] flex-col rounded-xl border bg-card">
        <ol aria-live="polite" className="flex flex-1 flex-col gap-4 p-4 md:p-5">
          {turns.length === 0 && (
            <li className="flex flex-col items-center gap-3 px-2 py-6 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="size-5" aria-hidden />
              </span>
              <div className="flex flex-col gap-1">
                <p className="text-base font-medium">Describe the scheduler you want</p>
                <p className="mx-auto max-w-md text-sm text-muted-foreground">
                  Say what the agent should do and when, in your own words. The agent drafts the scheduler; you review
                  it and create it with one click.
                </p>
              </div>
              <div className="mt-1 flex w-full max-w-xl flex-col gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="pressable rounded-lg border bg-background px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none max-md:min-h-11"
                    onClick={() => send(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </li>
          )}
          {turns.map((turn) =>
            turn.role === "user" ? (
              <li key={turn.id} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                  {turn.text}
                </p>
              </li>
            ) : (
              <li key={turn.id} className="flex gap-2.5">
                <AssistantAvatar />
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <RichText text={turn.text} className="text-sm" />
                  {turn.draft && (
                    <DraftCard
                      draft={turn.draft}
                      projectName={projectName(turn.draft.boardId)}
                      current={turn === latestDraftTurn}
                      creating={creating}
                      onCreate={() => void create(turn.draft!)}
                      onEdit={() => onEditInForm(turn.draft!)}
                    />
                  )}
                </div>
              </li>
            ),
          )}
          {busy && (
            <li className="flex items-center gap-2.5" role="status">
              <AssistantAvatar />
              <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
                <span className="truncate">{activity}</span>
              </span>
            </li>
          )}
          {failure && (
            <li role="alert" className="flex gap-2.5">
              <AssistantAvatar />
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
                <span className="min-w-0 flex-1">{failure}</span>
                {turns.at(-1)?.role === "user" && (
                  <Button variant="outline" size="sm" className="h-9 md:h-8" onClick={retry}>
                    <RotateCw aria-hidden />
                    Retry
                  </Button>
                )}
              </div>
            </li>
          )}
          {/* Scrolled into view on new content; the margin keeps it clear of the sticky composer. */}
          <li ref={endRef} aria-hidden className="-mt-4 scroll-mb-32" />
        </ol>

        <form
          className="glass-edge sticky bottom-0 z-10 rounded-b-xl border-t bg-card/95 p-3 backdrop-blur supports-backdrop-filter:bg-card/80"
          onSubmit={(event) => {
            event.preventDefault();
            send(input);
          }}
        >
          <div className="flex items-end gap-2 rounded-2xl border bg-background p-1.5 pl-1 shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
            <Textarea
              ref={inputRef}
              value={input}
              rows={1}
              autoFocus
              placeholder={
                latestDraftTurn ? "Ask for changes, e.g. “make it 10:00 on Fridays only”…" : "e.g. Every weekday at 9:00, triage new issues…"
              }
              aria-label="Message the scheduler agent"
              className="max-h-40 min-h-11 resize-none border-0 bg-transparent px-2.5 py-2.5 text-base shadow-none focus-visible:ring-0 md:min-h-9 md:py-2 md:text-sm dark:bg-transparent"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send(input);
                }
              }}
            />
            {busy ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Stop"
                title="Stop"
                className="size-11 shrink-0 rounded-xl pressable-icon md:size-9"
                onClick={() => controllerRef.current?.abort()}
              >
                <Square className="fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim()}
                aria-label="Send"
                title="Send (Enter)"
                className="size-11 shrink-0 rounded-xl pressable-icon md:size-9"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
          <p className="mt-1.5 flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
            <span className="min-w-0">Times are in {timezone} unless you name another time zone.</span>
            <span className="flex shrink-0 items-center gap-1 max-md:hidden" aria-hidden>
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
            </span>
          </p>
        </form>
      </div>
    </section>
  );
}

function AssistantAvatar() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden>
      <Bot className="size-4" />
    </span>
  );
}

/**
 * A proposed scheduler: project, schedule in words with its next runs, run limit and the brief
 * each card gets. Only the newest draft (`current`) can be created; older ones stay for reference.
 */
function DraftCard({
  draft,
  projectName,
  current,
  creating,
  onCreate,
  onEdit,
}: {
  draft: SchedulerDraft;
  projectName: string;
  current: boolean;
  creating: boolean;
  onCreate: () => void;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = draft.prompt.length > 280 || draft.prompt.split("\n").length > 5;
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-background p-4 transition-opacity",
        current ? "border-primary/40 shadow-xs" : "opacity-60",
      )}
      aria-label={`Scheduler draft: ${draft.name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p className="min-w-0 font-medium break-words">{draft.name}</p>
        </div>
        <Badge variant={current ? "secondary" : "outline"} className="shrink-0">
          {current ? "Draft" : "Earlier draft"}
        </Badge>
      </div>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="flex items-center gap-1.5 text-muted-foreground">
          <FolderGit2 className="size-3.5" aria-hidden />
          Project
        </dt>
        <dd className="min-w-0 truncate font-medium">{projectName}</dd>
        <dt className="flex items-center gap-1.5 text-muted-foreground">
          <CalendarClock className="size-3.5" aria-hidden />
          Schedule
        </dt>
        <dd className="min-w-0">
          <SchedulePreview value={draft} />
        </dd>
        <dt className="flex items-center gap-1.5 text-muted-foreground">
          <Repeat className="size-3.5" aria-hidden />
          Repeats
        </dt>
        <dd>
          {draft.maxRuns === null
            ? "Until you pause it"
            : draft.maxRuns === 1
              ? "Once"
              : `${draft.maxRuns.toLocaleString()} times`}
          {!draft.enabled && <span className="text-muted-foreground"> · created paused</span>}
        </dd>
      </dl>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">Each run creates a card with this brief</p>
        <div
          className={cn(
            "relative rounded-lg border bg-muted/40 px-3 py-2 text-sm",
            long && !expanded && "max-h-32 overflow-hidden",
          )}
        >
          <RichText text={draft.prompt} images="chip" />
          {long && !expanded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-lg bg-gradient-to-t from-background to-transparent" />
          )}
        </div>
        {long && (
          <button
            type="button"
            className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} aria-hidden />
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
      {current && (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" className="h-11 md:h-9" onClick={onEdit} disabled={creating}>
            <PencilLine aria-hidden />
            Edit in form
          </Button>
          <Button className="h-11 md:h-9" onClick={onCreate} disabled={creating}>
            {creating ? <Loader2 className="animate-spin" aria-hidden /> : <CalendarClock aria-hidden />}
            {creating ? "Creating…" : "Create scheduler"}
          </Button>
        </div>
      )}
    </div>
  );
}
