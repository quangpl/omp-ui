"use client";

import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useComposerAutocomplete } from "@/components/board/composer-autocomplete";
import { cn } from "@/lib/utils";

/** Resolves true when the card was created (the form then resets). */
export type CreateFromText = (text: string) => Promise<boolean>;

/** Default footer hint: what happens on create, then the composer keys. */
const DEFAULT_HINT = (
  <>
    An agent writes the title and brief, then starts it in In progress.{" "}
    <span className="whitespace-nowrap">
      <Kbd>/</Kbd> skills · <Kbd>@</Kbd> files · <Kbd>Tab</Kbd> completes
    </span>
  </>
);

/**
 * New task from free text: the user writes as much as they like and creates it right away. The
 * card lands in In progress; an omp agent (the card writer) reads the text and the project in
 * the background, writes the title and brief, then the card's agent starts. Nobody waits for it.
 *
 * `layout="page"` fills its flex-column parent (the phone "New task" page): the textarea takes
 * all the free height and scrolls inside, and Create is a full-width bar pinned to the bottom.
 * The page owns Cancel there, so `onCancel` is only rendered in the dialog layout.
 *
 * The copy, extra fields (`children`) and submit gating are overridable so other free-text flows
 * (e.g. the "New scheduler" page) reuse the same composer.
 */
