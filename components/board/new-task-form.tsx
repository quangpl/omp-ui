"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
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
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSkillSlash } from "@/components/board/skill-slash-menu";
import { cn } from "@/lib/utils";

/** Resolves true when the card was created (the form then resets). */
export type CreateFromText = (text: string) => Promise<boolean>;

/**
 * New card from free text: the user writes as much as they like and creates it right away. The
 * card lands in In progress; an omp agent (the card writer) reads the text and the project in
 * the background, writes the title and brief, then the card's agent starts. Nobody waits for it.
 */
export function NewTaskForm({
  onSubmit,
  onCancel,
  projectField,
  className,
}: {
  onSubmit: CreateFromText;
  onCancel?: () => void;
  /** Rendered first, e.g. a project picker when not on a board. */
  projectField?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  // "/" picker for OMP skills and shortcuts.
  const slash = useSkillSlash(composeRef, text, setText, !busy);

  const create = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onSubmit(value);
    setBusy(false);
    if (ok) setText("");
  };

  const submitKeys = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void create();
    }
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <form
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        void create();
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
          readOnly={busy}
          placeholder="Goal, details, pasted errors or logs, links…"
          className="max-h-[45dvh] min-h-36 resize-none text-base md:text-sm"
          onChange={(event) => setText(event.target.value)}
          onSelect={slash.onSelect}
          onKeyDown={(event) => {
            if (slash.onKeyDown(event)) return;
            submitKeys(event);
          }}
        />
        {slash.menu}
        <p className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
          <span className="flex items-start gap-1.5">
            <Sparkles className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              Goes straight to In progress. An agent writes the title and brief from your text and the project,
              then starts work. Type <Kbd>/</Kbd> for OMP skills and shortcuts.
            </span>
          </span>
          {words > 0 && <span className="shrink-0 tabular-nums">{words.toLocaleString()} words</span>}
        </p>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {onCancel && (
          <Button type="button" variant="ghost" className="h-11 md:h-9 sm:mr-auto" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" className="h-11 md:h-9" disabled={!text.trim() || busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
          {busy ? "Creating…" : "Create card"}
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
  projectField,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
  projectField?: ReactNode;
  onCreate: CreateFromText;
}) {
  const submit = async (text: string) => {
    const ok = await onCreate(text);
    if (ok) onOpenChange(false);
    return ok;
  };

  const form = <NewTaskForm onSubmit={submit} onCancel={() => onOpenChange(false)} projectField={projectField} />;
  const description = "Describe the task. An agent turns it into a card in the background.";

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
          <Kbd>↵</Kbd> creates. Press <Kbd>N</Kbd> anywhere for a new card.
        </p>
      </DialogContent>
    </Dialog>
  );
}
