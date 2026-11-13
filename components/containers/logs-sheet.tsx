"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CopyIcon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/components/containers/shared";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export interface LogsTarget {
  kind: "container" | "compose";
  /** Container id or compose project name. */
  id: string;
  name: string;
}

const FOLLOW_MS = 3000;
const TAIL_OPTIONS = [100, 300, 1000, 5000];

function LogView({ target }: { target: LogsTarget }) {
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState(300);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [loading, setLoading] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { logs: text } =
        target.kind === "container"
          ? await api.docker.containerLogs(target.id, tail)
          : await api.docker.composeLogs(target.id, tail);
      setLogs(text);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load logs"));
    } finally {
      setLoading(false);
    }
  }, [target, tail]);

  useEffect(() => {
    void load();
    if (!follow) return;
    const id = window.setInterval(() => {
      if (!document.hidden) void load();
    }, FOLLOW_MS);
    return () => window.clearInterval(id);
  }, [load, follow]);

  useEffect(() => {
    const el = preRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex h-11 items-center gap-2 text-xs text-muted-foreground md:h-8">
          <Switch checked={follow} onCheckedChange={setFollow} aria-label="Follow logs" />
          Follow
        </label>
        <label className="flex h-11 items-center gap-2 text-xs text-muted-foreground md:h-8">
          <Switch checked={wrap} onCheckedChange={setWrap} aria-label="Wrap long lines" />
          Wrap
        </label>
        {/* Phones: the tail picker drops to its own swipeable line below. */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground max-sm:order-last max-sm:w-full">
          Last
          <div className="scroll-row flex min-w-0 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Lines to show">
            {TAIL_OPTIONS.map((n) => (
              <Button
                key={n}
                variant={tail === n ? "outline" : "ghost"}
                size="xs"
                onClick={() => setTail(n)}
                aria-pressed={tail === n}
                className={cn(
                  "pressable h-9 min-w-12 shrink-0 font-mono tabular-nums md:h-6 md:min-w-0",
                  tail !== n && "text-muted-foreground",
                )}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className="pressable-icon size-11 md:size-7"
            onClick={() => void load()}
            aria-label="Reload logs"
          >
            {loading ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RefreshCwIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="pressable-icon size-11 md:size-7"
            aria-label="Copy logs"
            disabled={!logs}
            onClick={() => {
              if (!logs) return;
              void navigator.clipboard.writeText(logs).then(() => toast.success("Logs copied"));
            }}
          >
            <CopyIcon />
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <pre
        ref={preRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        aria-busy={logs === null}
        className={cn(
          "min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl bg-zinc-950 p-3 font-mono text-[13px] leading-relaxed text-zinc-200 scrollbar-subtle selection:bg-primary/30 md:text-xs",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
        )}
      >
        {logs === null ? (
          <span className="block space-y-2.5" aria-label="Loading logs">
            {["w-3/4", "w-full", "w-2/3", "w-5/6", "w-1/2", "w-4/5"].map((width) => (
              <span
                key={width}
                className={cn("block h-3 animate-pulse rounded bg-zinc-800 motion-reduce:animate-none", width)}
              />
            ))}
          </span>
        ) : (
          logs || "No log output."
        )}
      </pre>
    </div>
  );
}

function InspectView({ id }: { id: string }) {
  const [data, setData] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.docker.inspect(id).then(
      (value) => !cancelled && setData(JSON.stringify(value, null, 2)),
      (err: unknown) => !cancelled && setError(errorMessage(err, "Could not inspect the container")),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (error)
    return (
      <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
        {error}
      </p>
    );
  if (data === null)
    return (
      <div className="min-h-0 flex-1 space-y-2.5 rounded-xl bg-muted/60 p-3" aria-busy="true" aria-label="Loading">
        {["w-1/3", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2"].map((width, i) => (
          <Skeleton key={i} className={cn("h-3", width)} style={{ marginLeft: `${(i % 3) * 0.75}rem` }} />
        ))}
      </div>
    );
  return (
    <pre className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl bg-muted/60 p-3 font-mono text-[13px] leading-relaxed scrollbar-subtle md:text-xs">
      {data}
    </pre>
  );
}

/** Logs (and `docker inspect` for containers) in a side sheet; full-screen on phones. */
export function LogsSheet({ target, onClose }: { target: LogsTarget | null; onClose: () => void }) {
  return (
    <Sheet open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full gap-3 overscroll-contain px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] duration-300 ease-(--ease-fluid) sm:max-w-3xl! data-[side=right]:h-dvh data-[side=right]:w-full"
      >
        {target && (
          <>
            <div className="flex items-start gap-2">
              <SheetHeader className="min-w-0 flex-1 p-0">
                <SheetTitle className="truncate font-mono text-base tracking-tight">{target.name}</SheetTitle>
                <SheetDescription>
                  {target.kind === "compose" ? "Compose project logs (all services)" : "Container logs"}
                </SheetDescription>
              </SheetHeader>
              <SheetClose asChild>
                <Button variant="ghost" size="icon" className="pressable-icon -mt-1 -mr-2 size-11 md:size-8">
                  <XIcon />
                  <span className="sr-only">Close</span>
                </Button>
              </SheetClose>
            </div>
            {target.kind === "container" ? (
              <Tabs defaultValue="logs" className="flex min-h-0 flex-1 flex-col">
                <TabsList className="w-full group-data-horizontal/tabs:h-11 sm:w-fit md:group-data-horizontal/tabs:h-8">
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                  <TabsTrigger value="inspect">Inspect</TabsTrigger>
                </TabsList>
                <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col">
                  <LogView target={target} />
                </TabsContent>
                <TabsContent value="inspect" className="flex min-h-0 flex-1 flex-col">
                  <InspectView id={target.id} />
                </TabsContent>
              </Tabs>
            ) : (
              <LogView target={target} />
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
