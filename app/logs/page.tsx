"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { DEFAULT_LOG_FILTERS, type LogFilters } from "@/components/logs/log-toolbar";
import { LogViewer } from "@/components/logs/log-viewer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api-client";
import { LOG_SOURCE_META, LOG_SOURCES, type LogFileInfo, type LogSource, type LogSourceInfo } from "@/lib/log-types";

const NO_FILES: LogFileInfo[] = [];

function parseTab(value: string | null): LogSource {
  return LOG_SOURCES.find((source) => source === value) ?? "system";
}

export default function LogsPage() {
  useDocumentTitle("Logs");
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const [active, setActive] = useState<LogSource>(() => parseTab(tabParam));
  // One filter set per tab so switching tabs keeps each tab's search, levels, range and file.
  const [filters, setFilters] = useState(
    () =>
      Object.fromEntries(LOG_SOURCES.map((source) => [source, DEFAULT_LOG_FILTERS])) as Record<LogSource, LogFilters>,
  );
  const [sources, setSources] = useState<LogSourceInfo[] | null>(null);

  // Back/forward or an edited URL.
  useEffect(() => setActive(parseTab(tabParam)), [tabParam]);

  // File lists (current + archives) per source until each tab's first page brings fresher ones.
  useEffect(() => {
    let cancelled = false;
    api.logs.sources().then(
      (res) => !cancelled && setSources(res.sources),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const selectTab = useCallback(
    (value: string) => {
      const next = parseTab(value);
      setActive(next);
      router.replace(`/logs?tab=${next}`, { scroll: false });
    },
    [router],
  );

  const updateFilters = useCallback(
    (source: LogSource, patch: Partial<LogFilters>) =>
      setFilters((current) => ({ ...current, [source]: { ...current[source], ...patch } })),
    [],
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Logs" />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-[1400px] animate-page-in space-y-6 px-4 py-6 sm:px-6 md:py-8 lg:px-8 motion-reduce:animate-none">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tighter md:text-3xl">Logs</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Server, security, access, agent, database, restart and tunnel logs, including rotated archives.
            </p>
          </div>
          {/* Only the active panel is mounted (and fetching); its filters live here. */}
          <Tabs value={active} onValueChange={selectTab} className="gap-4">
            {/* Swipeable on phones (the default list variant) and whenever the column is too narrow. */}
            <TabsList aria-label="Log type" className="max-w-full scroll-row justify-start">
              {LOG_SOURCES.map((source) => (
                <TabsTrigger key={source} value={source} className="flex-none shrink-0 px-3">
                  {LOG_SOURCE_META[source].label}
                </TabsTrigger>
              ))}
            </TabsList>
            {LOG_SOURCES.map((source) => (
              <TabsContent key={source} value={source} className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{LOG_SOURCE_META[source].description}</p>
                <LogViewer
                  source={source}
                  files={sources?.find((info) => info.id === source)?.files ?? NO_FILES}
                  filters={filters[source]}
                  onFiltersChange={(patch) => updateFilters(source, patch)}
                />
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </main>
    </div>
  );
}
