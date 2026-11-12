"use client";

import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Trello-style "Add a card" composer: Enter adds (and stays open for the next card),
 * Shift+Enter inserts a newline, Esc cancels.
 */
export function InlineComposer({
  onSubmit,
  onAdded,
}: {
  onSubmit: (title: string) => Promise<boolean>;
  onAdded?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const close = () => {
    setOpen(false);
    setTitle("");
  };

  const submit = async () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onSubmit(value);
    setBusy(false);
    if (ok) {
      setTitle("");
      onAdded?.();
    }
    inputRef.current?.focus();
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
      <Textarea
        ref={inputRef}
        autoFocus
        value={title}
        disabled={busy}
        rows={2}
        placeholder="Enter a title for this card…"
        aria-label="Card title"
        className="max-h-48 min-h-16 resize-none bg-card shadow-xs"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onBlur={() => {
          if (!title.trim() && !busy) close();
        }}
      />
      <div className="flex items-center gap-1.5">
        <Button
          type="submit"
          size="lg"
          disabled={!title.trim() || busy}
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
