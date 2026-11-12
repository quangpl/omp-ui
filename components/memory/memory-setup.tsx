"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckIcon, CopyIcon, Loader2Icon, PlayIcon, RefreshCwIcon, ServerOffIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/components/board/format";
import { MEMORY_PANEL } from "@/components/memory/format";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { MemoryStatus } from "@/lib/types";
import { cn, copyText } from "@/lib/utils";

const INSTALL_COMMAND = "npx -y @agentmemory/agentmemory@latest";

/**
 * Shown instead of the memory browser while agentmemory is missing, down or still starting:
 * what is wrong, the fix, and a way to Settings → Memory.
 */
export function MemorySetup({
  status,
  error,
  onRetry,
  onStatus,
}: {
  status: MemoryStatus | null;
  /** The status request itself failed. */
  error: string | null;
  onRetry: () => void;
  onStatus: (status: MemoryStatus) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const installed = status?.installed ?? true;
  const booting = starting || Boolean(status?.starting);

  const start = async () => {
    setStarting(true);
    try {
      const next = await api.memory.start();
      onStatus(next);
      if (next.healthy) toast.success("Memory server started");
    } catch (err) {
      toast.error("Couldn't start the memory server", { description: errorMessage(err) });
    } finally {
      setStarting(false);
    }
  };

  const copyInstall = () => {
    copyText(INSTALL_COMMAND).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      (err: unknown) => toast.error("Couldn't copy", { description: errorMessage(err) }),
    );
  };

  const title = error
    ? "Couldn't check the memory server"
    : !installed
      ? "agentmemory isn't installed"
      : booting
        ? "The memory server is starting"
        : "The memory server isn't running";
  const body = error
    ? error
    : !installed
      ? "agentmemory is a local memory server. OMP's agentmemory extension writes to it during card runs. Install it on the AgentMan host, then connect OMP in Settings."
      : booting
        ? "First start takes a few seconds while agentmemory prepares its runtime."
        : (status?.error ?? "agentmemory is installed, but its REST API isn't responding.");

  return (
    <section className={cn(MEMORY_PANEL, "animate-card-in overflow-hidden")}>
      <div className="grid @3xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-5 p-6 sm:p-8">
          <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            {booting ? (
              <Loader2Icon className="size-5 animate-spin motion-reduce:animate-none" />
            ) : (
              <ServerOffIcon className="size-5" />
            )}
          </span>
          <div className="max-w-xl space-y-2">
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
            <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{body}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {installed && !error && (
              <Button className="h-11 md:h-9" disabled={booting} onClick={() => void start()}>
                {booting ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <PlayIcon />}
                {booting ? "Starting…" : "Start server"}
              </Button>
            )}
            <Button asChild variant="outline" className="h-11 md:h-9">
              <Link href="/settings#memory">Memory settings</Link>
            </Button>
            <Button variant="ghost" className="h-11 md:h-9" onClick={onRetry}>
              <RefreshCwIcon />
              Check again
            </Button>
          </div>
        </div>
        <div className="space-y-3 border-t bg-muted/30 p-6 text-sm sm:p-8 @3xl:border-t-0 @3xl:border-l">
          {!installed ? (
            <>
              <p className="font-medium">Install on the server host</p>
              <button
                type="button"
                onClick={copyInstall}
                className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg bg-background px-3 py-2 text-left font-mono text-xs ring-1 ring-foreground/10 transition-colors hover:bg-muted"
              >
                <span className="truncate">{INSTALL_COMMAND}</span>
                {copied ? <CheckIcon className="size-4 shrink-0 text-success" /> : <CopyIcon className="size-4 shrink-0" />}
              </button>
              <p className="leading-relaxed text-muted-foreground">
                This starts the server and offers a global install. Then click Connect OMP in Settings so card runs
                capture and recall memories.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">Once it's running</p>
              <ul className="space-y-2 leading-relaxed text-muted-foreground">
                <li>Decisions, edits and fixes from every card run, searchable across projects.</li>
                <li>Recall: agents get relevant past memories before each prompt.</li>
                <li>Sessions linked to the cards that produced them.</li>
              </ul>
              {status?.url && <p className="font-mono text-xs text-muted-foreground">{status.url}</p>}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
