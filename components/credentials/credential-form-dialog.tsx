"use client";

import { useId, useMemo, useRef, useState } from "react";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronLeftIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PlugZapIcon,
  SearchIcon,
  XCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { errorText } from "@/components/credentials/credentials-view";
import { formatLatency } from "@/components/credentials/health-badge";
import { ProviderTile } from "@/components/credentials/provider-tile";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import {
  CREDENTIAL_PROVIDERS,
  getCredentialProvider,
  mcpConfigSnippet,
  validateCredentialInput,
} from "@/lib/credential-providers";
import {
  CREDENTIAL_CATEGORY_LABELS,
  type CredentialCategory,
  type CredentialField,
  type CredentialInput,
  type CredentialProvider,
  type CredentialProviderId,
  type CredentialSummary,
  type CredentialUpdate,
} from "@/lib/credential-types";
import { cn, copyText } from "@/lib/utils";

/** What the dialog is open for: a new credential (optionally with the provider chosen) or an edit. */
export type CredentialDialogState =
  | { mode: "create"; providerId?: CredentialProviderId }
  | { mode: "edit"; credential: CredentialSummary };

type TestBanner = { ok: boolean; message: string; latencyMs?: number };

const FULL_MASK = "••••••••";

/** Local calendar date (`<input type="date">` value) of an ISO timestamp. */
function dateInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A key "expires on" a day: store the end of that local day, so it is valid through it. */
function isoFromDateInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function keepPlaceholder(masked: string | undefined): string {
  const tail = masked && masked !== FULL_MASK ? `••••${masked.slice(-4)}` : FULL_MASK;
  return `Saved (${tail}) — leave blank to keep`;
}

function initialFields(provider: CredentialProvider, credential?: CredentialSummary): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of provider.fields) {
    if (field.kind === "secret") out[field.key] = "";
    else out[field.key] = credential ? (credential.fields[field.key] ?? "") : (field.defaultValue ?? "");
  }
  return out;
}

/**
 * Create / edit dialog. Create starts with a searchable provider picker unless a provider was
 * chosen already; edit keeps the provider fixed and leaves secrets blank (blank = keep).
 */
