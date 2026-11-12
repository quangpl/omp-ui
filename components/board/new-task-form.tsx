"use client";

import { useId, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface NewTaskInput {
  title: string;
  description: string;
  /** Create in "In progress" and start the agent right away. */
  start: boolean;
}

export function NewTaskForm({
  onSubmit,
  onCancel,
  className,
}: {
  /** Resolves true when the card was created (the form then resets). */
  onSubmit: (input: NewTaskInput) => Promise<boolean>;
  onCancel?: () => void;
  className?: string;
}) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const ok = await onSubmit({ title: trimmed, description: description.trim(), start });
    setBusy(false);
    if (ok) {
      setTitle("");
      setDescription("");
      setStart(false);
    }
  };

  return (
    <form
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          autoFocus
          required
          value={title}
          maxLength={500}
          placeholder="e.g. Add dark mode to the settings page"
          className="h-11 text-base md:h-9 md:text-sm"
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-description`}>
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={`${id}-description`}
          value={description}
          placeholder="What should the agent do? Add context, acceptance criteria, files to look at…"
          className="max-h-[40dvh] min-h-28 resize-none text-base md:text-sm"
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <label
        htmlFor={`${id}-start`}
        className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-2.5"
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Start agent now</span>
          <span className="text-xs text-muted-foreground">
            Creates the card in In progress and starts the agent.
          </span>
        </span>
        <Switch id={`${id}-start`} checked={start} onCheckedChange={setStart} />
      </label>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button type="button" variant="outline" className="h-11 md:h-9" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" className="h-11 md:h-9" disabled={!title.trim() || busy}>
          {busy ? "Creating…" : start ? "Create & start" : "Create card"}
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
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
  onCreate: (input: NewTaskInput) => Promise<boolean>;
}) {
  const submit = async (input: NewTaskInput) => {
    const ok = await onCreate(input);
    if (ok) onOpenChange(false);
    return ok;
  };

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[92dvh]">
          <DrawerHeader className="text-left">
            <DrawerTitle>New card</DrawerTitle>
            <DrawerDescription>Describe the task for the agent.</DrawerDescription>
          </DrawerHeader>
          <div className="overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <NewTaskForm onSubmit={submit} onCancel={() => onOpenChange(false)} />
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
          <DialogDescription>Describe the task for the agent.</DialogDescription>
        </DialogHeader>
        <NewTaskForm onSubmit={submit} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
