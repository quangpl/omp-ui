import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * One settings group: anchored, titled block with a description, then its body. `id` is the
 * anchor the settings nav links to (`#id`); `scroll-mt` keeps the title clear of the sticky header
 * (and the mobile chip nav) when jumped to.
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
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn("min-w-0 scroll-mt-32 space-y-4 lg:scroll-mt-24", className)}
    >
      <header className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <p className="text-pretty text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** The bordered surface a section's fields sit on. */
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

/** Label-above-input field with helper or error text below. */
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
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label id={labelId} htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-pretty text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** A whole-row toggle: title and description on the left, the switch on the right. */
export function SettingsToggle({
  htmlFor,
  title,
  description,
  children,
}: {
  htmlFor: string;
  title: string;
  description: React.ReactNode;
  /** The `<Switch id={htmlFor}>`. */
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="-mx-2 flex min-h-12 cursor-pointer items-center gap-4 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">{description}</span>
      </span>
      {children}
    </label>
  );
}
