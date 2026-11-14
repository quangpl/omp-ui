"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  BrainCircuitIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleQuestionMarkIcon,
  ExternalLinkIcon,
  FlaskConicalIcon,
  KeyRoundIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { formatLatency } from "@/components/credentials/health-badge";
import { ProviderTile } from "@/components/credentials/provider-tile";
import { PasswordInput } from "@/components/password-input";
import { SettingsField, SettingsGroup, SettingsPanel, SettingsSection } from "@/components/settings/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AI_PROVIDERS,
  aiFieldError,
  type AiAuthMethod,
  type AiOtherProvider,
  type AiProviderDefinition,
  type AiProviderField,
  type AiProviderModel,
  type AiProvidersResponse,
  type AiProviderState,
  type AiProviderStatus,
  type AiProviderTestResult,
} from "@/lib/ai-providers";
import { ApiRequestError, api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Fired on `window` after AI provider credentials were saved, removed or tested: the server has
 * refreshed omp's model list, so model pickers (Settings → OMP) should re-read it.
 */
export const AI_PROVIDERS_CHANGED_EVENT = "omp-ui:ai-providers-changed";

const FIELD = "h-11 md:h-9";
/** Model badges shown before "Show all". */
const MODELS_PREVIEW = 12;
/** Above this many models the list gets a text filter (OpenRouter lists hundreds). */
const MODELS_FILTER_MIN = 24;
const LINK =
  "inline-flex min-h-11 items-center gap-1 rounded-sm text-xs font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-0 [&_svg]:size-3";

const STATUS: Record<AiProviderStatus, { label: string; className: string; Icon: LucideIcon }> = {
  authenticated: { label: "Authenticated", className: "bg-success/15 text-success", Icon: CheckIcon },
  unverified: {
    label: "Unverified",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    Icon: CircleQuestionMarkIcon,
  },
  error: { label: "Error", className: "bg-destructive/10 text-destructive dark:bg-destructive/20", Icon: XIcon },
  "not-configured": { label: "Not configured", className: "bg-muted text-muted-foreground", Icon: CircleDashedIcon },
};

const STATUS_TEXT: Record<AiProviderStatus, string> = {
  authenticated: "text-muted-foreground",
  unverified: "text-amber-700 dark:text-amber-300",
  error: "text-destructive",
  "not-configured": "text-muted-foreground",
};

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function notifyChanged() {
  window.dispatchEvent(new Event(AI_PROVIDERS_CHANGED_EVENT));
}

interface GroupField {
  field: AiProviderField;
  optional: boolean;
}

/** Form fields grouped by auth method: one input per env var, each in the first method that needs it. */
interface FieldGroup {
  key: string;
  method: AiAuthMethod | null;
  title: string;
  description: string;
  fields: GroupField[];
}

function fieldGroups(provider: AiProviderDefinition): FieldGroup[] {
  const groups: FieldGroup[] = provider.methods.map((method) => {
    const anyOf = method.anyOf?.map((envVar) => provider.fields.find((f) => f.envVar === envVar)?.label ?? envVar);
    return {
      key: method.id,
      method,
      title: method.label,
      description: anyOf?.length ? `${method.description} Needs one of: ${anyOf.join(" or ")}.` : method.description,
      fields: [],
    };
  });
  const shared: GroupField[] = [];
  for (const field of provider.fields) {
    const primary = provider.methods.findIndex(
      (m) => m.required.includes(field.envVar) || !!m.anyOf?.includes(field.envVar),
    );
    if (primary >= 0) {
      groups[primary].fields.push({ field, optional: false });
      continue;
    }
    const optionalIn = provider.methods.flatMap((m, i) => (m.optional?.includes(field.envVar) ? [i] : []));
    if (optionalIn.length === 1) groups[optionalIn[0]].fields.push({ field, optional: true });
    else shared.push({ field, optional: true });
  }
  const out = groups.filter((g) => g.fields.length > 0);
  if (shared.length > 0) {
    out.push({
      key: "shared",
      method: null,
      title: provider.methods.length > 1 ? "All methods" : "Other settings",
      description: provider.methods.length > 1 ? "Used with any of the methods above." : "Optional.",
      fields: shared,
    });
  }
  return out;
}

/** Where the provider's credentials come from, for the row's one-line hints. */
function sourceHints(state: AiProviderState): { text: string; warn?: boolean }[] {
  const fields = Object.values(state.fields);
  const hints: { text: string; warn?: boolean }[] = [];
  if (fields.some((f) => f.broken)) hints.push({ text: "A saved value can't be decrypted", warn: true });
  if (fields.some((f) => f.source === "settings" && !f.broken)) hints.push({ text: "Saved in Settings" });
  if (fields.some((f) => f.overridesEnvironment)) hints.push({ text: "Overrides server environment" });
  else if (fields.some((f) => f.source === "environment")) hints.push({ text: "Server environment" });
  if (state.ompSignIn) {
    hints.push({
      text: state.ompSignIn.account ? `Signed in through omp · ${state.ompSignIn.account}` : "Signed in through omp",
    });
  }
  return hints;
}

function StatusBadge({ status }: { status: AiProviderStatus }) {
  const { label, className, Icon } = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium [&_svg]:size-3.5",
        className,
      )}
    >
      <Icon aria-hidden="true" />
      {label}
    </span>
  );
}

