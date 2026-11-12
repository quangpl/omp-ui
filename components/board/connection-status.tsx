import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/hooks/use-board";

const LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
};

/** Live-updates indicator: green "Live", amber "Reconnecting…". Dot only on small screens. */
export function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const label = LABELS[status];
  return (
    <span
      role="status"
      aria-label={status === "live" ? "Live updates connected" : label}
      title={status === "live" ? "Live updates connected" : label}
      className={cn(
        "inline-flex h-11 shrink-0 animate-fade-in-soft items-center gap-1.5 px-2 text-xs font-medium transition-colors duration-300 md:h-7 md:rounded-full md:border md:px-2.5",
        status === "live" && "text-emerald-700 md:border-emerald-500/30 md:bg-emerald-500/10 dark:text-emerald-300",
        status === "reconnecting" && "text-amber-700 md:border-amber-500/30 md:bg-amber-500/10 dark:text-amber-300",
        status === "connecting" && "text-muted-foreground",
      )}
    >
      <span
        key={`dot-${status}`}
        aria-hidden
        className={cn(
          "size-2 animate-fade-in-soft rounded-full",
          status === "live" && "bg-emerald-500",
          status === "reconnecting" && "animate-pulse bg-amber-500",
          status === "connecting" && "bg-muted-foreground/50",
        )}
      />
      <span key={`label-${status}`} className="max-md:sr-only animate-fade-in-soft">
        {label}
      </span>
    </span>
  );
}
