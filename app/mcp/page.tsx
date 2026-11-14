"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Collapsible } from "radix-ui";
import { ActivityIcon, ChevronRightIcon, Loader2Icon, RefreshCwIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { CREDENTIALS_CHANGED_EVENT } from "@/components/credentials/credential-notifications";
import { errorText, notifyCredentialsChanged } from "@/components/credentials/credentials-view";
import { McpCatalog } from "@/components/mcp/mcp-catalog";
import { McpConnectDialog } from "@/components/mcp/mcp-connect-dialog";
import { McpServerList } from "@/components/mcp/mcp-server-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api-client";
import type { CredentialSummary } from "@/lib/credential-types";
import { getMcpCatalogEntry } from "@/lib/mcp-catalog";
import type { McpCatalogEntry, McpExternalServer, McpServerSummary, McpServersResponse } from "@/lib/mcp-types";

/** List refresh while the page is visible (statuses change when the server re-checks credentials). */
const REFRESH_MS = 60_000;

interface McpData {
  data: McpServersResponse | null;
  /** Every saved credential (the connect dialog offers the matching ones). */
  credentials: CredentialSummary[];
  error: string | null;
  reload: () => Promise<void>;
  /** Swap in a fresh response (sync answers with the whole list). */
  replace: (data: McpServersResponse) => void;
  /** Swap in one server's fresh summary (a test answers with it). */
  replaceServer: (server: McpServerSummary) => void;
}

/**
 * Loads the MCP servers and the saved credentials; refreshes every minute while visible, when the
 * window regains focus, and on `credentials:changed` (skipped while a load is already running).
 */
function useMcpData(): McpData {
  const [data, setData] = useState<McpServersResponse | null>(null);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A slow poll must not overwrite a newer answer (a reload after a mutation, or sync).
  const seq = useRef(0);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    inFlight.current = true;
    try {
      const [next, saved] = await Promise.all([api.mcp.list(), api.credentials.list().catch(() => null)]);
      if (mine !== seq.current) return;
      setData(next);
      if (saved) setCredentials(saved.credentials);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError(errorText(err, "Could not load MCP servers"));
    } finally {
      if (mine === seq.current) inFlight.current = false;
    }
  }, []);

  const replace = useCallback((next: McpServersResponse) => {
    seq.current++;
    inFlight.current = false;
    setData(next);
    setError(null);
  }, []);

  const replaceServer = useCallback((server: McpServerSummary) => {
    setData((current) =>
      current && { ...current, servers: current.servers.map((s) => (s.name === server.name ? server : s)) },
    );
  }, []);

  useEffect(() => {
    const tick = () => {
      if (!document.hidden && !inFlight.current) void reload();
    };
    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener(CREDENTIALS_CHANGED_EVENT, tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
      window.removeEventListener(CREDENTIALS_CHANGED_EVENT, tick);
    };
  }, [reload]);

  return { data, credentials, error, reload, replace, replaceServer };
}

