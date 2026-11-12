"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BrainIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  Loader2Icon,
  PlayIcon,
  PlugIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { SettingsGroup, SettingsPanel, SettingsSection } from "@/components/settings/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { MemoryStatus } from "@/lib/types";
import { cn, copyText } from "@/lib/utils";

/** While a start is still booting, re-read the status this often. */
const STARTING_POLL_MS = 3_000;
const INSTALL_COMMAND = "npx -y @agentmemory/agentmemory@latest";
const DOCS_URL = "https://github.com/rohitg00/agentmemory/tree/main/integrations/omp";

type Tone = "ok" | "warn" | "off" | "busy";

const TONES: Record<Tone, string> = {
  ok: "bg-success/15 text-success",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  off: "bg-muted text-muted-foreground",
  busy: "bg-primary/10 text-primary",
};

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex min-h-12 flex-col justify-center gap-1 rounded-lg bg-muted/40 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Badge className={cn("max-w-full justify-start truncate", TONES[tone])}>
        {tone === "ok" && <CheckIcon />}
        {tone === "busy" && <Loader2Icon className="animate-spin" />}
        {tone === "warn" && <TriangleAlertIcon />}
        <span className="truncate">{value}</span>
      </Badge>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 sm:px-5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 max-w-full items-center gap-2">{children}</dd>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 shrink-0 md:size-7"
      aria-label={label}
      title={label}
      onClick={() =>
        void copyText(text).then(
          () => toast.success("Copied"),
          () => toast.error("Could not copy"),
        )
      }
    >
      <CopyIcon />
    </Button>
  );
}

function serverPill(status: MemoryStatus): { value: string; tone: Tone } {
  if (status.starting) return { value: "Starting…", tone: "busy" };
  if (status.healthy) {
    return status.level === "warn" || status.level === "error"
      ? { value: `Healthy · ${status.level === "error" ? "errors" : "warnings"}`, tone: "warn" }
      : { value: "Healthy", tone: "ok" };
  }
  if (status.reachable) return { value: "Unhealthy", tone: "warn" };
  return { value: "Not running", tone: "off" };
}

function embeddingsPill(status: MemoryStatus): { value: string; tone: Tone } {
  if (status.embeddings === "bm25") return { value: "Keyword (BM25)", tone: "off" };
  const semantic = `Semantic · ${status.embeddings}`;
  return { value: status.embeddingsSource === "config" ? `${semantic} (configured)` : semantic, tone: "ok" };
}

const STAT_LABELS: { key: keyof NonNullable<MemoryStatus["stats"]>; label: string }[] = [
  { key: "memories", label: "Memories" },
  { key: "sessions", label: "Sessions" },
  { key: "observations", label: "Observations" },
  { key: "lessons", label: "Lessons" },
];

