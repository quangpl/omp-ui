"use client";

// Connect dialog of the /mcp page: one form that reuses a saved credential or saves a new one for
// a catalog server, then connects it (POST /mcp writes the server into omp's mcp.json and probes
// it). Phones get a full-width bottom sheet with 44px controls, a scrolling body and a sticky footer.

import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronDownIcon, ExternalLinkIcon, Loader2Icon, ServerIcon } from "lucide-react";
import { toast } from "sonner";
import { errorText } from "@/components/credentials/utils";
import { HealthBadge, healthTone } from "@/components/credentials/health-badge";
import { ProviderTile } from "@/components/credentials/provider-tile";
import { PasswordInput } from "@/components/password-input";
import { Badge } from "@/components/ui/badge";
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
import { api } from "@/lib/api-client";
import { getCredentialProvider, validateCredentialInput } from "@/lib/credential-providers";
import type { CredentialField, CredentialProvider, CredentialSummary } from "@/lib/credential-types";
import {
  MCP_SERVER_NAME_PATTERN,
  mcpToolName,
  type McpCatalogEntry,
  type McpConnectInput,
  type McpServerSummary,
} from "@/lib/mcp-types";
import { cn } from "@/lib/utils";

const SERVER_NAME_RE = new RegExp(MCP_SERVER_NAME_PATTERN);

/** Error keys that are not provider fields: credential name, server name, saved credential. */
const META_KEYS: Record<string, true> = { name: true, serverName: true, credential: true };

const FOOTER_CLASS =
  "m-0 shrink-0 px-5 py-3 max-md:mb-0 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]";

type CredentialSource = "saved" | "new";

