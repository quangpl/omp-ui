"use client";

import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Check, type LucideIcon, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from "@/components/ui/context-menu";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

/** One Files-tree action, rendered as a context-menu item (desktop) or a drawer row (phones). */
export interface FileAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
}

/** Actions in separated groups, in menu order. */
export type FileActionGroups = FileAction[][];

/** Right-click menu items for a tree target. */
export function FileMenuItems({ groups }: { groups: FileActionGroups }) {
  return groups.map((group, index) => (
    <Fragment key={group[0]?.id ?? index}>
      {index > 0 && <ContextMenuSeparator />}
      {group.map((action) => (
        <ContextMenuItem
          key={action.id}
          disabled={action.disabled}
          variant={action.destructive ? "destructive" : "default"}
          onSelect={action.run}
        >
          <action.icon />
          {action.label}
          {action.shortcut && <ContextMenuShortcut>{action.shortcut}</ContextMenuShortcut>}
        </ContextMenuItem>
      ))}
    </Fragment>
  ));
}

/**
 * Phones: the same actions as a bottom sheet of thumb-sized rows. Pointer events stop here so a
 * card drawer around the tree doesn't start dragging, and closing never steals focus back (an
 * action may have just focused an inline name input).
 */
export function FileActionsDrawer({
  open,
  onOpenChange,
  title,
  description,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  groups: FileActionGroups;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="data-[vaul-drawer-direction=bottom]:max-h-[85dvh]"
        onPointerDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DrawerHeader className="pb-2 text-left">
          <DrawerTitle className="truncate text-lg">{title}</DrawerTitle>
          <DrawerDescription className="truncate font-mono text-xs">{description}</DrawerDescription>
        </DrawerHeader>
        <div
          data-vaul-no-drag
          className="flex flex-col overflow-y-auto overscroll-contain px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
        >
          {groups.map((group, index) => (
            <div key={group[0]?.id ?? index} className="flex flex-col">
              {index > 0 && <div role="separator" className="mx-3 my-1 h-px bg-border" />}
              {group.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  disabled={action.disabled}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-base outline-none hover:bg-accent focus-visible:bg-accent active:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0",
                    action.destructive ? "text-destructive" : "[&_svg]:text-muted-foreground",
                  )}
                  onClick={() => {
                    // Close first so the drawer's focus trap is gone before the action focuses an
                    // inline name input, still inside the tap (lets phones open the keyboard).
                    flushSync(() => onOpenChange(false));
                    action.run();
                  }}
                >
                  <action.icon aria-hidden />
                  {action.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** Permanent-delete confirmation for a file or folder. */
export function DeleteFileDialog({
  open,
  onOpenChange,
  name,
  dir,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  dir: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-vaul-no-drag>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {dir ? "This permanently deletes the folder and everything in it." : "This permanently deletes the file."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="max-md:h-11 max-md:w-full">Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" className="max-md:h-11 max-md:w-full" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Why `name` can't be a new file/folder name ("/" makes nested paths), or null when it can. */
export function invalidName(name: string): string | null {
  if (!name) return "Enter a name.";
  if (name.includes("\\")) return "Names can't contain \\.";
  const parts = name.replace(/\/+$/, "").split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return "Enter a valid name.";
  return null;
}

/** Keeps focus in the input when its ✓ / ✕ buttons are tapped (no blur-cancel first). */
function keepFocus(event: ReactPointerEvent) {
  event.preventDefault();
}

/** How long a closing context menu or drawer may still pull focus away (vaul closes in 500ms). */
const SETTLE_MS = 700;

/** A context menu or drawer on its way out (still mounted for its exit animation). */
const CLOSING_OVERLAY = '[role="menu"][data-state="closed"], [role="dialog"][data-state="closed"]';

/** Whether focus sits nowhere, or in an overlay that is closing. */
function focusAdrift(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.closest(CLOSING_OVERLAY) !== null;
}

/**
 * VSCode-style inline name field for new and renamed tree items. Enter commits, Escape cancels;
 * blur cancels when empty and commits otherwise on desktop (phones keep the field and offer ✓ / ✕).
 * `onSubmit` resolves to an error to show, or null once the item was created/renamed. `fromBlur`
 * tells both callbacks that focus already moved elsewhere (don't pull it back).
 */
export function InlineNameInput({
  initial = "",
  selectEnd,
  label,
  isMobile,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  /** Preselect `initial` up to here (a file's name without its extension). */
  selectEnd?: number;
  label: string;
  isMobile: boolean;
  onSubmit: (name: string, fromBlur: boolean) => Promise<string | null>;
  onCancel: (fromBlur: boolean) => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Set once committed or cancelled; later blurs (from unmounting) do nothing. */
  const doneRef = useRef(false);
  const busyRef = useRef(false);
  /** True right after mounting, while a closing menu / drawer may still shuffle focus around. */
  const settlingRef = useRef(true);

  // Layout effect: focusing inside the tap's commit lets iOS open the keyboard. A context menu or
  // drawer closing in the same commit still traps focus (and later drops it on <body>), so focus is
  // taken back on the following frames until it has gone.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const focusInput = () => {
      input.focus();
      // Preselect only while nothing was typed yet.
      if (input.value === initial) input.setSelectionRange(0, selectEnd ?? input.value.length);
    };
    focusInput();
    settlingRef.current = true;
    const until = performance.now() + SETTLE_MS;
    let frame = 0;
    const settle = () => {
      if (doneRef.current) return;
      if (document.activeElement !== input && focusAdrift()) focusInput();
      if (performance.now() < until) frame = requestAnimationFrame(settle);
      else settlingRef.current = false;
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
    // Mount only: the preselection applies to the initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = (fromBlur: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel(fromBlur);
  };

  const submit = async (fromBlur: boolean) => {
    if (doneRef.current || busyRef.current) return;
    const name = value.trim();
    if (!name && fromBlur) return cancel(true);
    const invalid = invalidName(name);
    if (invalid) {
      if (fromBlur) return cancel(true);
      setError(invalid);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const failed = await onSubmit(name, fromBlur);
    busyRef.current = false;
    setBusy(false);
    if (failed === null) {
      doneRef.current = true;
      return;
    }
    // Focus already moved on: report and drop the field instead of pulling focus back.
    if (fromBlur) {
      toast.error(failed);
      return cancel(true);
    }
    setError(failed);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submit(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel(false);
    }
  };

  const shownError = value.includes("\\") ? "Names can't contain \\." : error;

  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-1">
        <input
          ref={inputRef}
          value={value}
          readOnly={busy}
          aria-label={label}
          aria-invalid={shownError !== null || undefined}
          enterKeyHint="done"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "h-9 w-full min-w-0 rounded-sm border border-ring bg-background px-1.5 text-base outline-none select-text md:h-6 md:text-sm",
            shownError && "border-destructive",
          )}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            if (doneRef.current || busyRef.current) return;
            // Focus shuffled by a closing menu or drawer, not the user: the settle loop takes it back.
            const to = event.relatedTarget;
            if (settlingRef.current && (to === null || to.closest(CLOSING_OVERLAY))) return;
            if (!value.trim()) cancel(true);
            else if (!isMobile) void submit(true);
          }}
        />
        {isMobile && (
          <>
            <button
              type="button"
              aria-label="Save name"
              disabled={busy}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-primary hover:bg-accent active:bg-accent disabled:opacity-50"
              onPointerDown={keepFocus}
              onClick={() => void submit(false)}
            >
              <Check className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Cancel"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent active:bg-accent"
              onPointerDown={keepFocus}
              onClick={() => cancel(false)}
            >
              <X className="size-5" aria-hidden />
            </button>
          </>
        )}
      </div>
      {shownError && (
        <p role="alert" className="px-0.5 text-xs leading-tight whitespace-normal text-destructive">
          {shownError}
        </p>
      )}
    </div>
  );
}
