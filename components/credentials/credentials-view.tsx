"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CalendarClockIcon,
  CloudOffIcon,
  CopyIcon,
  EllipsisIcon,
  KeyRoundIcon,
  Loader2Icon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { ConfirmDialog, type ConfirmRequest } from "@/components/containers/dialogs";
import { CREDENTIALS_CHANGED_EVENT } from "@/components/credentials/credential-notifications";
import { HealthBadge } from "@/components/credentials/health-badge";
import { ProviderTile } from "@/components/credentials/provider-tile";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import { getCredentialProvider, mcpConfigSnippet } from "@/lib/credential-providers";
import {
  CREDENTIAL_EXPIRY_WARNING_MS,
  type CredentialProvider,
  type CredentialProviderId,
  type CredentialsResponse,
  type CredentialSummary,
} from "@/lib/credential-types";
import { cn, copyText } from "@/lib/utils";

/** List refresh while the page is visible (the server re-checks every 10 min on its own). */
const REFRESH_MS = 60_000;
/** How long a `?focus=` row stays highlighted. */
const HIGHLIGHT_MS = 2400;

/** Shown in the empty state: the providers most people connect first. */
const POPULAR_PROVIDERS: CredentialProviderId[] = [
  "github",
  "slack",
  "notion",
  "linear",
  "openai",
  "anthropic",
  "aws",
  "brave-search",
];

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Tells the notification bell (and anything else listening) that credentials changed. */
export function notifyCredentialsChanged(): void {
  window.dispatchEvent(new Event(CREDENTIALS_CHANGED_EVENT));
}

export type ExpiryState = "expired" | "expiring" | "later";

export function expiryState(expiresAt: string | null, now: number): ExpiryState | null {
  if (!expiresAt) return null;
  const time = new Date(expiresAt).getTime();
  if (Number.isNaN(time)) return null;
  if (time <= now) return "expired";
  return time - now <= CREDENTIAL_EXPIRY_WARNING_MS ? "expiring" : "later";
}

/** Failing, expired, or expiring within the warning window. */
export function needsAttention(credential: CredentialSummary, now: number): boolean {
  if (credential.health === "failing") return true;
  const expiry = expiryState(credential.expiresAt, now);
  return expiry === "expired" || expiry === "expiring";
}

export interface CredentialsList {
  data: CredentialsResponse | null;
  error: string | null;
  reload: () => Promise<void>;
  /** Swap in a fresh response (check-all answers with the whole list). */
  replace: (data: CredentialsResponse) => void;
}

/** Loads the credentials list; refreshes every minute while visible and when the window regains focus. */
export function useCredentialsList(): CredentialsList {
  const [data, setData] = useState<CredentialsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A slow poll must not overwrite a newer answer (a reload after a mutation, or check-all).
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api.credentials.list();
      if (mine !== seq.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError(errorText(err, "Could not load credentials"));
    }
  }, []);

  const replace = useCallback((next: CredentialsResponse) => {
    seq.current++;
    setData(next);
    setError(null);
  }, []);

  useEffect(() => {
    let inFlight = false;
    const tick = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        await reload();
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [reload]);

  return { data, error, reload, replace };
}

/**
 * Values for `mcpConfigSnippet`: non-secret values verbatim; a saved secret only as a marker so
 * its `${ENV_VAR}` placeholder is included (summaries carry masked secrets, never worth copying).
 */
function snippetFields(provider: CredentialProvider, credential: CredentialSummary): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of provider.fields) {
    if (field.kind === "secret") {
      if (credential.secretsSet.includes(field.key)) out[field.key] = "set";
    } else if (credential.fields[field.key]) {
      out[field.key] = credential.fields[field.key];
    }
  }
  return out;
}

function ExpiryChip({ expiresAt, now }: { expiresAt: string | null; now: number }) {
  const state = expiryState(expiresAt, now);
  if (!state || !expiresAt) return null;
  const when = formatRelative(expiresAt, now);
  return (
    <span
      title={formatDateTime(expiresAt)}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium",
        state === "expired" && "bg-destructive/10 text-destructive dark:bg-destructive/20",
        state === "expiring" && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        state === "later" && "bg-muted text-muted-foreground",
      )}
    >
      <CalendarClockIcon className="size-3" aria-hidden="true" />
      {state === "expired" ? `Expired ${when}` : `Expires ${when}`}
    </span>
  );
}