/** "3 connected · 1 failing · 1 disabled". */
function summarize(servers: McpServerSummary[]): string | undefined {
  if (servers.length === 0) return undefined;
  const count = (match: (s: McpServerSummary) => boolean) => servers.filter(match).length;
  const connected = count((s) => s.status === "connected");
  const failing = count((s) => s.status === "failing" || s.status === "error");
  const untested = count((s) => s.status === "untested");
  const disabled = count((s) => s.status === "disabled");
  return [
    `${connected} connected`,
    failing > 0 ? `${failing} failing` : null,
    untested > 0 ? `${untested} untested` : null,
    disabled > 0 ? `${disabled} disabled` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function scrollToId(id: string) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById(id)?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
}

/** Read-only list of the mcp.json entries AgentMan does not manage. */
function ExternalServers({ servers }: { servers: McpExternalServer[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="group/external rounded-2xl ring-1 ring-foreground/10">
      <Collapsible.Trigger className="pressable flex min-h-11 w-full items-center gap-2 rounded-2xl px-3 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-4 md:min-h-10">
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/external:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        Also in mcp.json
        <span className="text-muted-foreground tabular-nums">{servers.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Content className="px-3 pb-3 sm:px-4 sm:pb-4">
        <p className="mb-2 text-xs text-pretty text-muted-foreground">
          Added outside AgentMan (by hand, <code className="font-mono">/mcp add</code>, other tools). Agents load them
          too; AgentMan leaves them untouched.
        </p>
        <ul className="divide-y rounded-xl bg-card ring-1 ring-foreground/10" aria-label="Other servers in mcp.json">
          {servers.map((server) => (
            <li key={server.name} className="flex min-w-0 items-center gap-2 px-3 py-2.5">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">{server.name}</code>
              {!server.enabled && (
                <Badge variant="secondary" className="text-muted-foreground">
                  Disabled
                </Badge>
              )}
              <Badge variant="outline" className="font-mono text-[0.7rem] text-muted-foreground">
                {server.transport}
              </Badge>
            </li>
          ))}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export default function McpPage() {
  useDocumentTitle("MCP servers");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, credentials, error, reload, replace, replaceServer } = useMcpData();
  const [connecting, setConnecting] = useState<McpCatalogEntry | null>(null);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const [testingAll, setTestingAll] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Deep link: ?connect=<providerId> opens the connect dialog for that catalog entry; the URL is cleaned right away.
  const connectParam = searchParams.get("connect");
  useEffect(() => {
    if (!connectParam) return;
    const entry = getMcpCatalogEntry(connectParam);
    if (entry) setConnecting(entry);
    else toast.error(`No MCP server in the catalog for “${connectParam}”`);
    router.replace("/mcp", { scroll: false });
  }, [connectParam, router]);

  const afterMutation = useCallback(async () => {
    await reload();
    notifyCredentialsChanged();
  }, [reload]);

  /** Runs one test; the row's spinner shows meanwhile. Null when the request itself failed (toasted). */
  async function runTest(server: McpServerSummary): Promise<McpServerSummary | null> {
    setTesting((s) => new Set(s).add(server.name));
    try {
      const result = await api.mcp.test(server.name);
      replaceServer(result);
      return result;
    } catch (err) {
      toast.error(errorText(err, `Could not test ${server.name}`));
      return null;
    } finally {
      setTesting((s) => {
        const next = new Set(s);
        next.delete(server.name);
        return next;
      });
    }
  }

  async function testOne(server: McpServerSummary) {
    const result = await runTest(server);
    if (result?.status === "connected") {
      toast.success(`${result.name}: ${result.probe?.message ?? "connected"}`);
    } else if (result) {
      toast.error(`${result.name} failed its test`, {
        description: result.statusMessage ?? result.probe?.message ?? undefined,
      });
    }
    await afterMutation();
  }

  async function testAll() {
    const targets = (data?.servers ?? []).filter((s) => s.enabled);
    setTestingAll(true);
    let failing = 0;
    // One at a time: stdio servers start a process each, and the rows fill in as they finish.
    for (const server of targets) {
      const result = await runTest(server);
      if (result?.status !== "connected") failing++;
    }
    setTestingAll(false);
    const total = targets.length;
    if (failing > 0) toast.warning(`${failing} of ${total} ${total === 1 ? "server" : "servers"} failing`);
    else toast.success(total === 1 ? "Server is connected" : `All ${total} servers connected`);
    await afterMutation();
  }

  async function sync() {
    setSyncing(true);
    try {
      const next = await api.mcp.sync();
      replace(next);
      if (next.configError) toast.error("Could not write mcp.json", { description: next.configError });
      else toast.success("mcp.json is up to date");
    } catch (err) {
      toast.error(errorText(err, "Could not sync mcp.json"));
    } finally {
      setSyncing(false);
    }
  }

  async function handleConnected(server: McpServerSummary) {
    await afterMutation();
    requestAnimationFrame(() => scrollToId(`mcp-server-${server.name}`));
  }

  const servers = data?.servers ?? null;
  const external = data?.external ?? [];
  const enabledCount = servers?.filter((s) => s.enabled).length ?? 0;
  const outOfSync = servers?.some((s) => !s.synced) ?? false;

  const actions = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="pressable-icon size-11 rounded-full text-muted-foreground hover:text-foreground md:size-8 md:rounded-lg"
            aria-label="Test all enabled servers now"
            disabled={testingAll || enabledCount === 0}
            onClick={() => void testAll()}
          >
            {testingAll ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <ActivityIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{testingAll ? "Testing…" : "Test all now"}</TooltipContent>
      </Tooltip>
      {outOfSync && (
        <Button variant="outline" className="pressable h-11 gap-1.5 md:h-8" disabled={syncing} onClick={() => void sync()}>
          {syncing ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <WrenchIcon />}
          Repair
        </Button>
      )}
    </>
  );

  const configPath = data?.configPath ?? null;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="MCP servers" subtitle={servers ? summarize(servers) : undefined} actions={actions} />
      <main className="px-safe pb-safe flex-1">
        <div className="animate-page-in mx-auto w-full max-w-[1100px] space-y-8 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
          <section aria-labelledby="mcp-connected-title" className="space-y-3">
            <div className="space-y-1">
              <h2 id="mcp-connected-title" className="text-lg font-semibold tracking-tight">
                Connected
              </h2>
              <p className="text-sm text-pretty text-muted-foreground">
                Connected servers are written to{" "}
                {configPath ? (
                  <code className="font-mono text-xs break-all">{configPath}</code>
                ) : (
                  "omp's mcp.json"
                )}{" "}
                and load in every agent AgentMan starts; running agents pick them up on their next run.
              </p>
            </div>

            {data?.configError && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>mcp.json cannot be updated</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p className="break-words">{data.configError}</p>
                  {configPath && <code className="block font-mono text-xs break-all">{configPath}</code>}
                  <Button
                    variant="outline"
                    size="sm"
                    className="pressable gap-1.5 max-md:h-11"
                    disabled={syncing}
                    onClick={() => void sync()}
                  >
                    {syncing ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RefreshCwIcon />}
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {error && (
              <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                {data ? "Could not refresh: " : "Could not load MCP servers: "}
                {error}
                {!data && (
                  <Button variant="link" className="h-auto p-0 pl-2 text-amber-700 max-md:min-h-11 dark:text-amber-300" onClick={() => void reload()}>
                    Retry
                  </Button>
                )}
              </p>
            )}

            {(data || !error) && (
              <McpServerList
                servers={servers}
                testing={testing}
                onTest={(server) => void testOne(server)}
                onChanged={afterMutation}
                onBrowseCatalog={() => scrollToId("mcp-catalog")}
              />
            )}

            {external.length > 0 && <ExternalServers servers={external} />}
          </section>

          <section id="mcp-catalog" aria-labelledby="mcp-catalog-title" className="scroll-mt-24 space-y-3">
            <div className="space-y-1">
              <h2 id="mcp-catalog-title" className="text-lg font-semibold tracking-tight">
                Catalog
              </h2>
              <p className="text-sm text-pretty text-muted-foreground">
                Popular MCP servers, set up with a token saved in Credentials.
              </p>
            </div>
            <McpCatalog servers={servers} onConnect={setConnecting} />
          </section>
        </div>
      </main>
      <McpConnectDialog
        entry={connecting}
        onOpenChange={(open) => !open && setConnecting(null)}
        credentials={credentials}
        takenNames={[...(servers ?? []).map((s) => s.name), ...external.map((e) => e.name)]}
        onConnected={(server) => void handleConnected(server)}
      />
    </div>
  );
}
