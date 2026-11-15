"use client";

// Settings → Cluster: turn this server into the primary of a cluster or join one as a replica;
// on a primary, add machines (join command, token), choose where cards run and watch the nodes;
// on a replica, check the link to the primary or leave the cluster.
import { useCallback, useEffect, useState } from "react";
import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  HouseIcon,
  Loader2Icon,
  LogInIcon,
  LogOutIcon,
  NetworkIcon,
  PlugZapIcon,
  PowerOffIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { PasswordInput } from "@/components/password-input";
import {
  SettingsField,
  SettingsGroup,
  SettingsPanel,
  SettingsRows,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/settings-section";
import { replicationText } from "@/components/stats/cluster-section";
import { formatBytes, Meter } from "@/components/stats/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClusterStatus, refreshClusterStatus, setClusterStatus } from "@/hooks/use-cluster";
import { useCurrentUser } from "@/hooks/use-current-user";
import { api } from "@/lib/api-client";
import {
  CLUSTER_FAILOVER_LIMITS,
  type ClusterJoinInfo,
  type ClusterNodeStatus,
  type ClusterStatus,
  type ClusterTestResult,
} from "@/lib/types";
import { cn, copyText } from "@/lib/utils";

const FIELD = "h-11 md:h-9";
const HTTP_URL = /^https?:\/\/\S+$/i;
/** Stands in for the join token while it is hidden. */
const MASK = "••••••••••••••••";
const SUCCESS_BADGE = "bg-success/15 text-success";
const WARNING_BADGE = "bg-amber-500/15 text-amber-700 dark:text-amber-400";

const CONNECTION_BADGE: Record<NonNullable<ClusterStatus["connection"]>["state"], { label: string; className: string }> = {
  connected: { label: "Connected", className: SUCCESS_BADGE },
  connecting: { label: "Reconnecting", className: WARNING_BADGE },
  electing: { label: "Electing a new primary", className: WARNING_BADGE },
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Why `raw` is not an acceptable failover delay (CLUSTER_FAILOVER_LIMITS, whole seconds), or null. */
function failoverError(raw: string): string | null {
  const { min, max } = CLUSTER_FAILOVER_LIMITS;
  const n = Number(raw);
  return raw.trim() !== "" && Number.isInteger(n) && n >= min && n <= max
    ? null
    : `Enter a whole number of seconds from ${min} to ${max}.`;
}

// ---------------------------------------------------------------------------------------------
// Shared pieces

/**
 * Confirmation for one cluster change. `onConfirm` performs it (and reports the outcome itself);
 * the dialog stays open, busy, until it settles and closes when it returns true.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  icon,
  title,
  children,
  confirmLabel,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: React.ReactNode;
  title: string;
  /** The description: what happens. */
  children: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm(e: React.MouseEvent) {
    // Keep the dialog open until the request settles.
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (await onConfirm()) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogMedia className={destructive ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}>
            {icon}
          </AlertDialogMedia>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">{children}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} className="max-md:h-11">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={confirm}
            className="max-md:h-11"
          >
            {busy && <Loader2Icon className="animate-spin" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Outline button that copies `text`, confirming with a check for two seconds. */
function CopyButton({ text, label, toastLabel }: { text: string; label: string; toastLabel: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function onCopy() {
    try {
      await copyText(text);
      setCopied(true);
      toast.success(toastLabel);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it manually.");
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => void onCopy()}
      className={cn(FIELD, "pressable shrink-0 px-3")}
      aria-label={label}
    >
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

/** What a connection test found, under the button that ran it. */
function TestResultNote({ result }: { result: ClusterTestResult }) {
  if (!result.ok || !result.node) {
    return (
      <p role="alert" className="flex gap-2 text-xs text-destructive">
        <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">{result.error ?? "The connection failed."}</span>
      </p>
    );
  }
  const { node } = result;
  return (
    <div role="status" className="space-y-1 text-xs">
      <p className="flex gap-2 text-success">
        <CircleCheckIcon className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          Reached <span className="font-semibold">{node.name}</span> ({node.role}, v{node.version}
          {result.latencyMs !== null && `, ${Math.round(result.latencyMs)} ms`})
        </span>
      </p>
      {node.role !== "primary" && (
        <p className="pl-5.5 text-amber-700 dark:text-amber-400">
          That server is {node.role === "replica" ? "a replica" : "not in a cluster"}; join its primary instead.
        </p>
      )}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 text-right">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Nodes

/** Small label + value cell of a node row. */
function NodeFigure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-xs tabular-nums [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function NodeItem({
  node,
  home,
  now,
  onRemove,
}: {
  node: ClusterNodeStatus;
  /** The cluster's home primary (failback target). */
  home: boolean;
  now: number;
  /** Offered for other replicas on a primary, to admins; omitted otherwise. */
  onRemove?: () => void;
}) {
  const res = node.resources;
  const running = node.runningTaskIds.length;
  const usedMemory = res ? res.totalMemoryBytes - res.freeMemoryBytes : 0;
  const link = node.httpUrl && !node.self;
  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="min-w-0 truncate text-sm font-medium" title={node.name}>
          {link ? (
            <a
              href={node.httpUrl ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {node.name}
            </a>
          ) : (
            node.name
          )}
        </span>
        {node.self && <Badge variant="outline">This server</Badge>}
        <Badge className={node.role === "primary" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}>
          {node.role === "primary" ? "Primary" : "Replica"}
        </Badge>
        {home && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge tabIndex={0} className={cn(WARNING_BADGE, "cursor-help")}>
                <HouseIcon />
                Home
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Gets control back after a failover</TooltipContent>
          </Tooltip>
        )}
        <Badge className={node.online ? SUCCESS_BADGE : "bg-destructive/10 text-destructive"}>
          <span aria-hidden className={cn("size-1.5 rounded-full", node.online ? "bg-success" : "bg-destructive")} />
          {node.online ? "Online" : "Offline"}
        </Badge>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            aria-label={`Remove ${node.name} from the cluster`}
            title="Remove from the cluster"
            className="pressable-icon ml-auto size-11 text-muted-foreground hover:text-destructive md:size-8"
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      <p className="truncate font-mono text-xs text-muted-foreground" title={node.address}>
        {node.address} · v{node.version}
        {!node.online && (
          <>
            {" · last seen "}
            <time dateTime={node.lastSeenAt} title={formatDateTime(node.lastSeenAt)}>
              {formatRelative(node.lastSeenAt, now)}
            </time>
          </>
        )}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <NodeFigure label="CPU">
          {res ? (
            <>
              {res.cpus} {res.cpus === 1 ? "core" : "cores"} · load <span className="font-mono">{res.loadAvg1.toFixed(2)}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Not reported</span>
          )}
        </NodeFigure>
        <NodeFigure label="Memory">
          {res ? (
            <div className="flex flex-col gap-1.5">
              <span>
                {formatBytes(usedMemory)} / {formatBytes(res.totalMemoryBytes)}
              </span>
              <Meter
                fraction={res.totalMemoryBytes > 0 ? usedMemory / res.totalMemoryBytes : 0}
                label={`${node.name} memory usage`}
              />
            </div>
          ) : (
            <span className="text-muted-foreground">Not reported</span>
          )}
        </NodeFigure>
        <NodeFigure label="Agent slots">
          {running} / {node.slots} in use
        </NodeFigure>
        <NodeFigure label="Running cards">{running}</NodeFigure>
        <NodeFigure label="omp">
          {node.omp.ready ? (
            <>
              <span className="font-mono">{node.omp.version ?? "ready"}</span>
              {node.omp.source && (
                <span className="text-muted-foreground">
                  {node.omp.source === "primary" ? " · shared by the primary" : " · installed locally"}
                </span>
              )}
            </>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">
              Not ready{node.omp.reason ? `: ${node.omp.reason}` : ""}
            </span>
          )}
        </NodeFigure>
        <NodeFigure label="Replication · latency">
          {replicationText(node)} · {node.latencyMs === null ? "—" : `${Math.round(node.latencyMs)} ms`}
        </NodeFigure>
      </dl>
    </li>
  );
}

/** Every node of the cluster; `canRemove` offers removing replicas (primary, admins). */
function NodesGroup({ status, canRemove }: { status: ClusterStatus; canRemove: boolean }) {
  const now = useNow();
  const [removing, setRemoving] = useState<ClusterNodeStatus | null>(null);

  async function remove(node: ClusterNodeStatus): Promise<boolean> {
    try {
      await api.cluster.removeNode(node.nodeId);
      toast.success(`Removed ${node.name} from the cluster`);
      await refreshClusterStatus();
      return true;
    } catch (err) {
      toast.error(errorText(err, `Could not remove ${node.name}.`));
      return false;
    }
  }

  return (
    <SettingsGroup title={`Nodes (${status.totals.online}/${status.totals.nodes} online)`}>
      <ul aria-label="Cluster nodes" className="divide-y divide-border/70">
        {status.nodes.map((node) => (
          <NodeItem
            key={node.nodeId}
            node={node}
            home={node.nodeId === status.preferredPrimaryId}
            now={now}
            onRemove={canRemove && node.role === "replica" && !node.self ? () => setRemoving(node) : undefined}
          />
        ))}
      </ul>
      {removing && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(null)}
          icon={<Trash2Icon />}
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove node"
          destructive
          onConfirm={() => remove(removing)}
        >
          <p>
            It is disconnected from the cluster and, if it is online, turns back into a standalone server. Cards running
            on it are rescheduled. It can join again with the join command.
          </p>
        </ConfirmDialog>
      )}
    </SettingsGroup>
  );
}

// ---------------------------------------------------------------------------------------------
// Standalone

/** Join an existing cluster as a replica: primary URL + token, connection test, confirmed join. */
function JoinGroup() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ClusterTestResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const urlError = HTTP_URL.test(url.trim()) ? null : "Enter the primary's address, e.g. http://10.0.0.5:3000.";
  const tokenError = token.trim() ? null : "Paste the join token from the primary's Settings → Cluster.";
  const valid = !urlError && !tokenError;

  function edit(set: (value: string) => void, value: string) {
    set(value);
    setResult(null); // The last test was for other values.
  }

  async function test() {
    setSubmitted(true);
    if (!valid || testing) return;
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.cluster.test(url.trim(), token.trim()));
    } catch (err) {
      setResult({ ok: false, latencyMs: null, node: null, error: errorText(err, "Could not test the connection.") });
    } finally {
      setTesting(false);
    }
  }

  async function join(): Promise<boolean> {
    try {
      const next = await api.cluster.join(url.trim(), token.trim());
      setClusterStatus(next);
      toast.success(`Joining ${next.primary?.name ?? "the cluster"}`, {
        description: "This server restarts as a replica; the page reconnects by itself.",
      });
      return true;
    } catch (err) {
      toast.error(errorText(err, "Could not join the cluster."));
      return false;
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitted(true);
    if (valid) setConfirming(true);
  }

  return (
    <SettingsGroup title="Join a cluster">
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <SettingsField
          label="Primary URL"
          htmlFor="cluster-join-url"
          hint="The address you open the primary's web UI with."
          error={submitted ? urlError : null}
        >
          <Input
            id="cluster-join-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://10.0.0.5:3000"
            value={url}
            onChange={(e) => edit(setUrl, e.target.value)}
            aria-invalid={submitted && urlError ? true : undefined}
            aria-describedby={submitted && urlError ? "cluster-join-url-error" : undefined}
            className={cn(FIELD, "font-mono")}
          />
        </SettingsField>
        <SettingsField
          label="Join token"
          htmlFor="cluster-join-token"
          hint="Shown in the primary's Settings → Cluster."
          error={submitted ? tokenError : null}
        >
          <PasswordInput
            id="cluster-join-token"
            autoComplete="off"
            placeholder="omc_…"
            value={token}
            onChange={(e) => edit(setToken, e.target.value)}
            aria-invalid={submitted && tokenError ? true : undefined}
            aria-describedby={submitted && tokenError ? "cluster-join-token-error" : undefined}
            className="font-mono"
          />
        </SettingsField>
        {result && <TestResultNote result={result} />}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            onClick={() => void test()}
            disabled={testing}
            className={cn(FIELD, "pressable gap-2")}
          >
            {testing ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />}
            Test connection
          </Button>
          <Button type="submit" disabled={testing} className={cn(FIELD, "pressable gap-2")}>
            <LogInIcon />
            Join cluster
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        icon={<TriangleAlertIcon />}
        title="Join this cluster?"
        confirmLabel="Replace data and join"
        destructive
        onConfirm={join}
      >
        <p>
          This server becomes a replica of <span className="font-mono break-all">{url.trim()}</span>: its own projects,
          cards and settings are replaced by the primary's (the current database is backed up first), and it restarts.
        </p>
        <p>Afterwards it runs cards for the primary and can take over if the primary goes down.</p>
      </ConfirmDialog>
    </SettingsGroup>
  );
}

function StandalonePanel() {
  const [enabling, setEnabling] = useState(false);

  async function enable() {
    if (enabling) return;
    setEnabling(true);
    try {
      setClusterStatus(await api.cluster.enable());
      toast.success("Cluster mode is on", { description: "This server is the primary. Add machines with the join command." });
    } catch (err) {
      toast.error(errorText(err, "Could not turn on cluster mode."));
    } finally {
      setEnabling(false);
    }
  }

  return (
    <SettingsPanel>
      <SettingsGroup>
        <SettingsRows>
          <SettingsToggle
            htmlFor="cluster-enabled"
            title="Enable cluster mode"
            description="Make this server the primary of a new cluster: it coordinates, and other machines join it to run cards."
          >
            <Switch
              id="cluster-enabled"
              checked={enabling}
              disabled={enabling}
              onCheckedChange={(checked) => checked && void enable()}
            />
          </SettingsToggle>
        </SettingsRows>
      </SettingsGroup>
      <JoinGroup />
    </SettingsPanel>
  );
}

// ---------------------------------------------------------------------------------------------
// Primary

/** Admins: the one-liner that joins a new machine, and the join token behind it. */
function AddMachineGroup() {
  const [info, setInfo] = useState<ClusterJoinInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api.cluster
      .token()
      .then(setInfo)
      .catch((err) => setError(errorText(err, "Could not load the join token.")));
  }, []);

  useEffect(load, [load]);

  async function rotate(): Promise<boolean> {
    try {
      setInfo(await api.cluster.rotateToken());
      toast.success("Join token rotated", { description: "Use the new join command for the next machines." });
      return true;
    } catch (err) {
      toast.error(errorText(err, "Could not rotate the join token."));
      return false;
    }
  }

  if (error) {
    return (
      <SettingsGroup title="Add a machine">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <p className="flex min-w-0 flex-1 gap-2 text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {error}
          </p>
          <Button type="button" variant="outline" onClick={load} className={cn(FIELD, "pressable gap-2")}>
            <RotateCcwIcon />
            Try again
          </Button>
        </div>
      </SettingsGroup>
    );
  }
  if (!info) {
    return (
      <SettingsGroup title="Add a machine">
        <div aria-busy="true" className="space-y-3">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-11 w-full md:h-9" />
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-11 w-full md:h-9" />
        </div>
      </SettingsGroup>
    );
  }

  const command = revealed ? info.joinCommand : info.joinCommand.replaceAll(info.token, MASK);
  return (
    <SettingsGroup title="Add a machine">
      <SettingsField
        label="Join command"
        htmlFor="cluster-join-command"
        hint="Run it on the new machine (Linux or macOS). It downloads everything needed, omp included, and joins this cluster; nothing else to set up."
      >
        <div className="flex gap-2">
          <Input
            id="cluster-join-command"
            value={command}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
            className={cn(FIELD, "min-w-0 flex-1 font-mono text-xs")}
          />
          <CopyButton text={info.joinCommand} label="Copy join command" toastLabel="Join command copied" />
        </div>
      </SettingsField>
      <SettingsField
        label="Join token"
        htmlFor="cluster-token"
        hint="Anyone with the token can join this cluster. Rotating it keeps the nodes already in."
      >
        <div className="flex flex-wrap gap-2">
          <Input
            id="cluster-token"
            value={revealed ? info.token : MASK}
            readOnly
            onFocus={(e) => revealed && e.currentTarget.select()}
            className={cn(FIELD, "min-w-0 flex-1 basis-56 font-mono text-xs")}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRevealed((v) => !v)}
              aria-pressed={revealed}
              aria-label={revealed ? "Hide join token" : "Show join token"}
              className={cn(FIELD, "pressable shrink-0 px-3")}
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
              <span className="hidden sm:inline">{revealed ? "Hide" : "Show"}</span>
            </Button>
            <CopyButton text={info.token} label="Copy join token" toastLabel="Join token copied" />
            <Button
              type="button"
              variant="outline"
              onClick={() => setRotating(true)}
              className={cn(FIELD, "pressable shrink-0 px-3")}
              aria-label="Rotate join token"
            >
              <RefreshCwIcon />
              <span className="hidden sm:inline">Rotate</span>
            </Button>
          </div>
        </div>
      </SettingsField>
      <ConfirmDialog
        open={rotating}
        onOpenChange={setRotating}
        icon={<RefreshCwIcon />}
        title="Rotate the join token?"
        confirmLabel="Rotate token"
        onConfirm={rotate}
      >
        <p>
          The current token and join command stop working for new machines. Nodes already in the cluster stay connected
          and get the new token.
        </p>
      </ConfirmDialog>
    </SettingsGroup>
  );
}

/** Where cards run and how fast replicas take over: clusterRunLocal and clusterFailoverSeconds. */
function SchedulingGroup({ status }: { status: ClusterStatus }) {
  /** The run-local value being saved; null when none is in flight. */
  const [pendingRunLocal, setPendingRunLocal] = useState<boolean | null>(null);
  const [savedFailover, setSavedFailover] = useState<number | null>(null);
  const [failover, setFailover] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingFailover, setSavingFailover] = useState(false);
  const { min, max } = CLUSTER_FAILOVER_LIMITS;

  useEffect(() => {
    api.settings
      .get()
      .then((settings) => {
        setSavedFailover(settings.clusterFailoverSeconds);
        setFailover(String(settings.clusterFailoverSeconds));
      })
      .catch((err) => setLoadError(errorText(err, "Could not load the failover delay.")));
  }, []);

  async function saveRunLocal(checked: boolean) {
    setPendingRunLocal(checked);
    try {
      await api.settings.update({ clusterRunLocal: checked });
      await refreshClusterStatus();
      toast.success(checked ? "Cards also run on this machine" : "Cards run on the nodes only");
    } catch (err) {
      toast.error(errorText(err, "Could not save the setting."));
    } finally {
      setPendingRunLocal(null);
    }
  }

  const failoverInvalid = failoverError(failover);
  async function saveFailover() {
    if (savingFailover || failoverInvalid || savedFailover === null || Number(failover) === savedFailover) return;
    setSavingFailover(true);
    try {
      const settings = await api.settings.update({ clusterFailoverSeconds: Number(failover) });
      setSavedFailover(settings.clusterFailoverSeconds);
      setFailover(String(settings.clusterFailoverSeconds));
      toast.success("Failover delay saved");
    } catch (err) {
      toast.error(errorText(err, "Could not save the failover delay."));
    } finally {
      setSavingFailover(false);
    }
  }

  const showFailoverError = savedFailover !== null && failoverInvalid;
  return (
    <SettingsGroup title="Scheduling">
      <SettingsRows>
        <SettingsToggle
          htmlFor="cluster-run-local"
          title="Run cards on this machine too"
          description="Off: this server only coordinates and every card runs on a node."
        >
          <Switch
            id="cluster-run-local"
            checked={pendingRunLocal ?? status.runLocal}
            disabled={pendingRunLocal !== null}
            onCheckedChange={(checked) => void saveRunLocal(checked)}
          />
        </SettingsToggle>
      </SettingsRows>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void saveFailover();
        }}
      >
        <SettingsField
          label="Failover delay (seconds)"
          htmlFor="cluster-failover"
          hint={
            loadError ??
            `How long replicas wait after losing the primary before they promote one of them (${min}–${max}). Saved when you leave the field.`
          }
          error={showFailoverError ? failoverInvalid : null}
        >
          <div className="flex items-center gap-2">
            <Input
              id="cluster-failover"
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              step={1}
              value={failover}
              onChange={(e) => setFailover(e.target.value)}
              onBlur={() => void saveFailover()}
              disabled={savedFailover === null || savingFailover}
              aria-invalid={showFailoverError ? true : undefined}
              aria-describedby={showFailoverError ? "cluster-failover-error" : undefined}
              className={cn(FIELD, "w-32 font-mono tabular-nums")}
            />
            {savingFailover && <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-label="Saving" />}
          </div>
        </SettingsField>
      </form>
    </SettingsGroup>
  );
}