export function CredentialFormDialog({
  state,
  onClose,
  onSaved,
}: {
  state: CredentialDialogState | null;
  onClose: () => void;
  onSaved: (credential: CredentialSummary) => void;
}) {
  // Keep the last state through the close animation; a new opening gets a fresh form (new key).
  const [session, setSession] = useState<{ state: CredentialDialogState | null; n: number }>({ state, n: 0 });
  if (state && state !== session.state) setSession({ state, n: session.n + 1 });
  const shown = state ?? session.state;
  // A save in flight must finish before the dialog can be dismissed.
  const locked = useRef(false);

  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => !open && !locked.current && onClose()}>
      <DialogContent
        className={cn(
          "flex max-h-[min(92dvh,52rem)] flex-col gap-0 p-0 sm:max-w-xl",
          // Phones: a full-width sheet docked to the bottom.
          "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none",
        )}
      >
        {shown && (
          <CredentialFormBody
            key={session.n}
            state={shown}
            onClose={onClose}
            onSaved={onSaved}
            onLock={(value) => {
              locked.current = value;
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CredentialFormBody({
  state,
  onClose,
  onSaved,
  onLock,
}: {
  state: CredentialDialogState;
  onClose: () => void;
  onSaved: (credential: CredentialSummary) => void;
  onLock: (locked: boolean) => void;
}) {
  const editing = state.mode === "edit" ? state.credential : null;
  const initialProvider = editing
    ? getCredentialProvider(editing.providerId)
    : state.mode === "create" && state.providerId
      ? getCredentialProvider(state.providerId)
      : undefined;

  const formId = useId();
  const [provider, setProvider] = useState<CredentialProvider | undefined>(initialProvider);
  const [name, setName] = useState(editing?.name ?? initialProvider?.name ?? "");
  const [fields, setFields] = useState<Record<string, string>>(() =>
    initialProvider ? initialFields(initialProvider, editing ?? undefined) : {},
  );
  const [expiresAt, setExpiresAt] = useState(dateInputValue(editing?.expiresAt ?? null));
  const [autoCheck, setAutoCheck] = useState(editing?.autoCheck ?? true);
  /** Optional secrets to remove on save (edit only). */
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [testResult, setTestResult] = useState<TestBanner | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const existingSecrets = useMemo(
    () => (editing ? editing.secretsSet.filter((key) => !cleared.has(key)) : []),
    [editing, cleared],
  );
  const errors = provider
    ? validateCredentialInput({ name, fields, expiresAt: expiresAt || null }, provider, { existingSecrets })
    : {};
  const visibleError = (key: string) => (submitted || touched.has(key) ? errors[key] : undefined);

  const inputId = (key: string) =>
    key === "name" || key === "expiresAt" ? `${formId}-${key}` : `${formId}-f-${key}`;

  function pickProvider(next: CredentialProvider) {
    setProvider(next);
    setName(next.name);
    setFields(initialFields(next));
    setTouched(new Set());
    setSubmitted(false);
    setTestResult(null);
    setFormError(null);
    setShowConfig(false);
  }

  function touch(key: string) {
    setTouched((s) => (s.has(key) ? s : new Set(s).add(key)));
  }

  function setField(key: string, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
    setTestResult(null);
  }

  /** Marks the form submitted and focuses the first invalid input; true when valid. */
  function validate(): boolean {
    setSubmitted(true);
    if (!provider) return false;
    const order = ["name", ...provider.fields.map((f) => f.key), "expiresAt"];
    const first = order.find((key) => errors[key]);
    if (!first) return true;
    document.getElementById(inputId(first))?.focus();
    return false;
  }

  /** Full input from the form; blank values are omitted (a blank secret on edit keeps the stored one). */
  function buildInput(p: CredentialProvider): CredentialInput {
    const values: Record<string, string> = {};
    for (const field of p.fields) {
      const value = (fields[field.key] ?? "").trim();
      if (value) values[field.key] = value;
    }
    return { providerId: p.id, name: name.trim(), fields: values, expiresAt: isoFromDateInput(expiresAt), autoCheck };
  }

  /** Only what changed; blank secrets are left out so the stored values stay. */
  function buildUpdate(p: CredentialProvider, credential: CredentialSummary): CredentialUpdate {
    const update: CredentialUpdate = {};
    if (name.trim() !== credential.name) update.name = name.trim();
    const changed: Record<string, string> = {};
    for (const field of p.fields) {
      const value = (fields[field.key] ?? "").trim();
      if (field.kind === "secret") {
        if (value && !cleared.has(field.key)) changed[field.key] = value;
      } else if (value !== (credential.fields[field.key] ?? "")) {
        changed[field.key] = value;
      }
    }
    if (Object.keys(changed).length > 0) update.fields = changed;
    if (cleared.size > 0) update.clear = [...cleared];
    if (expiresAt !== dateInputValue(credential.expiresAt)) update.expiresAt = isoFromDateInput(expiresAt);
    if (autoCheck !== credential.autoCheck) update.autoCheck = autoCheck;
    return update;
  }

  async function testConnection() {
    if (!provider || busy || !validate()) return;
    setBusy("test");
    setTestResult(null);
    try {
      const result = await api.credentials.test(buildInput(provider), editing?.id);
      setTestResult({ ok: result.ok, message: result.message, latencyMs: result.latencyMs });
    } catch (err) {
      setTestResult({ ok: false, message: errorText(err, "Could not run the test") });
    } finally {
      setBusy(null);
    }
  }

  async function save(event?: React.FormEvent) {
    event?.preventDefault();
    if (!provider || busy || !validate()) return;
    setBusy("save");
    onLock(true);
    setFormError(null);
    try {
      // `test: true` runs the health check on save, so the row starts with a fresh status.
      const saved = editing
        ? await api.credentials.update(editing.id, buildUpdate(provider, editing), true)
        : await api.credentials.create(buildInput(provider), true);
      if (saved.health === "failing") {
        toast.warning(`Saved ${saved.name}, but its check failed`, { description: saved.lastMessage ?? undefined });
      } else {
        toast.success(`${editing ? "Saved" : "Added"} ${saved.name}`, {
          description: saved.lastMessage ?? undefined,
        });
      }
      onLock(false);
      onSaved(saved);
    } catch (err) {
      // The API's 400 carries a field map too, but the client only exposes the message.
      setFormError(errorText(err, "Could not save the credential"));
      onLock(false);
    } finally {
      setBusy(null);
    }
  }

  if (!provider && editing) {
    return (
      <>
        <DialogHeader className="px-5 pt-5 pr-12 pb-4">
          <DialogTitle>Edit {editing.name}</DialogTitle>
          <DialogDescription>
            Its provider ({editing.providerId}) is not known to this version of AgentMan, so it cannot be edited here.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="m-0 border-t px-5 py-3 max-sm:rounded-b-none">
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (!provider) {
    return (
      <>
        <DialogHeader className="border-b px-5 pt-5 pr-12 pb-4">
          <DialogTitle>Add credential</DialogTitle>
          <DialogDescription>Pick the service or MCP server the key is for.</DialogDescription>
        </DialogHeader>
        <ProviderPicker onPick={pickProvider} />
        <DialogFooter className="m-0 border-t px-5 py-3 max-sm:rounded-b-none">
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </>
    );
  }

  const snippetValues: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = (fields[field.key] ?? "").trim();
    // Secret values are never inlined by `mcpConfigSnippet`; a marker is enough to include their placeholder.
    if (field.kind === "secret") {
      if (value || existingSecrets.includes(field.key)) snippetValues[field.key] = "set";
    } else if (value) {
      snippetValues[field.key] = value;
    }
  }
  const snippet = mcpConfigSnippet(provider, snippetValues);
  const disabled = busy === "save";

  return (
    <>
      <DialogHeader className="border-b px-5 pt-5 pr-12 pb-4">
        <div className="flex items-center gap-3">
          {!editing && (
            <Button
              variant="ghost"
              size="icon"
              className="-ml-2 size-11 shrink-0 md:size-8"
              aria-label="Back to all providers"
              disabled={disabled}
              onClick={() => setProvider(undefined)}
            >
              <ChevronLeftIcon />
            </Button>
          )}
          <ProviderTile provider={provider} />
          <div className="min-w-0 space-y-1">
            <DialogTitle className="truncate">{editing ? `Edit ${editing.name}` : `Add ${provider.name}`}</DialogTitle>
            <DialogDescription className="line-clamp-2">{provider.description}</DialogDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <a
            href={provider.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1 text-muted-foreground underline-offset-3 hover:text-foreground hover:underline md:min-h-0"
          >
            Docs
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </a>
          {provider.keyUrl && (
            <a
              href={provider.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-1 font-medium text-primary underline-offset-3 hover:underline md:min-h-0"
            >
              Get a key
              <ExternalLinkIcon className="size-3" aria-hidden="true" />
            </a>
          )}
          <span className="min-w-0 truncate text-muted-foreground" title={provider.healthCheck}>
            Check: <span className="font-mono">{provider.healthCheck}</span>
          </span>
        </div>
      </DialogHeader>

      <form
        id={formId}
        noValidate
        onSubmit={(event) => void save(event)}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4"
      >
        <FieldShell id={inputId("name")} label="Name" error={visibleError("name")}>
          <Input
            id={inputId("name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => touch("name")}
            maxLength={120}
            autoComplete="off"
            className="h-11 md:h-9"
            disabled={disabled}
            aria-invalid={Boolean(visibleError("name"))}
            aria-describedby={visibleError("name") ? `${inputId("name")}-error` : undefined}
          />
        </FieldShell>

        {provider.fields.map((field) => (
          <CredentialFieldInput
            key={field.key}
            id={inputId(field.key)}
            field={field}
            value={fields[field.key] ?? ""}
            error={visibleError(field.key)}
            disabled={disabled}
            saved={editing?.secretsSet.includes(field.key) ? editing.fields[field.key] || FULL_MASK : undefined}
            removed={cleared.has(field.key)}
            onToggleRemove={() => {
              setCleared((s) => {
                const next = new Set(s);
                if (!next.delete(field.key)) next.add(field.key);
                return next;
              });
              setField(field.key, "");
            }}
            onChange={(value) => setField(field.key, value)}
            onBlur={() => touch(field.key)}
          />
        ))}

        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell
            id={inputId("expiresAt")}
            label="Expires"
            optional
            help="You get a notification a week before."
            error={visibleError("expiresAt")}
          >
            <Input
              id={inputId("expiresAt")}
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              onBlur={() => touch("expiresAt")}
              className="h-11 md:h-9"
              disabled={disabled}
              aria-invalid={Boolean(visibleError("expiresAt"))}
              aria-describedby={describedBy(inputId("expiresAt"), true, Boolean(visibleError("expiresAt")))}
            />
          </FieldShell>
          <div className="flex min-h-11 items-start gap-3 sm:pt-6">
            <Switch
              id={`${formId}-autoCheck`}
              checked={autoCheck}
              onCheckedChange={setAutoCheck}
              disabled={disabled}
              className="mt-0.5"
              aria-describedby={`${formId}-autoCheck-help`}
            />
            <div className="space-y-1">
              <Label htmlFor={`${formId}-autoCheck`}>Check in the background</Label>
              <p id={`${formId}-autoCheck-help`} className="text-xs text-muted-foreground">
                Every 10 min; failures raise a notification.
              </p>
            </div>
          </div>
        </div>

        {snippet && (
          <div className="rounded-xl ring-1 ring-foreground/10">
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-9"
              aria-expanded={showConfig}
              aria-controls={`${formId}-mcp`}
              onClick={() => setShowConfig((v) => !v)}
            >
              <PlugZapIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1">MCP server config</span>
              <ChevronDownIcon
                className={cn("size-4 text-muted-foreground transition-transform", showConfig && "rotate-180")}
                aria-hidden="true"
              />
            </button>
            {showConfig && (
              <div id={`${formId}-mcp`} className="relative border-t">
                <pre className="scrollbar-subtle max-h-64 overflow-auto p-3 pr-14 font-mono text-xs leading-relaxed">
                  {snippet}
                </pre>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-1.5 right-1.5 size-11 md:size-8"
                  aria-label="Copy MCP config"
                  onClick={() =>
                    void copyText(snippet).then(
                      () => toast.success("MCP config copied"),
                      () => toast.error("Could not copy"),
                    )
                  }
                >
                  <CopyIcon />
                </Button>
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                  Secrets stay out of the snippet as <code className="font-mono">{"${ENV_VAR}"}</code> placeholders;
                  set them where the MCP server runs.
                </p>
              </div>
            )}
          </div>
        )}

        {testResult && (
          <div
            role="status"
            className={cn(
              "flex items-start gap-2 rounded-lg p-3 text-sm",
              testResult.ok
                ? "bg-success/10 text-success"
                : "bg-destructive/10 text-destructive dark:bg-destructive/20",
            )}
          >
            {testResult.ok ? (
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            ) : (
              <XCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            )}
            <p className="min-w-0 flex-1 break-words">
              <span className="font-medium">{testResult.ok ? "Connected" : "Failed"}:</span> {testResult.message}
              {testResult.latencyMs != null && (
                <span className="opacity-70"> · {formatLatency(testResult.latencyMs)}</span>
              )}
            </p>
          </div>
        )}

        {formError && (
          <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm whitespace-pre-wrap text-destructive">
            {formError}
          </p>
        )}
      </form>

      <DialogFooter className="m-0 border-t px-5 py-3 max-sm:rounded-b-none">
        <Button variant="outline" className="h-11 md:h-9" onClick={onClose} disabled={disabled}>
          Cancel
        </Button>
        <Button
          variant="outline"
          className="h-11 gap-1.5 md:h-9"
          onClick={() => void testConnection()}
          disabled={Boolean(busy)}
        >
          {busy === "test" ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <PlugZapIcon />}
          {busy === "test" ? "Testing…" : "Test connection"}
        </Button>
        <Button type="submit" form={formId} className="h-11 gap-1.5 md:h-9" disabled={Boolean(busy)}>
          {busy === "save" && <Loader2Icon className="animate-spin motion-reduce:animate-none" />}
          {busy === "save" ? "Saving…" : editing ? "Save" : "Add credential"}
        </Button>
      </DialogFooter>
    </>
  );
}

function describedBy(id: string, help: boolean, error: boolean): string | undefined {
  const ids = [help && `${id}-help`, error && `${id}-error`].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

/** Label row (with optional env var), the control, then help and error text wired to `id`. */
function FieldShell({
  id,
  label,
  optional = false,
  envVar,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  envVar?: string;
  help?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label htmlFor={id}>
          {label}
          {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
        </Label>
        {envVar && (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground">{envVar}</code>
        )}
      </div>
      {children}
      {help && (
        <p id={`${id}-help`} className="text-xs text-pretty text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function CredentialFieldInput({
  id,
  field,
  value,
  error,
  disabled,
  saved,
  removed,
  onToggleRemove,
  onChange,
  onBlur,
}: {
  id: string;
  field: CredentialField;
  value: string;
  error?: string;
  disabled: boolean;
  /** Masked stored value when editing a secret that is set. */
  saved?: string;
  /** Optional secret marked for removal. */
  removed: boolean;
  onToggleRemove: () => void;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const aria = {
    "aria-invalid": Boolean(error),
    "aria-describedby": describedBy(id, Boolean(field.help), Boolean(error)),
  };

  let control: React.ReactNode;
  if (field.kind === "secret") {
    control = (
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <PasswordInput
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            placeholder={removed ? "Removed on save" : saved ? keepPlaceholder(saved) : field.placeholder}
            autoComplete="off"
            className="font-mono"
            disabled={disabled || removed}
            {...aria}
          />
        </div>
        {saved && !field.required && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 shrink-0 md:h-9"
            disabled={disabled}
            aria-pressed={removed}
            onClick={onToggleRemove}
          >
            {removed ? "Keep" : "Remove"}
          </Button>
        )}
      </div>
    );
  } else if (field.kind === "select") {
    control = (
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="h-11! w-full md:h-9!" {...aria}>
          <SelectValue placeholder={field.placeholder ?? "Choose…"} />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else {
    control = (
      <Input
        id={id}
        type={field.kind === "url" ? "url" : "text"}
        inputMode={field.kind === "url" ? "url" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={field.placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn("h-11 md:h-9", field.kind === "url" && "font-mono text-sm")}
        disabled={disabled}
        {...aria}
      />
    );
  }

  return (
    <FieldShell
      id={id}
      label={field.label}
      optional={!field.required}
      envVar={field.envVar}
      help={field.help}
      error={error}
    >
      {control}
    </FieldShell>
  );
}

/** Step 1 of create: every provider, grouped by category, filtered as you type. */
function ProviderPicker({ onPick }: { onPick: (provider: CredentialProvider) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = CREDENTIAL_PROVIDERS.filter(
    (p) =>
      !q ||
      [p.name, p.id, p.description, CREDENTIAL_CATEGORY_LABELS[p.category]].some((text) =>
        text.toLowerCase().includes(q),
      ),
  );
  const groups = (Object.keys(CREDENTIAL_CATEGORY_LABELS) as CredentialCategory[])
    .map((category) => ({ category, providers: matches.filter((p) => p.category === category) }))
    .filter((group) => group.providers.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-5 pt-4 pb-2">
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) {
                e.preventDefault();
                onPick(matches[0]);
              }
            }}
            placeholder="Search GitHub, OpenAI, AWS…"
            aria-label="Search providers"
            className="h-11 pl-9 md:h-9"
            autoFocus
          />
        </div>
      </div>
      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {groups.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No provider matches. Try <span className="font-medium">Custom</span> for any MCP server or API.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.category} className="pt-3" aria-labelledby={`provider-group-${group.category}`}>
            <h3
              id={`provider-group-${group.category}`}
              className="pb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"
            >
              {CREDENTIAL_CATEGORY_LABELS[group.category]}
            </h3>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {group.providers.map((provider) => (
                <li key={provider.id}>
                  <button
                    type="button"
                    onClick={() => onPick(provider)}
                    className="flex min-h-14 w-full items-center gap-3 rounded-xl p-2.5 text-left ring-1 ring-foreground/10 transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.99]"
                  >
                    <ProviderTile provider={provider} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{provider.name}</span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">{provider.description}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
