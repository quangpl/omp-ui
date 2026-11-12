"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CopyIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/components/containers/shared";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api-client";

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
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={follow} onCheckedChange={setFollow} aria-label="Follow logs" />
          Follow
        </label>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          Last
          {TAIL_OPTIONS.map((n) => (
            <Button
              key={n}
              variant={tail === n ? "secondary" : "ghost"}
              size="xs"
              onClick={() => setTail(n)}
              aria-pressed={tail === n}
            >
              {n}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} aria-label="Reload logs">
            {loading ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
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
      {error && <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
      <pre
        ref={preRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap break-all text-zinc-200"
      >
        {logs === null ? "Loading…" : logs || "No log output."}
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
  if (error) return <p className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{error}</p>;
  return (
    <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-[0.7rem] leading-relaxed">
      {data ?? "Loading…"}
    </pre>
  );
}

/** Logs (and `docker inspect` for containers) in a side sheet. */
export function LogsSheet({ target, onClose }: { target: LogsTarget | null; onClose: () => void }) {
  return (
    <Sheet open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-3 p-4 sm:max-w-3xl! data-[side=right]:w-full">
        {target && (
          <>
            <SheetHeader className="p-0 pr-8">
              <SheetTitle className="truncate font-mono text-base">{target.name}</SheetTitle>
              <SheetDescription>
                {target.kind === "compose" ? "Compose project logs (all services)" : "Container logs"}
              </SheetDescription>
            </SheetHeader>
            {target.kind === "container" ? (
              <Tabs defaultValue="logs" className="flex min-h-0 flex-1 flex-col">
                <TabsList>
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