export function NewTaskForm({
  onSubmit,
  onCancel,
  projectField,
  layout = "dialog",
  initialText = "",
  onTextChange,
  className,
  boardId,
  submitLabel = "Create task",
  busyLabel = "Creating…",
  label = "What should the agent do?",
  hint,
  children,
  canSubmit = true,
  resetOnSubmit = true,
  autoFocus = true,
}: {
  onSubmit: CreateFromText;
  onCancel?: () => void;
  /** Rendered first, e.g. a project picker when not on a board. */
  projectField?: ReactNode;
  layout?: "dialog" | "page";
  /** Starting text, e.g. a draft carried over from another project. */
  initialText?: string;
  /** Every text change, for callers that keep the draft around. */
  onTextChange?: (text: string) => void;
  className?: string;
  /** Project whose files the "@" picker searches; without one "@" is plain text. */
  boardId?: string | null;
  /** Submit button text. */
  submitLabel?: string;
  /** Submit button text while `onSubmit` is pending. */
  busyLabel?: string;
  /** Label of the textarea. */
  label?: ReactNode;
  /** Replaces the default explanation under the textarea (shown next to the word count). */
  hint?: ReactNode;
  /** Extra fields after the text block, before the submit button(s). */
  children?: ReactNode;
  /** Extra submit gate, AND'ed with "the text is not empty" (e.g. the extra fields are valid). */
  canSubmit?: boolean;
  /** Clear the text after a successful submit. */
  resetOnSubmit?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [text, setTextState] = useState(initialText);
  const [busy, setBusy] = useState(false);
  /** The last submit failed (the caller toasted why); cleared as soon as the text changes. */
  const [failed, setFailed] = useState(false);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const setText = (next: string) => {
    setTextState(next);
    setFailed(false);
    onTextChange?.(next);
  };
  // "/" skills and shortcuts, "@" project files, "skill://" skill names.
  const slash = useComposerAutocomplete(composeRef, text, setText, { enabled: !busy, boardId });

  const create = async () => {
    const value = text.trim();
    if (!value || busy || !canSubmit) return;
    setBusy(true);
    setFailed(false);
    const ok = await onSubmit(value);
    setBusy(false);
    if (!ok) setFailed(true);
    else if (resetOnSubmit) setText("");
  };

  const submitKeys = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void create();
    }
  };

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    void create();
  };

  const page = layout === "page";
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const wordCount = words > 0 && <span className="shrink-0 tabular-nums">{words.toLocaleString()} words</span>;
  const labelNode = <Label htmlFor={`${id}-text`}>{label}</Label>;
  const errorId = `${id}-error`;
  // Inline, under the field: the text is kept so the user can retry without retyping.
  const errorNode = failed && (
    <p id={errorId} role="alert" className="animate-fade-in-soft text-sm text-destructive md:text-xs">
      Didn&apos;t go through. Your text is kept, so you can try again.
    </p>
  );
  const textarea = (
    // `relative` anchors the word ghost on the textarea; on the page the wrapper takes over the
    // textarea's flex sizing (and its minimum) so the textarea still fills the free height.
    <div className={page ? "relative flex min-h-24 flex-1 flex-col" : "relative"}>
      <Textarea
        id={`${id}-text`}
        ref={composeRef}
        autoFocus={autoFocus}
        value={text}
        readOnly={busy}
        placeholder="Goal, details, pasted errors or logs, links…"
        className={
          page
            ? // Fixed sizing so the flex height wins over the content height and long text scrolls inside.
              "min-h-24 flex-1 resize-none field-sizing-fixed text-base md:text-sm"
            : "max-h-[45dvh] min-h-36 resize-none text-base md:text-sm"
        }
        aria-autocomplete="list"
        aria-invalid={failed || undefined}
        aria-describedby={failed ? errorId : undefined}
        aria-expanded={slash.open}
        data-suggesting={slash.suggesting || undefined}
        onChange={(event) => setText(event.target.value)}
        onSelect={slash.onSelect}
        onKeyDown={(event) => {
          if (slash.onKeyDown(event)) return;
          submitKeys(event);
        }}
      />
      {slash.ghost}
    </div>
  );
  const submitContent = (
    <>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
      {busy ? busyLabel : submitLabel}
    </>
  );
  const disabled = !text.trim() || busy || !canSubmit;

  if (page) {
    return (
      <form className={cn("flex min-h-0 flex-1 flex-col", className)} onSubmit={onFormSubmit}>
        {/* Normally nothing here overflows (the textarea absorbs the height); the scroll is a
            fallback for very short viewports, e.g. the keyboard plus the open slash menu. */}
        <div className="scrollbar-subtle mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pt-4 pb-3 sm:px-6">
          {projectField}
          <div className="flex flex-1 flex-col gap-2">
            {labelNode}
            {textarea}
            {errorNode}
            {slash.suggestion}
            {slash.menu ?? (
              <p className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
                <span className="flex items-start gap-1.5">
                  <Sparkles className="mt-px size-3.5 shrink-0" aria-hidden />
                  <span>{hint ?? DEFAULT_HINT}</span>
                </span>
                {wordCount}
              </p>
            )}
          </div>
          {children}
        </div>
        {/* `--new-card-bottom-inset` lets the page drop the home-indicator gap while the keyboard covers it. */}
        <div className="px-safe glass-edge shrink-0 border-t bg-background/85 backdrop-blur-lg supports-backdrop-filter:bg-background/70">
          <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 pt-3 pb-[calc(0.75rem+var(--new-card-bottom-inset,env(safe-area-inset-bottom)))] sm:px-6">
            <p className="hidden text-xs text-muted-foreground md:block">
              <Kbd>Ctrl</Kbd>
              <Kbd>↵</Kbd> or <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd> creates
            </p>
            <Button
              type="submit"
              className="h-12 w-full text-[0.95rem] pressable md:ml-auto md:h-10 md:w-auto md:px-5 md:text-sm"
              disabled={disabled}
            >
              {submitContent}
            </Button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <form className={cn("flex flex-col gap-4", className)} onSubmit={onFormSubmit}>
      {projectField}
      <div className="flex flex-col gap-2">
        {labelNode}
        {textarea}
        {errorNode}
        {slash.suggestion}
        {slash.menu}
        <p className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
          <span className="flex items-start gap-1.5">
            <Sparkles className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{hint ?? DEFAULT_HINT}</span>
          </span>
          {wordCount}
        </p>
      </div>
      {children}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {onCancel && (
          <Button type="button" variant="ghost" className="h-11 pressable md:h-9 sm:mr-auto" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" className="h-11 pressable md:h-9" disabled={disabled}>
          {submitContent}
        </Button>
      </div>
    </form>
  );
}

/** "New task" form in a centered dialog. Phones use the `/b/[boardId]/new` page instead. */
export function NewTaskDialog({
  open,
  onOpenChange,
  projectField,
  onCreate,
  boardId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectField?: ReactNode;
  onCreate: CreateFromText;
  /** Project whose files the "@" picker searches. */
  boardId?: string | null;
}) {
  const submit = async (text: string) => {
    const ok = await onCreate(text);
    if (ok) onOpenChange(false);
    return ok;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        // Radix sees Escape before the textarea does: with the suggestions or a word completion
        // showing, Escape only hides them (the textarea's handler), never the dialog and its draft.
        onEscapeKeyDown={(event) => {
          if (
            event.target instanceof HTMLElement &&
            (event.target.getAttribute("aria-expanded") === "true" || event.target.hasAttribute("data-suggesting"))
          ) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>Describe the task. An agent turns it into a card in the background.</DialogDescription>
        </DialogHeader>
        <NewTaskForm
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          projectField={projectField}
          boardId={boardId}
        />
        <p className="-mt-1 text-xs text-muted-foreground max-md:hidden">
          <Kbd>Ctrl</Kbd>
          <Kbd>↵</Kbd> or <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> creates. Press <Kbd>N</Kbd> anywhere for a new task.
        </p>
      </DialogContent>
    </Dialog>
  );
}
