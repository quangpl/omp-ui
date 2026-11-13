"use client";

import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useComposerAutocomplete } from "@/components/board/composer-autocomplete";

/** Create a card from the composer's text; resolves true when it was created. */
export type QuickCreate = (text: string) => Promise<boolean>;

/**
 * Trello-style "Add a card" composer: Enter adds (and stays open for the next card),
 * Shift+Enter inserts a newline, Esc cancels. The card is created right away; the card agent
 * turns longer text into its title and brief in the background.
 */
export function InlineComposer({
  onSubmit,
  onAdded,
  boardId,
}: {
  onSubmit: QuickCreate;
  onAdded?: () => void;
  /** Project whose files the "@" picker searches. */
  boardId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** "/" skills and shortcuts, "@" project files, "skill://" skill names. */
  const slash = useComposerAutocomplete(inputRef, text, setText, { enabled: open && !busy, boardId });

  const close = () => {
    setOpen(false);
    setText("");
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onSubmit(value);
    setBusy(false);
    if (ok) {
      setText("");
      onAdded?.();
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  if (!open) {
    return (
      <Button
        variant="ghost"
        className="h-10 w-full justify-start gap-2 px-2.5 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Plus />
        Add a card
      </Button>
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {/* `relative` anchors the word ghost on the textarea. */}
      <div className="relative">
        <Textarea
          ref={inputRef}
          autoFocus
          value={text}
          readOnly={busy}
          rows={2}
          placeholder="Type a title or describe the task…"
          aria-label="Card title"
          className="max-h-48 min-h-16 resize-none bg-card shadow-xs"
          onChange={(event) => setText(event.target.value)}
          onSelect={slash.onSelect}
          onKeyDown={(event) => {
            // Escape with a word suggestion showing only hides it; the composer stays open.
            if (slash.onKeyDown(event)) return;
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          onBlur={() => {
            if (!text.trim() && !busy) close();
          }}
        />
        {slash.ghost}
      </div>
      {slash.suggestion}
      {slash.menu}
      <div className="flex items-center gap-1.5">
        <Button
          type="submit"
          size="lg"
          disabled={!text.trim() || busy}
          onMouseDown={(event) => event.preventDefault()}
        >
          Add card
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label="Cancel"
          onMouseDown={(event) => event.preventDefault()}
          onClick={close}
        >
          <X />
        </Button>
      </div>
    </form>
  );
}