/** The provider id, or `<id>-2`, `<id>-3`, …: the first one not in `taken`. */
function defaultServerName(id: string, taken: readonly string[]): string {
  if (!taken.includes(id)) return id;
  let n = 2;
  while (taken.includes(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

function serverNameError(name: string, taken: readonly string[]): string | undefined {
  if (!name) return "Server name is required";
  if (!SERVER_NAME_RE.test(name)) {
    return "Use lowercase letters, digits, - and _ (up to 48), starting with a letter or digit";
  }
  if (taken.includes(name)) return `${name} is already in mcp.json`;
  return undefined;
}

function initialFields(provider: CredentialProvider): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of provider.fields) out[field.key] = field.kind === "secret" ? "" : (field.defaultValue ?? "");
  return out;
}

/** Toast for a freshly connected server, by the status its first check left it in. */
function announceConnected(provider: CredentialProvider, server: McpServerSummary): void {
  if (server.status === "connected") {
    const count = server.probe?.tools.length;
    toast.success(
      count == null
        ? `${provider.name} connected`
        : `${provider.name} connected · ${count} tool${count === 1 ? "" : "s"}`,
    );
  } else if (server.status === "untested") {
    toast.info(`${provider.name} added`, { description: "Not checked yet." });
  } else {
    toast.warning(`Saved ${provider.name}, but the check failed`, {
      description: server.statusMessage ?? undefined,
    });
  }
}

function describedBy(id: string, help: boolean, error: boolean): string | undefined {
  const ids = [help && `${id}-help`, error && `${id}-error`].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

/**
 * Connect a catalog server; open while `entry` is non-null. `credentials` is every saved
 * credential (filtered to the entry's provider here), `takenNames` every server name in mcp.json.
 */
export function McpConnectDialog({
  entry,
  onOpenChange,
  credentials,
  takenNames,
  onConnected,
}: {
  entry: McpCatalogEntry | null;
  onOpenChange: (open: boolean) => void;
  credentials: CredentialSummary[];
  takenNames: string[];
  onConnected: (server: McpServerSummary) => void;
}) {
  // Keep the last entry through the close animation; every opening gets a fresh form (new key).
  const [session, setSession] = useState({ entry, shown: entry, n: 0 });
  if (entry !== session.entry) {
    setSession({ entry, shown: entry ?? session.shown, n: entry ? session.n + 1 : session.n });
  }
  const shown = entry ?? session.shown;
  const provider = shown ? getCredentialProvider(shown.providerId) : undefined;
  // A connect in flight must finish before the dialog can be dismissed (overlay, Escape, close button).
  const locked = useRef(false);
  const close = () => onOpenChange(false);

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && !locked.current && close()}>
      <DialogContent
        className="flex max-h-[min(92dvh,52rem)] flex-col gap-0 p-0 sm:max-w-xl max-md:overflow-hidden max-md:pb-0"
        onOpenAutoFocus={(event) => {
          // Focus the form's first input rather than the header links.
          const target = (event.target as HTMLElement).querySelector<HTMLElement>("[data-autofocus]");
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {shown && provider?.mcp ? (
          <ConnectForm
            key={session.n}
            entry={shown}
            provider={provider}
            credentials={credentials}
            takenNames={takenNames}
            onClose={close}
            onConnected={onConnected}
            onLock={(value) => {
              locked.current = value;
            }}
          />
        ) : (
          shown && (
            <>
              <DialogHeader className="px-5 pt-5 pr-12 pb-4 max-md:pr-14">
                <DialogTitle>Connect {shown.providerId}</DialogTitle>
                <DialogDescription>
                  This version of AgentMan has no MCP server template for {shown.providerId}.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className={FOOTER_CLASS}>
                <Button variant="outline" className="pressable h-11 md:h-9" onClick={close}>
                  Close
                </Button>
              </DialogFooter>
            </>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectForm({
  entry,
  provider,
  credentials,
  takenNames,
  onClose,
  onConnected,
  onLock,
}: {
  entry: McpCatalogEntry;
  provider: CredentialProvider;
  credentials: CredentialSummary[];
  takenNames: string[];
  onClose: () => void;
  onConnected: (server: McpServerSummary) => void;
  onLock: (locked: boolean) => void;
}) {
  const formId = useId();
  const saved = credentials.filter((credential) => credential.providerId === entry.providerId);
  const [source, setSource] = useState<CredentialSource>(() =>
    saved.some((credential) => credential.health !== "failing") ? "saved" : "new",
  );
  const [credentialId, setCredentialId] = useState(
    () => (saved.find((credential) => credential.health === "healthy") ?? saved[0])?.id ?? "",
  );
  const [fields, setFields] = useState(() => initialFields(provider));
  const [credentialName, setCredentialName] = useState(provider.name);
  const [serverName, setServerName] = useState(() => defaultServerName(provider.id, takenNames));
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const useSaved = source === "saved" && saved.length > 0;
  const selected = saved.find((credential) => credential.id === credentialId);
  const requiredFields = provider.fields.filter((field) => field.required);
  const optionalFields = provider.fields.filter((field) => !field.required);

  const errors: Record<string, string> = useSaved
    ? {}
    : validateCredentialInput({ name: credentialName, fields }, provider);
  if (useSaved && !selected) errors.credential = "Choose a saved credential";
  const nameError = serverNameError(serverName.trim(), takenNames);
  if (nameError) errors.serverName = nameError;

  const advancedKeys = [...(useSaved ? [] : [...optionalFields.map((field) => field.key), "name"]), "serverName"];
  const order = [...(useSaved ? ["credential"] : requiredFields.map((field) => field.key)), ...advancedKeys];

  const idFor = (key: string) => (META_KEYS[key] ? `${formId}-${key}` : `${formId}-f-${key}`);
  const visibleError = (key: string) => (submitted || touched.has(key) ? errors[key] : undefined);

  function touch(key: string) {
    setTouched((s) => (s.has(key) ? s : new Set(s).add(key)));
  }

  /** Marks the form submitted and focuses the first invalid input (opening Advanced for it); true when valid. */
  function validate(): boolean {
    setSubmitted(true);
    const first = order.find((key) => errors[key]);
    if (!first) return true;
    if (!advanced && advancedKeys.includes(first)) flushSync(() => setAdvanced(true));
    document.getElementById(idFor(first))?.focus();
    return false;
  }

  function buildInput(): McpConnectInput {
    const input: McpConnectInput = { providerId: provider.id, name: serverName.trim(), test: true };
    if (useSaved) {
      input.credentialId = credentialId;
    } else {
      const values: Record<string, string> = {};
      for (const field of provider.fields) {
        const value = (fields[field.key] ?? "").trim();
        if (value) values[field.key] = value;
      }
      input.credential = { name: credentialName.trim(), fields: values };
    }
    return input;
  }

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (pending || !validate()) return;
    setPending(true);
    setFormError(null);
    onLock(true);
    try {
      const { server } = await api.mcp.connect(buildInput());
      onLock(false);
      announceConnected(provider, server);
      onConnected(server);
      onClose();
    } catch (err) {
      onLock(false);
      setFormError(errorText(err, "Could not connect the server"));
      setPending(false);
    }
  }

  const fieldControl = (field: CredentialField, autoFocus: boolean) => (
    <FieldControl
      key={field.key}
      id={idFor(field.key)}
      field={field}
      value={fields[field.key] ?? ""}
      error={visibleError(field.key)}
      disabled={pending}
      autoFocus={autoFocus}
      onChange={(value) => setFields((f) => ({ ...f, [field.key]: value }))}
      onBlur={() => touch(field.key)}
    />
  );

  const runner = provider.mcp?.transport === "stdio" ? (provider.mcp.command ?? "npx") : null;
  const pendingText = `${useSaved ? "" : "Checking the key. "}${runner ? "Starting" : "Connecting to"} the ${
    provider.name
  } MCP server and listing its tools…`;

  return (
    <>
      <DialogHeader className="shrink-0 gap-3 border-b px-5 pt-5 pr-12 pb-4 max-md:pr-14">
        <div className="flex items-center gap-3">
          <ProviderTile provider={provider} />
          <div className="min-w-0 space-y-1">
            <DialogTitle className="truncate">Connect {provider.name}</DialogTitle>
            <DialogDescription className="line-clamp-2">{provider.description}</DialogDescription>
          </div>
        </div>
        {entry.capabilities.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Capabilities">
            {entry.capabilities.map((capability) => (
              <li key={capability}>
                <Badge variant="secondary">{capability}</Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {provider.keyUrl && (
            <ExternalLink href={provider.keyUrl} className="font-medium text-primary">
              Get a key
            </ExternalLink>
          )}
          <ExternalLink href={provider.docsUrl} className="text-muted-foreground hover:text-foreground">
            Docs
          </ExternalLink>
        </div>
      </DialogHeader>

      <form
        id={formId}
        noValidate
        onSubmit={(event) => void connect(event)}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4"
      >
        {(entry.setupHint || entry.requires) && (
          <div className="space-y-1.5 text-xs text-pretty text-muted-foreground">
            {entry.setupHint && <p>{entry.setupHint}</p>}
            {entry.requires && (
              <p className="flex items-start gap-1.5">
                <ServerIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                Runs on the AgentMan server with {entry.requires}.
              </p>
            )}
          </div>
        )}

        {saved.length > 0 && (
          <fieldset className="grid gap-2 sm:grid-cols-2" disabled={pending}>
            <legend className="sr-only">Credential</legend>
            {(["saved", "new"] as const).map((value) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-sm ring-1 ring-foreground/10 transition-colors hover:bg-muted/50 has-checked:bg-primary/5 has-checked:ring-primary/60 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 md:min-h-9"
              >
                <input
                  type="radio"
                  name={`${formId}-source`}
                  value={value}
                  checked={source === value}
                  onChange={() => {
                    setSource(value);
                    setFormError(null);
                  }}
                  className="size-4 accent-primary"
                />
                {value === "saved" ? "Use a saved credential" : "Enter a new key"}
              </label>
            ))}
          </fieldset>
        )}

        {useSaved ? (
          <FieldShell id={idFor("credential")} label="Saved credential" error={visibleError("credential")}>
            <Select
              value={credentialId}
              onValueChange={(value) => {
                setCredentialId(value);
                touch("credential");
              }}
              disabled={pending}
            >
              <SelectTrigger
                id={idFor("credential")}
                data-autofocus=""
                className="h-11! w-full md:h-9!"
                aria-invalid={Boolean(visibleError("credential"))}
                aria-describedby={describedBy(idFor("credential"), false, Boolean(visibleError("credential")))}
              >
                <SelectValue placeholder="Choose a credential" />
              </SelectTrigger>
              <SelectContent>
                {saved.map((credential) => (
                  <SelectItem key={credential.id} value={credential.id} className="min-h-11 md:min-h-8">
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", healthTone(credential.health).dot)}
                      aria-hidden="true"
                    />
                    <span className="truncate">{credential.name}</span>
                    <span className="text-muted-foreground">· {healthTone(credential.health).label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && (
              <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <HealthBadge
                  health={selected.health}
                  lastCheckedAt={selected.lastCheckedAt}
                  lastMessage={selected.lastMessage}
                  lastLatencyMs={selected.lastLatencyMs}
                />
                {selected.lastMessage && <span className="min-w-0 truncate">{selected.lastMessage}</span>}
              </div>
            )}
          </FieldShell>
        ) : (
          requiredFields.map((field, index) => fieldControl(field, index === 0))
        )}

        <div className="rounded-xl ring-1 ring-foreground/10">
          <button
            type="button"
            className="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted/70 md:min-h-9"
            aria-expanded={advanced}
            aria-controls={`${formId}-advanced`}
            onClick={() => setAdvanced((v) => !v)}
          >
            <span>Advanced</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-normal text-muted-foreground">
              {serverName.trim()}
            </span>
            <ChevronDownIcon
              className={cn("size-4 shrink-0 text-muted-foreground transition-transform", advanced && "rotate-180")}
              aria-hidden="true"
            />
          </button>
          {advanced && (
            <div id={`${formId}-advanced`} className="space-y-4 border-t p-3">
              {!useSaved && optionalFields.map((field) => fieldControl(field, false))}
              {!useSaved && (
                <FieldShell
                  id={idFor("name")}
                  label="Credential name"
                  help="How the saved key is listed on the Credentials page."
                  error={visibleError("name")}
                >
                  <Input
                    id={idFor("name")}
                    value={credentialName}
                    onChange={(e) => setCredentialName(e.target.value)}
                    onBlur={() => touch("name")}
                    maxLength={120}
                    autoComplete="off"
                    className="h-11 md:h-9"
                    disabled={pending}
                    aria-invalid={Boolean(visibleError("name"))}
                    aria-describedby={describedBy(idFor("name"), true, Boolean(visibleError("name")))}
                  />
                </FieldShell>
              )}
              <FieldShell
                id={idFor("serverName")}
                label="Server name"
                help={`Key in mcp.json; agents see its tools as ${serverName.trim() ? mcpToolName(serverName.trim(), "<tool>") : "mcp__<name>_<tool>"}.`}
                error={visibleError("serverName")}
              >
                <Input
                  id={idFor("serverName")}
                  value={serverName}
                  onChange={(e) => setServerName(e.target.value)}
                  onBlur={() => touch("serverName")}
                  maxLength={48}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="h-11 font-mono md:h-9"
                  disabled={pending}
                  aria-invalid={Boolean(visibleError("serverName"))}
                  aria-describedby={describedBy(idFor("serverName"), true, Boolean(visibleError("serverName")))}
                />
              </FieldShell>
            </div>
          )}
        </div>

        {pending && (
          <div role="status" className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-sm">
            <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-pretty">
              {pendingText}
              {runner && (
                <span className="text-muted-foreground">
                  {" "}
                  The first start can take up to a minute while {runner} downloads the server.
                </span>
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

      <DialogFooter className={FOOTER_CLASS}>
        <Button variant="outline" className="pressable h-11 md:h-9" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" form={formId} className="pressable h-11 gap-1.5 md:h-9" disabled={pending}>
          {pending && <Loader2Icon className="animate-spin motion-reduce:animate-none" />}
          {pending ? "Connecting…" : "Connect"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Header link that opens in a new tab; 44px tall on phones. */
function ExternalLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex min-h-11 items-center gap-1 underline-offset-3 hover:underline md:min-h-0",
        className,
      )}
    >
      {children}
      <ExternalLinkIcon className="size-3" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** Label, the control, then help and error text wired to `id`. */
function FieldShell({
  id,
  label,
  optional = false,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  help?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {label}
        {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
      </Label>
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

/** One provider field: secret → PasswordInput, select → Select, url/text → Input. */
function FieldControl({
  id,
  field,
  value,
  error,
  disabled,
  autoFocus,
  onChange,
  onBlur,
}: {
  id: string;
  field: CredentialField;
  value: string;
  error?: string;
  disabled: boolean;
  /** Focused when the dialog opens. */
  autoFocus: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const props = {
    id,
    disabled,
    "data-autofocus": autoFocus ? "" : undefined,
    "aria-invalid": Boolean(error),
    "aria-describedby": describedBy(id, Boolean(field.help), Boolean(error)),
  };

  let control: React.ReactNode;
  if (field.kind === "secret") {
    control = (
      <PasswordInput
        {...props}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={field.placeholder}
        autoComplete="off"
        className="font-mono"
      />
    );
  } else if (field.kind === "select") {
    control = (
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger {...props} className="h-11! w-full md:h-9!">
          <SelectValue placeholder={field.placeholder ?? "Choose…"} />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value} className="min-h-11 md:min-h-8">
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else {
    control = (
      <Input
        {...props}
        type={field.kind === "url" ? "url" : "text"}
        inputMode={field.kind === "url" ? "url" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={field.placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn("h-11 md:h-9", field.kind === "url" && "font-mono")}
      />
    );
  }

  return (
    <FieldShell id={id} label={field.label} optional={!field.required} help={field.help} error={error}>
      {control}
    </FieldShell>
  );
}