/** Settings → Memory: the local agentmemory server card runs and omp sessions remember through. */
export function MemorySettingsSection() {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"start" | "connect" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setStatus(await api.memory.status(refresh));
      setLoadError(null);
    } catch (err) {
      setLoadError(message(err, "Could not read the memory server status."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A start answers within a minute; a first boot can take longer, so follow it until it settles.
  const starting = status?.starting ?? false;
  useEffect(() => {
    if (!starting) return;
    const timer = setInterval(() => void load(), STARTING_POLL_MS);
    return () => clearInterval(timer);
  }, [starting, load]);

  async function run(kind: "start" | "connect") {
    setAction(kind);
    setActionError(null);
    try {
      const next = kind === "start" ? await api.memory.start() : await api.memory.connectOmp();
      setStatus(next);
      if (kind === "start") {
        if (next.healthy) toast.success("Memory server is running");
        else if (next.starting) toast.info("Memory server is still starting", { description: "This page updates when it is up." });
      } else {
        toast.success("agentmemory connected to OMP", {
          description: "New card runs load it; restart omp sessions you already have open.",
        });
      }
    } catch (err) {
      setActionError(message(err, kind === "start" ? "Could not start the memory server." : "Could not connect OMP."));
    } finally {
      setAction(null);
    }
  }

  const description = (
    <>
      Persistent memory via{" "}
      <a href={DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
        agentmemory
      </a>
      . Card runs and omp in your terminal recall and record project knowledge across sessions.
    </>
  );
  const reloadButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => void load(true)}
      disabled={loading}
      aria-label="Refresh memory status"
      title="Refresh"
      className="size-11 md:size-8"
    >
      <RefreshCwIcon className={cn(loading && "animate-spin")} />
    </Button>
  );

  return (
    <SettingsSection id="memory" icon={<BrainIcon />} title="Memory" description={description} action={reloadButton}>
      {loadError && !status ? (
        <SettingsPanel className="flex gap-3 p-4 sm:p-5">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="min-w-0 text-destructive">{loadError}</p>
        </SettingsPanel>
      ) : !status ? (
        <SettingsPanel>
          <div aria-busy="true" className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        </SettingsPanel>
      ) : (
        <MemoryStatusView status={status} action={action} actionError={actionError} onAction={run} />
      )}
    </SettingsSection>
  );
}

function MemoryStatusView({
  status,
  action,
  actionError,
  onAction,
}: {
  status: MemoryStatus;
  action: "start" | "connect" | null;
  actionError: string | null;
  onAction: (kind: "start" | "connect") => void;
}) {
  const server = serverPill(status);
  const embeddings = embeddingsPill(status);
  const busy = action !== null;
  const canStart = status.installed && !status.healthy && !status.starting && status.enabled !== "false";

  return (
    <div className="space-y-4">
      <SettingsPanel>
        <SettingsGroup>
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
            <StatusPill
              label="agentmemory"
              value={status.installed ? `Installed${status.version ? ` · v${status.version}` : ""}` : "Not installed"}
              tone={status.installed ? "ok" : "warn"}
            />
            <StatusPill label="Server" value={server.value} tone={server.tone} />
            <StatusPill
              label="OMP"
              value={status.omp.connected ? (status.omp.mcp ? "Connected · MCP" : "Connected") : "Not connected"}
              tone={status.omp.connected ? "ok" : "warn"}
            />
            <StatusPill label="Recall" value={embeddings.value} tone={embeddings.tone} />
          </div>

          {status.stats && (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {STAT_LABELS.map(({ key, label }) => (
                <div key={key} className="rounded-lg px-3 py-2 ring-1 ring-foreground/10">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{status.stats?.[key]?.toLocaleString() ?? "—"}</dd>
                </div>
              ))}
            </dl>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              type="button"
              onClick={() => onAction("start")}
              disabled={!canStart || busy}
              className="h-11 w-full sm:w-auto md:h-9"
            >
              {action === "start" || status.starting ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
              {status.starting ? "Starting…" : "Start server"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction("connect")}
              disabled={!status.installed || busy}
              className="h-11 w-full sm:w-auto md:h-9"
            >
              {action === "connect" ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
              {status.omp.connected ? "Reconnect OMP" : "Connect OMP"}
            </Button>
            <Button asChild variant="outline" className="h-11 w-full sm:w-auto md:h-9">
              <a href={status.viewerUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon />
                Open viewer
              </a>
            </Button>
          </div>
        </SettingsGroup>

        <dl className="divide-y border-t">
          <Row label="REST API">
            <span className="min-w-0 truncate font-mono text-xs" title={status.url}>
              {status.url}
            </span>
          </Row>
          <Row label="Viewer">
            <span className="min-w-0 truncate font-mono text-xs" title={status.viewerUrl}>
              {status.viewerUrl}
            </span>
            <CopyButton text={status.viewerUrl} label="Copy viewer URL" />
          </Row>
          {status.omp.agentDir && (
            <Row label="OMP agent dir">
              <span className="min-w-0 truncate font-mono text-xs" title={status.omp.agentDir}>
                {status.omp.agentDir}
              </span>
            </Row>
          )}
          {status.llm && (
            <Row label="LLM provider">
              <span className="font-mono text-xs">{status.llm === "noop" ? "none (keyless)" : status.llm}</span>
            </Row>
          )}
          <Row label="Auto-start">
            <span className="font-mono text-xs">AGENTMEMORY_ENABLED={status.enabled}</span>
          </Row>
        </dl>
      </SettingsPanel>

      <p className="text-pretty text-xs text-muted-foreground">
        The viewer listens on the server&apos;s loopback, so &ldquo;Open viewer&rdquo; only works from a browser on that
        machine. From another device, forward the port first, e.g.{" "}
        <code className="font-mono break-all">ssh -L 3113:127.0.0.1:3113 &lt;server&gt;</code>.
      </p>

      {actionError && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>
            <pre className="max-h-48 w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{actionError}</pre>
          </AlertDescription>
        </Alert>
      )}

      {!status.installed && (
        <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
          <TriangleAlertIcon />
          <AlertTitle>agentmemory is not installed on this server</AlertTitle>
          <AlertDescription className="text-amber-900/85 dark:text-amber-200/85">
            <p>Run this once on the server host (Node 20+), then refresh:</p>
            <div className="mt-1 flex items-center gap-1">
              <code className="min-w-0 break-all font-mono text-xs">{INSTALL_COMMAND}</code>
              <CopyButton text={INSTALL_COMMAND} label="Copy install command" />
            </div>
          </AlertDescription>
        </Alert>
      )}

      {status.installed && !status.healthy && !status.starting && status.error && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Memory server is not available</AlertTitle>
          <AlertDescription>
            <p className="break-words">{status.error}</p>
            {status.enabled === "false" && <p>Auto-start is off (AGENTMEMORY_ENABLED=false).</p>}
          </AlertDescription>
        </Alert>
      )}

      {status.installed && !status.omp.connected && (
        <Alert>
          <PlugIcon />
          <AlertTitle>OMP is not connected</AlertTitle>
          <AlertDescription>
            <p>
              &ldquo;Connect OMP&rdquo; runs <code className="font-mono">agentmemory connect omp --with-mcp</code>. It adds
              agentmemory&apos;s recall and capture hooks, skills and MCP tools to omp&apos;s config, for card runs and
              omp in your terminal.
            </p>
            {status.omp.error && <p className="break-words">{status.omp.error}</p>}
          </AlertDescription>
        </Alert>
      )}

      {status.healthy && status.embeddings === "bm25" && (
        <p className="text-pretty text-xs text-muted-foreground">
          Recall is keyword-only. For free, on-device semantic recall, add{" "}
          <code className="font-mono">EMBEDDING_PROVIDER=local</code> to <code className="font-mono">~/.agentmemory/.env</code>{" "}
          and restart the server.
        </p>
      )}

      {status.problems.length > 0 && (
        <SettingsPanel>
          <SettingsGroup title="Server notes">
            {status.headline && <p className="text-muted-foreground">{status.headline}</p>}
            <ul className="space-y-3">
              {status.problems.map((p, i) => (
                <li key={i} className="flex gap-2">
                  {p.level === "info" ? (
                    <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <TriangleAlertIcon
                      className={cn("mt-0.5 size-4 shrink-0", p.level === "error" ? "text-destructive" : "text-amber-600")}
                    />
                  )}
                  <div className="min-w-0 space-y-0.5">
                    <p className="break-words">{p.message}</p>
                    {p.fix && <p className="break-words text-xs text-muted-foreground">{p.fix}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </SettingsGroup>
        </SettingsPanel>
      )}
    </div>
  );
}
