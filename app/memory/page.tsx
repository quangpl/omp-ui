"use client";

import { useState } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { MemoryView } from "@/components/memory/memory-view";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDocumentTitle } from "@/hooks/use-document-title";
import type { MemoryStatus } from "@/lib/types";

export default function MemoryPage() {
  useDocumentTitle("Memory");
  const [status, setStatus] = useState<MemoryStatus | null>(null);

  const viewer = status?.healthy ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" size="sm" className="h-11 md:h-8">
          <a href={status.viewerUrl} target="_blank" rel="noreferrer">
            <span className="hidden sm:inline">Open full viewer</span>
            <span className="sm:hidden">Viewer</span>
            <ExternalLinkIcon data-icon="inline-end" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        agentmemory&apos;s built-in viewer at {status.viewerUrl}. Bound to the server host&apos;s loopback: open it
        from that machine or through an SSH tunnel.
      </TooltipContent>
    </Tooltip>
  ) : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Memory" actions={viewer} />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-[1400px] animate-page-in px-4 py-6 sm:px-6 md:py-8 lg:px-8 motion-reduce:animate-none">
          <MemoryView onStatus={setStatus} />
        </div>
      </main>
    </div>
  );
}