function PrimaryPanel({ status, isAdmin }: { status: ClusterStatus; isAdmin: boolean }) {
  const [disabling, setDisabling] = useState(false);

  async function disable(): Promise<boolean> {
    try {
      setClusterStatus(await api.cluster.disable());
      toast.success("Cluster mode is off", { description: "This server runs on its own again." });
      return true;
    } catch (err) {
      toast.error(errorText(err, "Could not turn off cluster mode."));
      return false;
    }
  }

  return (
    <SettingsPanel>
      <SettingsGroup>
        <SettingsRows>
          <SettingsToggle
            htmlFor="cluster-enabled"
            title="Cluster mode"
            description={`This server (${status.nodeName}) is the primary: it coordinates the cluster and dispatches cards to its nodes.`}
          >
            <Switch id="cluster-enabled" checked onCheckedChange={(checked) => !checked && setDisabling(true)} />
          </SettingsToggle>
        </SettingsRows>
      </SettingsGroup>
      {isAdmin && <AddMachineGroup />}
      <SchedulingGroup status={status} />
      <NodesGroup status={status} canRemove={isAdmin} />
      <ConfirmDialog
        open={disabling}
        onOpenChange={setDisabling}
        icon={<PowerOffIcon />}
        title="Turn off cluster mode?"
        confirmLabel="Turn off"
        destructive
        onConfirm={disable}
      >
        <p>
          This server stops coordinating the cluster and every node is disconnected. Cards then run on this machine
          only.
        </p>
      </ConfirmDialog>
    </SettingsPanel>
  );
}

