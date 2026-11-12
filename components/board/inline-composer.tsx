"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSkillSlash } from "@/components/board/skill-slash-menu";
import type { DraftProgress } from "@/lib/api-client";
import { isPlainTitle } from "@/lib/card-draft";

/** Create a card from the composer's text; resolves true when it was created. */
export type QuickCreate = (text: string, progress: DraftProgress) => Promise<boolean>;

/**
 * Trello-style "Add a card" composer: Enter adds (and stays open for the next card),
 * Shift+Enter inserts a newline, Esc cancels. A short line is the title as typed; longer text
 * goes through the card agent first (its progress shows here; Esc stops it).
 */
export function InlineComposer({
  onSubmit,
  onAdded,
}: {
  onSubmit: QuickCreate;
  onAdded?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /** Card agent progress while it writes the card; null when it isn't running. */
  const [activity, setActivity] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** "/" picker for OMP skills and shortcuts. */
  const slash = useSkillSlash(inputRef, text, setText, open && !busy);

  useEffect(() => () => abortRef.current?.abort(), []);

  const close = () => {
    setOpen(false);
    setText("");
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    if (!isPlainTitle(value)) setActivity("Writing the card…");
    const ok = await onSubmit(value, { signal: controller.signal, onActivity: setActivity });
    if (abortRef.current === controller) abortRef.current = null;
    setBusy(false);
    setActivity(null);
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
      <Textarea
        ref={inputRef}
        autoFocus
        value={text}
        readOnly={busy}
        rows={2}
        placeholder="Type a title, or describe the task in your own words…"
        aria-label="Card title"
        className="max-h-48 min-h-16 resize-none bg-card shadow-xs"
        onChange={(event) => setText(event.target.value)}
        onSelect={slash.onSelect}
        onKeyDown={(event) => {
          if (slash.onKeyDown(event)) return;
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            if (abortRef.current) abortRef.current.abort();
            else close();
          }
        }}
        onBlur={() => {
          if (!text.trim() && !busy) close();
        }}
      />
      {slash.menu}
      {activity !== null && (
        <p role="status" className="flex items-center gap-1.5 px-0.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
          <span className="truncate">{activity}</span>
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <Button
          type="submit"
          size="lg"
          disabled={!text.trim() || busy}
          onMouseDown={(event) => event.preventDefault()}
        >
          {activity !== null ? "Writing card…" : "Add card"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={busy ? "Stop" : "Cancel"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => (abortRef.current ? abortRef.current.abort() : close())}
        >
          <X />
        </Button>
      </div>
    </form>
  );
}
