"use client";

import { createContext, useContext } from "react";
import { Loader2Icon, LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const ReadOnlyContext = createContext(false);

/**
 * Marks the settings sections inside as managed by an administrator: each shows a note and its
 * controls are disabled. Renders no element, so the page's `section + section` selectors still match.
 */
export function SettingsReadOnly({ value, children }: { value: boolean; children: React.ReactNode }) {
  return <ReadOnlyContext.Provider value={value}>{children}</ReadOnlyContext.Provider>;
}

/**
 * One settings group: anchored, titled block with a description, then its body. `id` is the
 * anchor the settings nav links to (`#id`); `scroll-mt` keeps the title clear of the sticky header
 * (plus its metrics strip and the chip nav below `lg`) when jumped to.
 */
export function SettingsSection({
  id,
  icon,
  title,
  description,
  action,
  className,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const readOnly = useContext(ReadOnlyContext);
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "min-w-0 scroll-mt-[calc(10rem+env(safe-area-inset-top))] space-y-4 lg:scroll-mt-24",
        className,
      )}
    >
      <header className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <p className="max-w-[65ch] text-sm text-pretty text-muted-foreground">{description}</p>
          {readOnly && (
            <p className="flex items-center gap-1.5 pt-0.5 text-xs font-medium text-muted-foreground">
              <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
              Managed by an administrator
            </p>
          )}
        </div>
        {action}
      </header>
      {readOnly ? (
        // A disabled fieldset turns off every control inside at once; `space-y-4` keeps the spacing
        // the section gives its direct children.
        <fieldset disabled className="min-w-0 space-y-4">
          {children}
        </fieldset>
      ) : (
        children
      )}
    </section>
  );
}

/** The rounded surface a section's rows and fields sit on (one grouped container per section). */
export function SettingsPanel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("min-w-0 rounded-xl bg-card text-sm ring-1 ring-foreground/10", className)}>
      {children}
    </div>
  );
}

/** A titled sub-group inside a panel; consecutive groups are separated by a hairline. */
export function SettingsGroup({
  title,
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-5 border-t p-4 first:border-t-0 sm:p-5", className)}>
      {title && (
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      )}
      {children}
    </div>
  );
}

/** Label-above-input field with helper or inline error text below (error id: `<htmlFor>-error`). */
export function SettingsField({
  label,
  htmlFor,
  labelId,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  labelId?: string;
  hint?: React.ReactNode;
  error?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Label id={labelId} htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} className="animate-fade-in-soft text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-pretty text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Consecutive toggle rows separated by edge-to-edge hairlines, like a native settings list.
 * Children are `SettingsToggle`s (optionally wrapped).
 */
export function SettingsRows({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("divide-y divide-border/70", className)}>{children}</div>;
}

/**
 * A whole-row toggle (48px+): title and description on the left, the switch right-aligned. The row
 * bleeds to the panel edges so its press highlight reads as one tappable row.
 */
export function SettingsToggle({
  htmlFor,
  title,
  description,
  className,
  children,
}: {
  htmlFor: string;
  title: string;
  description: React.ReactNode;
  className?: string;
  /** The `<Switch id={htmlFor}>`. */
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        "-mx-4 flex min-h-12 cursor-pointer items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/40 active:bg-muted/70 has-disabled:cursor-not-allowed has-disabled:active:bg-transparent sm:-mx-5 sm:px-5",
        className,
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">{description}</span>
      </span>
      {children}
    </label>
  );
}

/**
 * Footer of a settings form: unsaved-changes status, Discard and Save. While there is something to
 * save it pins above the phone tab bar (or the viewport bottom from `md`, clear of the home
 * indicator) so Save stays one tap away.
 */
export function SettingsSaveBar({
  dirty,
  saving,
  disabled,
  onDiscard,
  discardLabel = "Discard",
}: {
  dirty: boolean;
  saving: boolean;
  /** Save is unavailable (nothing changed, or the form is invalid). */
  disabled: boolean;
  onDiscard: () => void;
  discardLabel?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-b-xl border-t bg-card px-4 py-3 sm:px-5",
        dirty &&
          "glass-edge sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 bg-card/90 backdrop-blur-lg supports-backdrop-filter:bg-card/80 md:bottom-0 md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
      )}
    >
      <p className="hidden min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground sm:flex" aria-live="polite">
        {dirty ? (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
            Unsaved changes
          </>
        ) : (
          "All changes saved"
        )}
      </p>
      {dirty && (
        <Button type="button" variant="ghost" disabled={saving} onClick={onDiscard} className="pressable h-11 md:h-9">
          {discardLabel}
        </Button>
      )}
      <Button type="submit" disabled={disabled || saving} className="pressable h-11 flex-1 sm:flex-none md:h-9">
        {saving && <Loader2Icon className="animate-spin" />}
        Save changes
      </Button>
    </div>
  );
}