// ---------------------------------------------------------------------------------------------
// Replica

function ReplicaPanel({ status }: { status: ClusterStatus }) {
  const now = useNow();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ClusterTestResult | null>(null);
  const [leaving, setLeaving] = useState(false);
  const { primary, connection } = status;
  const self = status.nodes.find((node) => node.self) ?? null;

  async function test() {
    if (!primary || testing) return;
    setTesting(true);
    setResult(null);
    try {
      // An empty token makes the server use the one it joined with.
      setResult(await api.cluster.test(primary.httpUrl, ""));
    } catch (err) {
      setResult({ ok: false, latencyMs: null, node: null, error: errorText(err, "Could not test the connection.") });
    } finally {
      setTesting(false);
    }
  }

  async function leave(): Promise<boolean> {
    try {
      setClusterStatus(await api.cluster.leave());
      toast.success("Left the cluster", { description: "This server is standalone again, with its copy of the data." });
      return true;
    } catch (err) {
      toast.error(errorText(err, "Could not leave the cluster."));
      return false;
    }
  }

  const badge = connection ? CONNECTION_BADGE[connection.state] : null;
  return (
    <SettingsPanel>
      <SettingsGroup title="Primary">
        <dl className="divide-y">
          <InfoRow label="Primary">
            {primary ? (
              <a
                href={primary.httpUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 min-w-0 items-center gap-1 rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-0"
              >
                <span className="truncate">{primary.name}</span>
                <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="sr-only">(opens {primary.httpUrl})</span>
              </a>
            ) : (
              <span className="text-muted-foreground">Unknown</span>
            )}
          </InfoRow>
          <InfoRow label="Connection">
            {badge && connection ? (
              <>
                <Badge className={badge.className}>{badge.label}</Badge>
                <time
                  dateTime={connection.since}
                  title={formatDateTime(connection.since)}
                  className="text-xs text-muted-foreground"
                >
                  since {formatRelative(connection.since, now)}
                </time>
              </>
            ) : (
              <span className="text-muted-foreground">Not connected</span>
            )}
          </InfoRow>
          <InfoRow label="Latency">
            <span className="font-mono text-xs tabular-nums">
              {!connection || connection.latencyMs === null ? "—" : `${Math.round(connection.latencyMs)} ms`}
            </span>
          </InfoRow>
          {self && (
            <InfoRow label="Replicated data">
              <span className="text-xs">{replicationText(self)}</span>
            </InfoRow>
          )}
        </dl>
        {connection?.error && (
          <p role="alert" className="flex gap-2 text-xs text-destructive">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">{connection.error}</span>
          </p>
        )}
        {result && <TestResultNote result={result} />}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            onClick={() => void test()}
            disabled={!primary || testing}
            className={cn(FIELD, "pressable gap-2")}
          >
            {testing ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />}
            Test connection
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setLeaving(true)}
            className={cn(FIELD, "pressable gap-2 text-destructive hover:text-destructive")}
          >
            <LogOutIcon />
            Leave cluster
          </Button>
        </div>
      </SettingsGroup>
      <NodesGroup status={status} canRemove={false} />
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        icon={<LogOutIcon />}
        title="Leave the cluster?"
        confirmLabel="Leave cluster"
        destructive
        onConfirm={leave}
      >
        <p>
          This server stops following {primary?.name ?? "the primary"} and becomes standalone, keeping its copy of the
          data as its own. It no longer runs cards for the cluster or takes over when the primary goes down.
        </p>
      </ConfirmDialog>
    </SettingsPanel>
  );
}

