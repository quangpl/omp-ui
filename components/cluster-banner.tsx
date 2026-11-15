"use client";

// Cluster chrome of every signed-in page: on a replica, a slim banner saying that changes are made
// on the primary (with a link to it); everywhere, `cluster.notice` events as toasts.
import { ExternalLinkIcon, NetworkIcon } from "lucide-react";
import { toast } from "sonner";
import { useClusterNotices, useClusterStatus } from "@/hooks/use-cluster";
import type { ClusterNotice, ClusterStatus } from "@/lib/types";

/** Shown after the banner text while the replica is not linked to its primary. */
const CONNECTION_NOTE: Record<NonNullable<ClusterStatus["connection"]>["state"], string | null> = {
  connected: null,
  connecting: "reconnecting…",
  electing: "electing a new primary…",
};

/** One toast per notice; its id keeps a notice from showing twice. */
function showNotice(notice: ClusterNotice): void {
  const options = { id: `cluster-notice-${notice.id}` };
  if (notice.level === "error") toast.error(notice.message, options);
  else if (notice.level === "warning") toast.warning(notice.message, options);
  else toast(notice.message, options);
}

/** Mounted once by the app shell. */
export function ClusterBanner() {
  const { status } = useClusterStatus();
  useClusterNotices(showNotice);
  if (status?.role !== "replica" || !status.primary) return null;

  const { primary, connection } = status;
  const note = connection ? CONNECTION_NOTE[connection.state] : null;
  return (
    <div
      role="status"
      className="pt-safe px-safe border-b border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200"
    >
      <div className="flex min-h-9 flex-wrap items-center justify-center gap-x-3 gap-y-0.5 px-4 py-1.5 text-center text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <NetworkIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            Replica of <span className="font-semibold">{primary.name}</span> — changes are made on the primary
            {note && <span className="text-amber-900/75 dark:text-amber-200/75"> · {note}</span>}
          </span>
        </span>
        <a
          href={primary.httpUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
        >
          Open the primary
          <ExternalLinkIcon className="size-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}
