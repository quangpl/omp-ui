"use client";

import { AppHeader } from "@/components/app-header";
import { AiSection } from "@/components/stats/ai-section";
import { LiveIndicator, RefreshRing } from "@/components/stats/charts";
import { OptimizeSection } from "@/components/stats/optimize-section";
import { Overview } from "@/components/stats/overview";
import { SystemSection } from "@/components/stats/system-section";
import { SYSTEM_REFRESH_MS, useAiStats, useSystemStats, type SystemState } from "@/components/stats/use-stats";
import { useDocumentTitle } from "@/hooks/use-document-title";

const JUMP_LINKS = [
  { href: "#system-stats", label: "System" },
  { href: "#ai-quota", label: "AI quota" },
  { href: "#optimize", label: "Optimize" },
] as const;

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Live/stale state of the system poll, its countdown ring and the last update time. */
function PollStatus({ system }: { system: SystemState }) {
  const state = !system.stats && !system.error ? "connecting" : system.error ? "stale" : "live";
  return (
    <div className="flex items-center gap-3">
      <LiveIndicator state={state} />
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <RefreshRing intervalMs={SYSTEM_REFRESH_MS} lastUpdated={system.lastUpdated} />
        <span className="inline-block min-w-[7.5rem] tabular-nums">
          Updated{" "}
          <span className="font-mono">{system.lastUpdated ? formatClock(system.lastUpdated) : "--:--:--"}</span>
        </span>
      </span>
    </div>
  );
}

export default function StatsPage() {
  useDocumentTitle("Stats");
  const ai = useAiStats();
  const system = useSystemStats();
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Stats" />
      <main className="px-safe pb-safe flex-1">
        <div className="@container mx-auto w-full max-w-[1400px] animate-page-in space-y-8 px-4 py-6 sm:px-6 md:space-y-10 md:py-8 lg:px-8 motion-reduce:animate-none [&_[id]]:scroll-mt-20">
          {/* Side by side only when the content column (not the viewport) has room for the title, nav and status. */}
          <div className="flex flex-col gap-4 @4xl:flex-row @4xl:items-end @4xl:justify-between @4xl:gap-6">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tighter md:text-3xl">Operations</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Agents, AI spend, and host health, refreshed live.
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-2 @4xl:shrink-0 @4xl:flex-row @4xl:items-center @4xl:gap-4">
              <nav
                aria-label="Jump to section"
                className="scroll-row -mx-4 px-1 py-1 sm:-mx-6 sm:px-3 md:mx-0 md:px-0 @4xl:shrink-0"
              >
                <div className="flex w-max items-center">
                  {JUMP_LINKS.map((link) => (
                    <a
                      key={link.href}
                      href={link.href}
                      className="pressable inline-flex h-11 shrink-0 items-center rounded-full px-3 text-xs font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,scale] duration-200 ease-(--ease-out-smooth) hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-muted motion-reduce:transition-none md:h-9"
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              </nav>
              <div className="order-first @4xl:order-none">
                <PollStatus system={system} />
              </div>
            </div>
          </div>
          <Overview system={system} ai={ai} />
          <SystemSection system={system} />
          <AiSection ai={ai} />
          <OptimizeSection />
        </div>
      </main>
    </div>
  );
}
