"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSkillSlash } from "@/components/board/skill-slash-menu";
import { api } from "@/lib/api-client";
import {
  BRIEF_FILE,
  DESCRIPTION_MAX,
  type DraftCardInput,
  TITLE_MAX,
  draftToCard,
  fallbackDraft,
} from "@/lib/card-draft";
import type { CardDraft } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface NewTaskInput extends DraftCardInput {
  /** Create in "In progress" and start the agent right away. */
  start: boolean;
}

/** Progress lines kept on screen while the card agent works. */
const ACTIVITY_LINES = 4;

/**
 * `compose`: the user types freely. `writing`: the card agent turns the text into a card, then
 * shows it for review or creates it right away (`next`). `review`: title and brief to check and
 * edit before creating; `error` is set when the agent failed and the text is used as typed.
 */
type Phase =
  | { kind: "compose" }
  | { kind: "writing"; next: "review" | "create"; activity: string[] }
  | { kind: "review"; draft: CardDraft; model: string | null; error: string | null };

function StartSwitch({ id, checked, onChange }: { id: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-2.5"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">Start agent now</span>
        <span className="text-xs text-muted-foreground">Creates the card in In progress and starts the agent.</span>
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/**
 * New card from free text: the user writes as much as they like, an omp agent (the card writer)
 * reads it and the project and turns it into a title and a brief, which the user can review and
 * edit before the card is created.
 */
export function NewTaskForm({
  boardId,
  onSubmit,
  onCancel,
  defaultStart = false,
  projectField,
  className,
}: {
  /** Project the card goes to; the card agent works in its folders. Null until one is picked. */
  boardId: string | null;
  /** Resolves true when the card was created (the form then resets). */
  onSubmit: (input: NewTaskInput) => Promise<boolean>;
  onCancel?: () => void;
  /**
   * "Start agent now" until the user flips it: the project's auto-run, or on for `Shift+N` and
   * "New card & start agent". May change while open (the project picker).
   */
  defaultStart?: boolean;
  /** Rendered first, e.g. a project picker when not on a board. */
  projectField?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "compose" });
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);
  const setReviewDescription = (description: string) =>
    setPhase((current) =>
      current.kind === "review" ? { ...current, draft: { ...current.draft, description } } : current,
    );
  // "/" pickers for OMP skills and shortcuts, one per editable textarea.
  const composeSlash = useSkillSlash(composeRef, text, setText, phase.kind === "compose");
  const reviewSlash = useSkillSlash(
    reviewRef,
    phase.kind === "review" ? phase.draft.description : "",
    setReviewDescription,
    phase.kind === "review",
  );
  /** The user's own choice; `null` follows `defaultStart`. */
  const [startChoice, setStartChoice] = useState<boolean | null>(null);
  const start = startChoice ?? defaultStart;
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Closing the form stops the card agent.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Another project: a running write belongs to the old one, and so do the cards to wait for.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase((current) =>
      current.kind === "writing"
        ? { kind: "compose" }
        : current.kind === "review" && current.draft.waitFor.length > 0
          ? { ...current, draft: { ...current.draft, waitFor: [] } }
          : current,
    );
  }, [boardId]);

  const create = async (draft: CardDraft): Promise<boolean> => {
    if (!draft.title.trim() || busy) return false;
    setBusy(true);
    const ok = await onSubmit({ ...draftToCard(draft, text), start });
    setBusy(false);
    if (ok) {
      setText("");
      setPhase({ kind: "compose" });
      setStartChoice(null);
    }
    return ok;
  };

  const write = async (next: "review" | "create") => {
    const value = text.trim();
    if (!value || phase.kind === "writing" || busy) return;
    if (!boardId) {
      toast.error("Pick a project for the card first");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "writing", next, activity: [] });
    try {
      const { draft, model } = await api.tasks.draft(boardId, value, {
        signal: controller.signal,
        onActivity: (line) =>
          setPhase((current) =>
            current.kind === "writing"
              ? { ...current, activity: [...current.activity, line].slice(-ACTIVITY_LINES) }
              : current,
          ),
      });
      if (controller.signal.aborted) return;
      abortRef.current = null;
      if (next === "create" && (await create(draft))) return;
      setPhase({ kind: "review", draft, model, error: null });
    } catch (err) {
      if (controller.signal.aborted) return;
      abortRef.current = null;
      const error = err instanceof Error ? err.message : "Something went wrong";
      setPhase({ kind: "review", draft: fallbackDraft(value), model: null, error });
    }
  };

  /** Stop the card agent: back to the text (`review: false`) or on with the text as typed. */
  const stop = (review: boolean) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase(review ? { kind: "review", draft: fallbackDraft(text), model: null, error: null } : { kind: "compose" });
  };

  const submitKeys = (event: KeyboardEvent, action: () => void) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      action();
    }
  };

  const startSwitch = <StartSwitch id={`${id}-start`} checked={start} onChange={setStartChoice} />;
  const createLabel = start ? "Create & start" : "Create card";

  if (phase.kind === "review") {
    const { draft, model, error } = phase;
    const update = (patch: Partial<CardDraft>) =>
      setPhase((current) => (current.kind === "review" ? { ...current, draft: { ...current.draft, ...patch } } : current));
    const attached = draftToCard(draft, text).brief !== undefined;
    return (
      <form
        className={cn("flex flex-col gap-4", className)}
        onSubmit={(event) => {
          event.preventDefault();
          void create(draft);
        }}
      >
        {projectField}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>The card agent couldn't write this card</AlertTitle>
            <AlertDescription>
              {error} Your text is used as typed below; check it, or try the agent again.
            </AlertDescription>
          </Alert>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 shrink-0" aria-hidden />
            {model ? `Written by the card agent (${model}). ` : "Your text as typed. "}
            Edit anything before you create it.
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-title`}>Title</Label>
          <Input
            id={`${id}-title`}
            autoFocus
            required
            value={draft.title}
            maxLength={TITLE_MAX}
            className="h-11 text-base md:h-9 md:text-sm"
            onChange={(event) => update({ title: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-description`}>Description</Label>
          <Textarea
            id={`${id}-description`}
            ref={reviewRef}
            value={draft.description}
            maxLength={DESCRIPTION_MAX}
            className="max-h-[38dvh] min-h-32 resize-none font-mono text-sm md:text-xs"
            onChange={(event) => update({ description: event.target.value })}
            onSelect={reviewSlash.onSelect}
            onKeyDown={(event) => {
              if (reviewSlash.onKeyDown(event)) return;
              submitKeys(event, () => void create(draft));
            }}
          />
          {reviewSlash.menu}
          {attached && (
            <p className="text-xs text-muted-foreground">
              Your full text is attached to the card as <span className="font-medium text-foreground">{BRIEF_FILE}</span>{" "}
              for the agent to read.
            </p>
          )}
        </div>
        <label
          htmlFor={`${id}-orchestrate`}
          className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-2.5"
        >
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Parallel subagents</span>
            <span className="text-xs text-muted-foreground">
              For large work: omp splits the card into parts that subagents do at the same time.
            </span>
          </span>
          <Switch
            id={`${id}-orchestrate`}
            checked={draft.orchestrate}
            onCheckedChange={(orchestrate) => update({ orchestrate })}
          />
        </label>
        {draft.waitFor.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Runs after</span>
            <ul className="flex flex-wrap gap-1.5">
              {draft.waitFor.map((card) => (
                <li
                  key={card.id}
                  className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-xs"
                >
                  <span className="truncate">{card.title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Don't wait for ${card.title}`}
                    onClick={() => update({ waitFor: draft.waitFor.filter((c) => c.id !== card.id) })}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {startSwitch}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
          <Button type="button" variant="ghost" className="h-11 md:h-9 sm:mr-auto" onClick={() => setPhase({ kind: "compose" })}>
            <ArrowLeft />
            Edit text
          </Button>
          {error && (
            <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => void write("review")}>
              <RotateCcw />
              Try the agent again
            </Button>
          )}
          <Button type="submit" className="h-11 md:h-9" disabled={!draft.title.trim() || busy}>
            {busy ? "Creating…" : createLabel}
          </Button>
        </div>
      </form>
    );
  }

  const writing = phase.kind === "writing" ? phase : null;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <form
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        void write("create");
      }}
    >
      {projectField}
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-text`}>What should the agent do?</Label>
        <Textarea
          id={`${id}-text`}
          ref={composeRef}
          autoFocus
          value={text}
          readOnly={writing !== null}
          placeholder="Write it your way, as long as you like: the goal, details, pasted errors or logs, links…"
          className="max-h-[45dvh] min-h-36 resize-none text-base md:text-sm"
          onChange={(event) => setText(event.target.value)}
          onSelect={composeSlash.onSelect}
          onKeyDown={(event) => {
            if (composeSlash.onKeyDown(event)) return;
            submitKeys(event, () => void write("create"));
          }}
        />
        {composeSlash.menu}
        <p className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
          <span className="flex items-start gap-1.5">
            <Sparkles className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              An agent reads your text and the project, then writes the title and brief. Type <Kbd>/</Kbd> to add an
              OMP skill or shortcut.
            </span>
          </span>
          {words > 0 && <span className="shrink-0 tabular-nums">{words.toLocaleString()} words</span>}
        </p>
      </div>
      {writing && (
        <div role="status" aria-live="polite" className="flex flex-col gap-1.5 rounded-lg border bg-muted/40 px-3 py-2.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Writing the card…
          </span>
          {writing.activity.length > 0 && (
            <ul className="flex flex-col gap-0.5 pl-6 text-xs text-muted-foreground">
              {writing.activity.map((line, index) => (
                <li
                  key={`${index}:${line}`}
                  className={cn("truncate", index === writing.activity.length - 1 && "text-foreground")}
                >
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {startSwitch}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {writing ? (
          <>
            <Button type="button" variant="ghost" className="h-11 md:h-9 sm:mr-auto" onClick={() => stop(false)}>
              Stop
            </Button>
            <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => stop(true)}>
              Use my text as typed
            </Button>
          </>
        ) : (
          <>
            {onCancel && (
              <Button type="button" variant="ghost" className="h-11 md:h-9 sm:mr-auto" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="h-11 md:h-9"
              disabled={!text.trim()}
              onClick={() => void write("review")}
            >
              Review first
            </Button>
          </>
        )}
        <Button type="submit" className="h-11 md:h-9" disabled={!text.trim() || writing !== null || busy}>
          {writing?.next === "create" || busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
          {busy ? "Creating…" : createLabel}
        </Button>
      </div>
    </form>
  );
}

/** "New card" form as a bottom drawer on phones and a centered dialog elsewhere. */
export function NewTaskDialog({
  open,
  onOpenChange,
  isMobile,
  boardId,
  defaultStart,
  projectField,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
  /** Project the card goes to; null until one is picked. */
  boardId: string | null;
  defaultStart?: boolean;
  projectField?: ReactNode;
  onCreate: (input: NewTaskInput) => Promise<boolean>;
}) {
  const submit = async (input: NewTaskInput) => {
    const ok = await onCreate(input);
    if (ok) onOpenChange(false);
    return ok;
  };

  const form = (
    <NewTaskForm
      boardId={boardId}
      onSubmit={submit}
      onCancel={() => onOpenChange(false)}
      defaultStart={defaultStart}
      projectField={projectField}
    />
  );
  const description = "Describe it in your own words. An agent turns it into a clear card.";

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[92dvh]">
          <DrawerHeader className="text-left">
            <DrawerTitle>New card</DrawerTitle>
            <DrawerDescription>{description}</DrawerDescription>
          </DrawerHeader>
          <div className="overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">{form}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {form}
        <p className="-mt-1 text-xs text-muted-foreground max-md:hidden">
          <Kbd>Ctrl</Kbd>
          <Kbd>↵</Kbd> or <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> creates. Press <Kbd>N</Kbd> anywhere for a new card, <Kbd>⇧</Kbd>
          <Kbd>N</Kbd> to always start its agent.
        </p>
      </DialogContent>
    </Dialog>
  );
}