function CredentialRow({
  credential,
  index,
  now,
  checking,
  highlighted,
  onTest,
  onEdit,
  onCopyConfig,
  onDelete,
}: {
  credential: CredentialSummary;
  index: number;
  now: number;
  checking: boolean;
  highlighted: boolean;
  onTest: () => void;
  onEdit: () => void;
  onCopyConfig: () => void;
  onDelete: () => void;
}) {
  const provider = getCredentialProvider(credential.providerId);
  const secrets = (provider?.fields ?? []).filter(
    (field) => field.kind === "secret" && credential.secretsSet.includes(field.key),
  );

  return (
    <li
      id={`credential-${credential.id}`}
      style={{ "--stagger": index } as React.CSSProperties}
      className={cn(
        "animate-card-in flex scroll-mt-24 flex-col gap-3 rounded-2xl bg-card p-3 ring-1 ring-foreground/10 transition-[box-shadow,background-color] duration-500 sm:flex-row sm:items-center sm:gap-4 sm:p-4",
        highlighted && "bg-primary/5 ring-2 ring-primary",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ProviderTile provider={provider} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{credential.name}</p>
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="truncate">{provider?.name ?? credential.providerId}</span>
            {secrets.map((field) => (
              <span key={field.key} className="inline-flex min-w-0 items-center gap-1">
                <span aria-hidden="true">·</span>
                <span className="sr-only">{field.label}:</span>
                <code className="truncate font-mono text-[0.7rem]" title={field.label}>
                  {credential.fields[field.key]}
                </code>
              </span>
            ))}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 max-sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <HealthBadge
            health={credential.health}
            lastCheckedAt={credential.lastCheckedAt}
            lastMessage={credential.lastMessage}
            lastLatencyMs={credential.lastLatencyMs}
            checking={checking}
          />
          <ExpiryChip expiresAt={credential.expiresAt} now={now} />
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="pressable-icon size-11 md:size-8"
                aria-label={`Test ${credential.name} now`}
                disabled={checking}
                onClick={onTest}
              >
                {checking ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <ZapIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Test now</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="pressable-icon size-11 md:size-8"
                aria-label={`Edit ${credential.name}`}
                onClick={onEdit}
              >
                <PencilIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="pressable-icon size-11 md:size-8"
                aria-label={`More actions for ${credential.name}`}
              >
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem className="max-md:min-h-11" disabled={!provider?.mcp} onSelect={onCopyConfig}>
                <CopyIcon />
                Copy MCP config
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="max-md:min-h-11" variant="destructive" onSelect={onDelete}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  );
}

/** Mirrors `CredentialRow`: stacked on phones (identity, then badges + actions), one line from `sm`. */
function ListSkeleton() {
  return (
    <ul className="space-y-2" aria-busy="true" aria-label="Loading credentials">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex flex-col gap-3 rounded-2xl bg-card p-3 ring-1 ring-foreground/10 sm:flex-row sm:items-center sm:gap-4 sm:p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Skeleton className="size-10 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
          </div>
          <div className="flex items-center gap-2 max-sm:justify-between">
            <Skeleton className="h-6 w-20 rounded-full" />
            <div className="flex gap-0.5">
              {[0, 1, 2].map((j) => (
                <Skeleton key={j} className="size-11 rounded-lg md:size-8" />
              ))}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ErrorPanel({ detail, onRetry }: { detail: string; onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <section
      role="alert"
      className="animate-card-in mx-auto w-full max-w-2xl overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10 md:mt-8"
    >
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:gap-5 sm:p-8">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive [&_svg]:size-6">
          <CloudOffIcon />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Could not load credentials</h2>
          <p className="rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
            {detail}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end border-t bg-muted/30 px-5 py-3 sm:px-8">
        <Button
          variant="outline"
          className="pressable h-11 gap-1.5 md:h-8"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            await onRetry();
            setRetrying(false);
          }}
        >
          {retrying ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RefreshCwIcon />}
          Retry
        </Button>
      </div>
    </section>
  );
}

function EmptyState({ onCreate }: { onCreate: (providerId?: CredentialProviderId) => void }) {
  const popular = POPULAR_PROVIDERS.map((id) => getCredentialProvider(id)).filter(
    (p): p is CredentialProvider => Boolean(p),
  );
  return (
    <section
      aria-labelledby="credentials-empty-title"
      className="animate-card-in grid gap-6 rounded-2xl bg-card p-5 ring-1 ring-foreground/10 sm:p-8 md:mt-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-10"
    >
      <div className="flex flex-col items-start gap-4">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary [&_svg]:size-6">
          <KeyRoundIcon />
        </span>
        <div className="space-y-1.5">
          <h2 id="credentials-empty-title" className="text-lg font-semibold tracking-tight">
            No credentials yet
          </h2>
          <p className="max-w-[48ch] text-sm text-pretty text-muted-foreground">
            Save API keys and tokens for the MCP servers and services your agents use. They are encrypted on the
            server and checked in the background.
          </p>
        </div>
        <Button
          variant="outline"
          className="pressable h-11 w-full gap-1.5 sm:w-auto md:mt-auto md:h-8"
          onClick={() => onCreate()}
        >
          <PlusIcon />
          Browse all providers
        </Button>
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Popular</h3>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {popular.map((provider, i) => (
            <li key={provider.id} className="animate-card-in" style={{ "--stagger": i } as React.CSSProperties}>
              <button
                type="button"
                onClick={() => onCreate(provider.id)}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl p-2.5 text-left text-sm font-medium ring-1 ring-foreground/10 transition-[background-color,box-shadow,scale] duration-150 ease-(--ease-fluid) outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:transition-none"
                aria-label={`Add ${provider.name} credential`}
              >
                <ProviderTile provider={provider} size="sm" />
                <span className="truncate">{provider.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function CredentialsView({
  list,
  focusId,
  onFocusHandled,
  onCreate,
  onEdit,
}: {
  list: CredentialsList;
  /** Credential to scroll to and highlight (the bell's `?focus=`). */
  focusId: string | null;
  onFocusHandled: () => void;
  onCreate: (providerId?: CredentialProviderId) => void;
  onEdit: (credential: CredentialSummary) => void;
}) {
  const { data, error, reload } = list;
  const now = useNow(60_000);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const afterMutation = useCallback(async () => {
    await reload();
    notifyCredentialsChanged();
  }, [reload]);

  // Scroll to the focused row once it is rendered and flash it; the parent then clears `focusId`.
  useEffect(() => {
    if (!focusId || !data) return;
    const row = document.getElementById(`credential-${focusId}`);
    onFocusHandled();
    if (!row) {
      toast.error("That credential no longer exists");
      return;
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    setHighlightId(focusId);
  }, [focusId, data, onFocusHandled]);

  // Separate from the effect above: clearing `focusId` must not cancel the fade-out timer.
  useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  async function testNow(credential: CredentialSummary) {
    setChecking((s) => new Set(s).add(credential.id));
    try {
      const { result } = await api.credentials.check(credential.id);
      if (result.ok) toast.success(`${credential.name}: ${result.message}`);
      else toast.error(`${credential.name} failed its check`, { description: result.message });
    } catch (err) {
      toast.error(errorText(err, "Could not run the check"));
    } finally {
      setChecking((s) => {
        const next = new Set(s);
        next.delete(credential.id);
        return next;
      });
      await afterMutation();
    }
  }

  function copyConfig(credential: CredentialSummary) {
    const provider = getCredentialProvider(credential.providerId);
    const snippet = provider ? mcpConfigSnippet(provider, snippetFields(provider, credential)) : null;
    if (!snippet) {
      toast.error("This provider has no MCP server config");
      return;
    }
    void copyText(snippet).then(
      () =>
        toast.success("MCP config copied", {
          description: "Secrets appear as environment-variable placeholders: set them where the MCP server runs.",
        }),
      () => toast.error("Could not copy"),
    );
  }

  function askDelete(credential: CredentialSummary) {
    setConfirm({
      title: `Delete ${credential.name}?`,
      description: "Agents using it lose access. The encrypted value is erased and cannot be recovered.",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: async () => {
        await api.credentials.remove(credential.id);
        toast.success(`Deleted ${credential.name}`);
        await afterMutation();
      },
    });
  }

  let body: React.ReactNode;
  if (!data) {
    body = error ? <ErrorPanel detail={error} onRetry={reload} /> : <ListSkeleton />;
  } else if (data.credentials.length === 0) {
    body = <EmptyState onCreate={onCreate} />;
  } else {
    const sorted = [...data.credentials].sort((a, b) => a.name.localeCompare(b.name));
    body = (
      <ul className="space-y-2" aria-label="Credentials">
        {sorted.map((credential, i) => (
          <CredentialRow
            key={credential.id}
            credential={credential}
            index={i}
            now={now}
            checking={checking.has(credential.id)}
            highlighted={highlightId === credential.id}
            onTest={() => void testNow(credential)}
            onEdit={() => onEdit(credential)}
            onCopyConfig={() => copyConfig(credential)}
            onDelete={() => askDelete(credential)}
          />
        ))}
      </ul>
    );
  }

  const minutes = data ? Math.max(1, Math.round(data.checkIntervalMs / 60_000)) : 0;

  return (
    <div className="space-y-4">
      {data && error && (
        <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          Could not refresh: {error}
        </p>
      )}
      {body}
      {data && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-2 text-xs text-muted-foreground">
          <LockIcon className="size-3.5" aria-hidden="true" />
          <span>
            Encrypted with{" "}
            <code className="font-mono">{data.keySource === "env" ? "CREDENTIALS_KEY" : "DATA_DIR/credentials.key"}</code>
          </span>
          <span aria-hidden="true">·</span>
          <span>Checked every {minutes} min</span>
        </p>
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
