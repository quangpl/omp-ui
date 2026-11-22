"use client";

import { useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  EllipsisIcon,
  KeyRoundIcon,
  ListTreeIcon,
  Loader2Icon,
  PlugIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { ConfirmDialog, type ConfirmRequest } from "@/components/containers/dialogs";
import { errorText } from "@/components/credentials/utils";
import { ProviderTile } from "@/components/credentials/provider-tile";
import { McpStatusBadge } from "@/components/mcp/mcp-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import { getCredentialProvider } from "@/lib/credential-providers";
import { mcpToolName, type McpServerSummary } from "@/lib/mcp-types";
import { cn, copyText } from "@/lib/utils";

/** The mcp.json fragment for one server, as users paste it into another config. */
export function mcpConfigJson(server: McpServerSummary): string {
  return JSON.stringify({ mcpServers: { [server.name]: server.config } }, null, 2);
}

interface CheckInfo {
  at: string;
  latencyMs: number | null;
  message: string | null;
}

/** The latest check (credential health check or MCP probe): what the status reflects. */
function lastCheck(server: McpServerSummary): CheckInfo | null {
  const { probe, credential } = server;
  const fromProbe: CheckInfo | null = probe
    ? { at: probe.checkedAt, latencyMs: probe.latencyMs, message: probe.message }
    : null;
  const fromCredential: CheckInfo | null = credential?.lastCheckedAt
    ? { at: credential.lastCheckedAt, latencyMs: credential.lastLatencyMs, message: credential.lastMessage }
    : null;
  if (!fromProbe || !fromCredential) return fromProbe ?? fromCredential;
  return new Date(fromProbe.at).getTime() >= new Date(fromCredential.at).getTime() ? fromProbe : fromCredential;
}

/** Inline "Show tools & config": the tools of the last probe and the exact mcp.json entry. */
function ServerDetails({ server }: { server: McpServerSummary }) {
  const [copied, setCopied] = useState(false);
  const probe = server.probe;
  const config = mcpConfigJson(server);

  let tools: React.ReactNode;
  if (!probe) {
    tools = <p className="text-sm text-muted-foreground">Not tested yet. Run Test to list its tools.</p>;
  } else if (!probe.ok) {
    tools = <p className="text-sm break-words text-destructive">The last test failed: {probe.message}</p>;
  } else if (probe.tools.length === 0) {
    tools = <p className="text-sm text-muted-foreground">The server offers no tools.</p>;
  } else {
    tools = (
      <ul className="scrollbar-subtle grid max-h-80 grid-cols-1 gap-x-4 gap-y-2 overflow-y-auto pr-1 md:grid-cols-2">
        {probe.tools.map((tool) => (
          <li key={tool.name} className="min-w-0">
            <code className="block truncate font-mono text-xs font-medium" title={mcpToolName(server.name, tool.name)}>
              {tool.name}
            </code>
            {tool.description && (
              <p className="line-clamp-2 text-xs break-words text-muted-foreground" title={tool.description}>
                {tool.description}
              </p>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div id={`mcp-server-${server.name}-details`} className="mt-3 space-y-4 border-t pt-3 sm:ml-13">
      <section className="space-y-2" aria-label={`${server.name} tools`}>
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Tools
          {probe?.ok && probe.serverName && (
            <span className="ml-2 font-normal tracking-normal normal-case">
              {probe.serverName}
              {probe.serverVersion && ` ${probe.serverVersion}`}
            </span>
          )}
        </h3>
        {tools}
      </section>
      <section className="space-y-2" aria-label={`${server.name} config`}>
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Config in mcp.json</h3>
        <div className="relative">
          <pre className="scrollbar-subtle overflow-x-auto rounded-lg bg-muted/60 p-3 pr-14 font-mono text-xs leading-relaxed">
            {config}
          </pre>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="pressable-icon absolute top-1 right-1 size-11 md:size-8"
                aria-label={`Copy ${server.name} config`}
                onClick={() =>
                  void copyText(config).then(
                    () => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    },
                    () => toast.error("Could not copy"),
                  )
                }
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
          </Tooltip>
        </div>
      </section>
    </div>
  );
}

function ServerRow({
  server,
  index,
  now,
  testing,
  updating,
  expanded,
  onTest,
  onToggleEnabled,
  onToggleExpanded,
  onRemove,
}: {
  server: McpServerSummary;
  index: number;
  now: number;
  testing: boolean;
  updating: boolean;
  expanded: boolean;
  onTest: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleExpanded: () => void;
  onRemove: () => void;
}) {
  const provider = getCredentialProvider(server.providerId);
  const check = lastCheck(server);
  const toolCount = server.probe?.ok ? server.probe.tools.length : null;
  const showMessage = server.statusMessage && (server.status === "failing" || server.status === "error");

  return (
    <li
      id={`mcp-server-${server.name}`}
      style={{ "--stagger": index } as React.CSSProperties}
      className="animate-card-in scroll-mt-24 rounded-2xl bg-card p-3 ring-1 ring-foreground/10 sm:p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ProviderTile provider={provider} className={cn(!server.enabled && "opacity-60")} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm font-medium">{server.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {provider?.name ?? server.providerId}
              {server.credential && <> · {server.credential.name}</>}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 max-sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <McpStatusBadge
              status={server.status}
              message={server.statusMessage ?? check?.message ?? null}
              checkedAt={check?.at ?? null}
              latencyMs={check?.latencyMs ?? null}
              checking={testing}
            />
            {!server.synced && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="inline-flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2.5 text-xs font-medium whitespace-nowrap text-amber-700 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:text-amber-300"
                  >
                    <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
                    Out of sync
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-72">
                  mcp.json does not hold this entry as AgentMan wrote it (edited by hand, or the write failed). Repair
                  rewrites it.
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                {/* The switch's own hit area grows to 44 px on phones; the padding keeps it clear of the buttons. */}
                <span className="flex items-center px-2.5">
                  <Switch
                    checked={server.enabled}
                    disabled={updating}
                    onCheckedChange={onToggleEnabled}
                    aria-label={`Load ${server.name} in agents`}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>{server.enabled ? "Enabled: agents load it" : "Disabled"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="pressable-icon size-11 md:size-8"
                  aria-label={`Test ${server.name} now`}
                  disabled={testing}
                  onClick={onTest}
                >
                  {testing ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <ZapIcon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Test now</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="pressable-icon size-11 md:size-8"
                  aria-label={`More actions for ${server.name}`}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuItem onSelect={onToggleExpanded}>
                  <ListTreeIcon />
                  {expanded ? "Hide tools & config" : "Show tools & config"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void copyText(mcpConfigJson(server)).then(
                      () =>
                        toast.success("MCP config copied", {
                          description: "Secrets appear as environment-variable placeholders: set them where the server runs.",
                        }),
                      () => toast.error("Could not copy"),
                    )
                  }
                >
                  <CopyIcon />
                  Copy config
                </DropdownMenuItem>
                {!server.credential && (
                  <DropdownMenuItem disabled>
                    <KeyRoundIcon />
                    Credential deleted
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                  <Trash2Icon />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:ml-13">
        <Badge variant="outline" className="font-mono text-[0.7rem] text-muted-foreground">
          {server.transport === "http" ? "HTTP" : "stdio"}
        </Badge>
        {toolCount !== null && (
          <button
            type="button"
            className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 max-md:min-h-11"
            aria-expanded={expanded}
            aria-controls={expanded ? `mcp-server-${server.name}-details` : undefined}
            onClick={onToggleExpanded}
          >
            {toolCount} {toolCount === 1 ? "tool" : "tools"}
          </button>
        )}
        <span title={check ? formatDateTime(check.at) : undefined}>
          {check ? `Checked ${formatRelative(check.at, now)}` : "Never checked"}
        </span>
      </div>

      {showMessage && (
        <p
          className={cn(
            "mt-2 line-clamp-3 text-xs break-words sm:ml-13",
            server.status === "error" ? "text-amber-700 dark:text-amber-300" : "text-destructive",
          )}
        >
          {server.statusMessage}
        </p>
      )}

      {expanded && <ServerDetails server={server} />}
    </li>
  );
}

/** Mirrors `ServerRow`: stacked on phones (identity, then badges + actions), one line from `sm`. */
function ListSkeleton() {
  return (
    <ul className="space-y-2" aria-busy="true" aria-label="Loading MCP servers">
      {[0, 1].map((i) => (
        <li key={i} className="rounded-2xl bg-card p-3 ring-1 ring-foreground/10 sm:p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Skeleton className="size-10 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-32 max-w-full" />
                <Skeleton className="h-3 w-48 max-w-full" />
              </div>
            </div>
            <div className="flex items-center gap-2 max-sm:justify-between">
              <Skeleton className="h-6 w-24 rounded-full" />
              <div className="flex gap-0.5">
                {[0, 1, 2].map((j) => (
                  <Skeleton key={j} className="size-11 rounded-lg md:size-8" />
                ))}
              </div>
            </div>
          </div>
          <Skeleton className="mt-2 h-3 w-40 max-w-full sm:ml-13" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ onBrowseCatalog }: { onBrowseCatalog: () => void }) {
  return (
    <section
      aria-labelledby="mcp-empty-title"
      className="animate-card-in flex flex-col items-start gap-4 rounded-2xl bg-card p-5 ring-1 ring-foreground/10 sm:flex-row sm:items-center sm:p-6"
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary [&_svg]:size-6">
        <PlugIcon />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h3 id="mcp-empty-title" className="font-semibold tracking-tight">
          No MCP servers connected
        </h3>
        <p className="max-w-[60ch] text-sm text-pretty text-muted-foreground">
          Pick one from the catalog below: GitHub, Slack, Notion, a database or your own server. Its tools show up in
          every agent.
        </p>
      </div>
      <Button variant="outline" className="pressable h-11 w-full gap-1.5 sm:w-auto md:h-8" onClick={onBrowseCatalog}>
        <PlusIcon />
        Browse the catalog
      </Button>
    </section>
  );
}

/**
 * The servers AgentMan wrote into mcp.json: status, tools, enable switch, test and remove. `servers`
 * is null while the first load runs. Tests are owned by the page (so "Test all" shows here too).
 */
export function McpServerList({
  servers,
  testing,
  onTest,
  onChanged,
  onBrowseCatalog,
}: {
  servers: McpServerSummary[] | null;
  /** Names of the servers being tested right now. */
  testing: ReadonlySet<string>;
  onTest: (server: McpServerSummary) => void;
  /** Reload after an update or removal. */
  onChanged: () => Promise<void>;
  onBrowseCatalog: () => void;
}) {
  const now = useNow(60_000);
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  function toggleExpanded(name: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  async function setEnabled(server: McpServerSummary, enabled: boolean) {
    setUpdating((s) => new Set(s).add(server.name));
    try {
      await api.mcp.update(server.name, { enabled });
      toast.success(enabled ? `Enabled ${server.name}` : `Disabled ${server.name}`, {
        description: "Agents pick this up on their next run.",
      });
    } catch (err) {
      toast.error(errorText(err, `Could not ${enabled ? "enable" : "disable"} ${server.name}`));
    } finally {
      setUpdating((s) => {
        const next = new Set(s);
        next.delete(server.name);
        return next;
      });
      await onChanged();
    }
  }

  function askRemove(server: McpServerSummary) {
    const credential = server.credential;
    const sharedWith = (servers ?? []).filter((s) => s.name !== server.name && s.credentialId === server.credentialId);
    const keepNote = !credential
      ? null
      : sharedWith.length > 0
        ? ` Its credential “${credential.name}” stays: ${sharedWith.map((s) => s.name).join(", ")} still use${sharedWith.length === 1 ? "s" : ""} it.`
        : null;
    setConfirm({
      title: `Remove ${server.name}?`,
      description: `It is deleted from mcp.json; agents stop loading its tools on their next run.${keepNote ?? ""}`,
      confirmLabel: "Remove",
      destructive: true,
      option: credential && sharedWith.length === 0 ? `Also delete the credential “${credential.name}”` : undefined,
      onConfirm: async (deleteCredential) => {
        await api.mcp.remove(server.name, deleteCredential);
        toast.success(deleteCredential ? `Removed ${server.name} and its credential` : `Removed ${server.name}`);
        await onChanged();
      },
    });
  }

  let body: React.ReactNode;
  if (!servers) body = <ListSkeleton />;
  else if (servers.length === 0) body = <EmptyState onBrowseCatalog={onBrowseCatalog} />;
  else {
    body = (
      <ul className="space-y-2" aria-label="Connected MCP servers">
        {servers.map((server, i) => (
          <ServerRow
            key={server.name}
            server={server}
            index={i}
            now={now}
            testing={testing.has(server.name)}
            updating={updating.has(server.name)}
            expanded={expanded.has(server.name)}
            onTest={() => onTest(server)}
            onToggleEnabled={(enabled) => void setEnabled(server, enabled)}
            onToggleExpanded={() => toggleExpanded(server.name)}
            onRemove={() => askRemove(server)}
          />
        ))}
      </ul>
    );
  }

  return (
    <>
      {body}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}