/** Settings → AI Providers: API keys for the model providers omp runs agents on. */
export function AiProvidersSettingsSection() {
  const [data, setData] = useState<AiProvidersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await api.aiProviders.list(refresh));
    } catch (err) {
      setLoadError(message(err, "Could not load AI providers."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceProvider = useCallback((provider: AiProviderState) => {
    setData((prev) =>
      prev ? { ...prev, providers: prev.providers.map((p) => (p.id === provider.id ? provider : p)) } : prev,
    );
  }, []);

  const description = (
    <>
      Keys for the model providers omp runs agents on. Saved values are encrypted with the credentials key,
      override the same variables in the server&apos;s environment, and apply to the next agent run without a
      restart.
    </>
  );
  const refreshButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => void load(true)}
      disabled={loading}
      aria-label="Refresh AI providers and models"
      title="Refresh"
      className="pressable-icon size-11 md:size-8"
    >
      <RefreshCwIcon className={cn(loading && "animate-spin")} />
    </Button>
  );

  const rows = data
    ? AI_PROVIDERS.flatMap((provider) => {
        const state = data.providers.find((p) => p.id === provider.id);
        return state ? [{ provider, state }] : [];
      })
    : [];
  const authenticated = rows.filter((r) => r.state.status === "authenticated").length;

  return (
    <SettingsSection
      id="ai-providers"
      icon={<BrainCircuitIcon />}
      title="AI Providers"
      description={description}
      action={refreshButton}
    >
      {loadError && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Could not load AI providers</AlertTitle>
          <AlertDescription>
            <p>{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
              className="mt-2 h-11 md:h-8"
            >
              {loading ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!data ? (
        !loadError && (
          <SettingsPanel>
            <div aria-busy="true" className="space-y-3 p-4 sm:p-5">
              <Skeleton className="h-4 w-48" />
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
          </SettingsPanel>
        )
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            <span className="font-medium text-foreground tabular-nums">{authenticated}</span> of{" "}
            <span className="tabular-nums">{AI_PROVIDERS.length}</span> providers authenticated
          </p>
          {data.modelsError && (
            <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
              <TriangleAlertIcon />
              <AlertTitle>omp&apos;s model list is unavailable</AlertTitle>
              <AlertDescription className="text-amber-900/85 dark:text-amber-200/85">
                {data.modelsError}
              </AlertDescription>
            </Alert>
          )}

          <SettingsPanel>
            <ul className="divide-y divide-border/70">
              {rows.map(({ provider, state }) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  state={state}
                  onResponse={setData}
                  onProvider={replaceProvider}
                />
              ))}
            </ul>
          </SettingsPanel>

          {data.other.length > 0 && <OtherProviders providers={data.other} />}

          <p className="flex gap-2 text-xs text-pretty text-muted-foreground">
            <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {data.keySource === "env" ? (
                <>
                  Saved values are encrypted with the <code className="font-mono">CREDENTIALS_KEY</code> environment
                  variable; keep it stable or saved keys must be entered again.
                </>
              ) : (
                <>
                  Saved values are encrypted with the key in <code className="font-mono">DATA_DIR/credentials.key</code>
                  ; back it up with your data or saved keys must be entered again.
                </>
              )}
            </span>
          </p>
        </>
      )}
    </SettingsSection>
  );
}

function ProviderRow({
  provider,
  state,
  onResponse,
  onProvider,
}: {
  provider: AiProviderDefinition;
  state: AiProviderState;
  onResponse: (response: AiProvidersResponse) => void;
  onProvider: (provider: AiProviderState) => void;
}) {
  const now = useNow();
  const formId = useId();
  const [open, setOpen] = useState(false);
  /** Typed values by env var; never prefilled from the server. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Field errors from a 400 response, by env var; cleared when that field is edited. */
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  /** "save", "test", or the env var whose saved value is being removed. */
  const [busy, setBusy] = useState<string | null>(null);
  /** The latest test run from this form (typed values or the current ones). */
  const [test, setTest] = useState<{ result: AiProviderTestResult; typed: boolean } | null>(null);

  const groups = fieldGroups(provider);
  const typed = Object.fromEntries(
    Object.entries(drafts)
      .map(([envVar, value]) => [envVar, value.trim()] as const)
      .filter(([, value]) => value !== ""),
  );
  const hasTyped = Object.keys(typed).length > 0;
  const errors = Object.fromEntries(
    provider.fields.map((f) => [f.envVar, serverErrors[f.envVar] ?? aiFieldError(provider, f.envVar, drafts[f.envVar] ?? "")]),
  );
  const typedValid = Object.keys(typed).every((envVar) => !errors[envVar]);
  const hasAnyValue = Object.values(state.fields).some((f) => f.source !== null);
  const canTest = hasTyped ? typedValid : hasAnyValue || !!state.ompSignIn || state.models.length > 0;
  const shownTest = test ?? (state.lastTest ? { result: state.lastTest, typed: false } : null);
  const hints = sourceHints(state);

  function edit(envVar: string, value: string) {
    setDrafts((prev) => ({ ...prev, [envVar]: value }));
    setServerErrors((prev) => {
      if (!(envVar in prev)) return prev;
      const next = { ...prev };
      delete next[envVar];
      return next;
    });
    setFormError(null);
  }

  function failed(err: unknown, fallback: string) {
    if (err instanceof ApiRequestError && Object.keys(err.fields).length > 0) {
      setServerErrors(err.fields);
      const known = Object.keys(err.fields).every((envVar) => provider.fields.some((f) => f.envVar === envVar));
      setFormError(known ? null : err.message);
    } else {
      setFormError(message(err, fallback));
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!hasTyped || !typedValid || busy) return;
    setBusy("save");
    setFormError(null);
    try {
      // Saving also tests: omp lists a provider's models for any non-empty key, so only a probe
      // tells a mistyped key from a working one.
      const res = await api.aiProviders.update({ providerId: provider.id, values: typed, test: true });
      onResponse(res);
      setDrafts({});
      setServerErrors({});
      setTest(null);
      const lastTest = res.providers.find((p) => p.id === provider.id)?.lastTest;
      if (lastTest && !lastTest.ok) {
        toast.error(`${provider.name} saved, but the test failed`, { description: lastTest.message });
      } else {
        toast.success(`${provider.name} saved`, { description: "Applies to the next agent run." });
      }
      notifyChanged();
    } catch (err) {
      failed(err, `Could not save ${provider.name}.`);
    } finally {
      setBusy(null);
    }
  }

  async function clear(field: AiProviderField) {
    if (busy) return;
    const overrode = state.fields[field.envVar]?.overridesEnvironment ?? false;
    setBusy(field.envVar);
    setFormError(null);
    try {
      const res = await api.aiProviders.update({ providerId: provider.id, clear: [field.envVar] });
      onResponse(res);
      setTest(null);
      toast.success(`${provider.name} ${field.label.toLowerCase()} removed`, {
        description: overrode ? "The server environment value applies again." : undefined,
      });
      notifyChanged();
    } catch (err) {
      failed(err, `Could not remove the saved ${field.label.toLowerCase()}.`);
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    if (!canTest || busy) return;
    setBusy("test");
    setFormError(null);
    const withTyped = hasTyped;
    try {
      const res = await api.aiProviders.test(
        withTyped ? { providerId: provider.id, values: typed } : { providerId: provider.id },
      );
      setTest({ result: res.result, typed: withTyped });
      onProvider(res.provider);
      if (res.result.ok) toast.success(`${provider.name} works`, { description: res.result.message });
      else toast.error(`${provider.name} test failed`, { description: res.result.message });
      notifyChanged();
    } catch (err) {
      failed(err, `Could not test ${provider.name}.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="min-w-0">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:p-5">
        <div className="flex min-w-0 flex-1 gap-3">
          <ProviderTile provider={provider} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="font-medium">{provider.name}</h3>
              <StatusBadge status={state.status} />
            </div>
            <p className="text-xs text-pretty text-muted-foreground">{provider.description}</p>
            {state.statusMessage && (
              <p className={cn("text-xs break-words", STATUS_TEXT[state.status])}>{state.statusMessage}</p>
            )}
            <ul className="flex flex-wrap gap-1.5 pt-0.5" aria-label="Auth methods">
              {provider.methods.map((method) => {
                const active = state.activeMethods.includes(method.id);
                return (
                  <li
                    key={method.id}
                    title={method.description}
                    className={cn(
                      "inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs ring-1 ring-inset [&_svg]:size-3",
                      active
                        ? "bg-primary/10 font-medium text-primary ring-primary/30"
                        : "text-muted-foreground ring-border",
                    )}
                  >
                    {active && <CheckIcon aria-hidden="true" />}
                    {method.label}
                    {active && <span className="sr-only">(active)</span>}
                  </li>
                );
              })}
            </ul>
            {hints.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {hints.map((hint, i) => (
                  <span key={hint.text} className={cn(hint.warn && "text-destructive")}>
                    {i > 0 && " · "}
                    {hint.text}
                  </span>
                ))}
              </p>
            )}
            {state.lastTest && (
              <p className="text-xs text-muted-foreground">
                <span className={state.lastTest.ok ? "text-success" : "text-destructive"}>
                  Last test {state.lastTest.ok ? "passed" : "failed"}
                </span>{" "}
                <time dateTime={state.lastTest.checkedAt} title={formatDateTime(state.lastTest.checkedAt)}>
                  {formatRelative(state.lastTest.checkedAt, now)}
                </time>{" "}
                · {formatLatency(state.lastTest.latencyMs)}
              </p>
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls={open ? formId : undefined}
          onClick={() => setOpen((v) => !v)}
          className="h-11 w-full shrink-0 sm:w-auto md:h-8"
        >
          {state.status === "not-configured" ? "Set up" : "Edit"}
          <span className="sr-only"> {provider.name}</span>
          <ChevronDownIcon
            aria-hidden="true"
            className={cn("transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")}
          />
        </Button>
      </div>

      {state.models.length > 0 && (
        <div className="px-4 pb-4 sm:pr-5 sm:pb-5 sm:pl-[4.5rem]">
          <ModelList models={state.models} label={`${provider.name} models`} />
        </div>
      )}

      {open && (
        <form
          id={formId}
          onSubmit={save}
          noValidate
          aria-label={`${provider.name} credentials`}
          className="animate-fade-in-soft border-t bg-muted/30"
        >
          <div className="flex flex-wrap gap-x-4 px-4 pt-3 sm:px-5">
            {provider.keyUrl && (
              <a href={provider.keyUrl} target="_blank" rel="noreferrer" className={LINK}>
                Get a key <ExternalLinkIcon aria-hidden="true" />
              </a>
            )}
            <a href={provider.docsUrl} target="_blank" rel="noreferrer" className={LINK}>
              Docs <ExternalLinkIcon aria-hidden="true" />
            </a>
          </div>

          {groups.map((group) => {
            const active = group.method ? state.activeMethods.includes(group.method.id) : false;
            return (
              <SettingsGroup key={group.key}>
                <div className="space-y-1">
                  <h4 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {group.title}
                    {active && (
                      <Badge className="bg-primary/10 text-primary">
                        <CheckIcon />
                        Active
                      </Badge>
                    )}
                  </h4>
                  <p className="text-xs text-pretty text-muted-foreground">{group.description}</p>
                </div>
                <div className="grid grid-cols-1 gap-4">
                  {group.fields.map(({ field, optional }) => (
                    <ProviderField
                      key={field.envVar}
                      provider={provider}
                      field={field}
                      optional={optional}
                      state={state}
                      value={drafts[field.envVar] ?? ""}
                      error={errors[field.envVar] ?? null}
                      busy={busy}
                      onChange={(value) => edit(field.envVar, value)}
                      onClear={() => void clear(field)}
                    />
                  ))}
                </div>
              </SettingsGroup>
            );
          })}

          <div className="space-y-3 border-t p-4 sm:px-5">
            {formError && (
              <p role="alert" className="flex gap-2 text-xs text-destructive">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">{formError}</span>
              </p>
            )}
            {shownTest && <TestResult result={shownTest.result} typed={shownTest.typed} now={now} />}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              <p className="text-xs text-muted-foreground sm:mr-auto">
                Test {hasTyped ? "the typed values" : "the current values"}:{" "}
                <span className="break-words">{provider.healthCheck}</span>
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void runTest()}
                disabled={!canTest || busy !== null}
                className={cn(FIELD, "w-full sm:w-auto")}
              >
                {busy === "test" ? <Loader2Icon className="animate-spin" /> : <FlaskConicalIcon />}
                Test
              </Button>
              <Button
                type="submit"
                disabled={!hasTyped || !typedValid || busy !== null}
                className={cn(FIELD, "w-full sm:w-auto")}
              >
                {busy === "save" && <Loader2Icon className="animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        </form>
      )}
    </li>
  );
}

function ProviderField({
  provider,
  field,
  optional,
  state,
  value,
  error,
  busy,
  onChange,
  onClear,
}: {
  provider: AiProviderDefinition;
  field: AiProviderField;
  optional: boolean;
  state: AiProviderState;
  value: string;
  error: string | null;
  busy: string | null;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  const id = `ai-${provider.id}-${field.envVar}`;
  const current = state.fields[field.envVar];
  const saved = current?.source === "settings";
  const inputProps = {
    id,
    name: field.envVar,
    value,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    placeholder: current?.value ?? field.placeholder,
    autoComplete: "off",
    autoCapitalize: "off",
    autoCorrect: "off",
    spellCheck: false,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : `${id}-state`,
  } as const;

  return (
    <SettingsField
      label={optional ? `${field.label} (optional)` : field.label}
      htmlFor={id}
      hint={field.help}
      error={error}
    >
      {field.secret ? (
        <PasswordInput {...inputProps} className="font-mono" />
      ) : (
        <Input {...inputProps} className={cn(FIELD, "font-mono")} />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <p id={`${id}-state`} className="min-w-0 flex-1 text-xs break-words text-muted-foreground">
          <code className="font-mono text-[0.7rem]">{field.envVar}</code>
          {" · "}
          {current?.broken ? (
            <span className="text-destructive">Saved value can&apos;t be decrypted; enter it again</span>
          ) : saved ? (
            <>
              Saved in Settings: <span className="font-mono">{current.value}</span>
              {current.overridesEnvironment && " · overrides server environment"}
            </>
          ) : current?.source === "environment" ? (
            <>
              Server environment: <span className="font-mono">{current.value}</span>
            </>
          ) : (
            "Not set"
          )}
        </p>
        {(saved || current?.broken) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={busy !== null}
            className="h-11 shrink-0 text-muted-foreground hover:text-destructive md:h-7"
          >
            {busy === field.envVar ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
            Remove saved value
          </Button>
        )}
      </div>
    </SettingsField>
  );
}

function TestResult({ result, typed, now }: { result: AiProviderTestResult; typed: boolean; now: number }) {
  return (
    <div
      role="status"
      className={cn(
        "flex gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-inset",
        result.ok
          ? "bg-success/10 text-success ring-success/25"
          : "bg-destructive/10 text-destructive ring-destructive/25 dark:bg-destructive/20",
      )}
    >
      {result.ok ? (
        <CheckIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <XIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium break-words">{result.message}</p>
        <p className="opacity-80">
          {typed ? "Typed values" : "Current values"} · {formatLatency(result.latencyMs)} ·{" "}
          <time dateTime={result.checkedAt} title={formatDateTime(result.checkedAt)}>
            {formatRelative(result.checkedAt, now)}
          </time>
        </p>
      </div>
    </div>
  );
}

/** Model names as badges: the first few, then "Show all", with a filter for long lists. */
function ModelList({ models, label }: { models: AiProviderModel[]; label: string }) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? models.filter((m) => m.name.toLowerCase().includes(q) || m.selector.toLowerCase().includes(q))
    : models;
  const shown = expanded ? filtered : filtered.slice(0, MODELS_PREVIEW);
  const hidden = filtered.length - shown.length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {models.length} model{models.length === 1 ? "" : "s"} available in omp
        </p>
        {models.length > MODELS_FILTER_MIN && (
          <div className="relative w-full sm:ml-auto sm:w-56">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter models"
              aria-label={`Filter ${label}`}
              aria-controls={listId}
              className={cn(FIELD, "pl-8 text-sm md:h-8")}
            />
          </div>
        )}
      </div>
      <ul
        id={listId}
        aria-label={label}
        className={cn("flex flex-wrap gap-1.5", expanded && filtered.length > 60 && "max-h-72 overflow-y-auto pr-1")}
      >
        {shown.map((model) => (
          <li key={model.selector} className="max-w-full">
            <Badge variant="outline" title={model.selector} className="max-w-full font-normal">
              <span className="truncate">{model.name}</span>
            </Badge>
          </li>
        ))}
      </ul>
      {q && filtered.length === 0 && <p className="text-xs text-muted-foreground">No models match “{query.trim()}”.</p>}
      {(hidden > 0 || (expanded && filtered.length > MODELS_PREVIEW)) && (
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
          className="h-11 px-0 text-xs md:h-7"
        >
          {expanded ? "Show fewer" : `Show all ${filtered.length}`}
        </Button>
      )}
    </div>
  );
}

/** omp providers outside the catalog (signed in through omp itself), read-only. */
function OtherProviders({ providers }: { providers: AiOtherProvider[] }) {
  return (
    <SettingsPanel>
      <SettingsGroup title="Also available through omp">
        <p className="-mt-2 text-xs text-pretty text-muted-foreground">
          Providers omp is signed in to or lists models for that are managed outside this page (e.g. with{" "}
          <code className="font-mono">omp login</code> on the server).
        </p>
        <ul className="divide-y divide-border/70">
          {providers.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
              <code className="font-mono text-sm">{p.id}</code>
              <span className="text-xs text-muted-foreground tabular-nums">
                {p.models.length} model{p.models.length === 1 ? "" : "s"}
              </span>
              {p.ompSignIn && (
                <span className="text-xs text-muted-foreground sm:ml-auto">
                  Signed in{p.ompSignIn.account ? ` · ${p.ompSignIn.account}` : ""}
                </span>
              )}
            </li>
          ))}
        </ul>
      </SettingsGroup>
    </SettingsPanel>
  );
}