// ---------------------------------------------------------------------------------------------

function ClusterSkeleton() {
  return (
    <SettingsPanel>
      <div aria-busy="true" className="divide-y">
        <div className="flex items-center gap-4 p-4 sm:p-5">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </div>
        <div className="space-y-3 p-4 sm:p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-11 w-full md:h-9" />
          <Skeleton className="h-11 w-full md:h-9" />
        </div>
      </div>
    </SettingsPanel>
  );
}

/**
 * Settings → Cluster. Everyone sees the role and the nodes; changes are for admins (the page
 * renders the section read-only for others, and the join token is only fetched for admins).
 */
export function ClusterSettingsSection() {
  const { isAdmin } = useCurrentUser();
  const { status, error, reload } = useClusterStatus();

  return (
    <SettingsSection
      id="cluster"
      icon={<NetworkIcon />}
      title="Cluster"
      description="Spread agent runs over several machines. Replicas keep a copy of the primary's data and one takes over if the primary goes down."
    >
      {!status ? (
        error ? (
          <SettingsPanel className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
            <div className="flex min-w-0 flex-1 gap-3">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">Couldn't load the cluster status</p>
                <p className="text-destructive">{error}</p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void reload()}
              className={cn(FIELD, "pressable w-full gap-2 sm:w-auto")}
            >
              <RotateCcwIcon />
              Try again
            </Button>
          </SettingsPanel>
        ) : (
          <ClusterSkeleton />
        )
      ) : status.role === "standalone" ? (
        <StandalonePanel />
      ) : status.role === "primary" ? (
        <PrimaryPanel status={status} isAdmin={isAdmin} />
      ) : (
        <ReplicaPanel status={status} />
      )}
    </SettingsSection>
  );
}
