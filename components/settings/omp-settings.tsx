"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { ChevronDownIcon, Loader2Icon, RefreshCwIcon, SquareTerminalIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { AI_PROVIDERS_CHANGED_EVENT } from "@/components/settings/ai-providers-settings";
import { OmpAllSettings } from "@/components/settings/omp-all-settings";
import {
  SettingsField,
  SettingsGroup,
  SettingsPanel,
  SettingsRows,
  SettingsSaveBar,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-current-user";
import { ApiRequestError, api } from "@/lib/api-client";
import type { OmpConfigField, OmpConfigSnapshot, OmpConfigValue, OmpModel } from "@/lib/types";

const FIELD = "h-11 md:h-9";
const DEFAULT_OPTION = "__default__";
const GROUPS: { id: OmpConfigField["group"]; title: string }[] = [
  { id: "models", title: "Models" },
  { id: "behavior", title: "Behavior" },
  { id: "tools", title: "Tools" },
];

/** Form state per schema key: text for model/string/number/enum ("" = unset), booleans as is. */
type FormState = Record<string, string | boolean | null>;

function toForm(snapshot: OmpConfigSnapshot): FormState {
  const form: FormState = {};
  for (const field of snapshot.schema) {
    const value = snapshot.values[field.key];
    form[field.key] = field.type === "boolean" ? (typeof value === "boolean" ? value : null) : value === null ? "" : String(value);
  }
  return form;
}

function fieldError(field: OmpConfigField, value: string | boolean | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (field.type === "number") {
    const n = Number(value);
    const min = field.min ?? Number.MIN_SAFE_INTEGER;
    const max = field.max ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(n) || n < min || n > max) return `Enter a whole number from ${min} to ${max}.`;
  }
  if (field.type === "model" && /\s/.test(value.trim())) return "Use a model selector without spaces, e.g. provider/model-id.";
  return null;
}

/** The form value as sent to the API: "" unsets, numbers are numbers. */
function toValue(field: OmpConfigField, value: string | boolean | null): OmpConfigValue {
  if (typeof value === "boolean" || value === null) return value;
  const text = value.trim();
  if (!text) return null;
  return field.type === "number" ? Number(text) : text;
}

function describe(field: OmpConfigField, value: OmpConfigValue): string {
  if (value === null || value === "") return "not set";
  return field.options?.find((o) => o.value === value)?.label ?? String(value);
}

/** A model role value "provider/model-id[:thinking]" split into its model and thinking level ("" = none). */
function splitModel(value: string, levels: ReadonlySet<string>): { model: string; thinking: string } {
  const text = value.trim();
  const colon = text.lastIndexOf(":");
  if (colon > 0 && levels.has(text.slice(colon + 1))) return { model: text.slice(0, colon), thinking: text.slice(colon + 1) };
  return { model: text, thinking: "" };
}

/** Models by provider, in omp's order. */
function byProvider(models: OmpModel[]): [string, OmpModel[]][] {
  const groups = new Map<string, OmpModel[]>();
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return [...groups];
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Settings → OMP: omp's own user config (config.yml), as a form plus a raw YAML editor. The raw
 * editor is admin-only: the API sends non-admins no raw text (it may hold secrets).
 */
export function OmpSettingsSection() {
  const { isAdmin } = useCurrentUser();
  const [snapshot, setSnapshot] = useState<OmpConfigSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<FormState>({});
  const [saving, setSaving] = useState(false);
  /** `omp models` for the model role dropdowns; on failure the roles fall back to text inputs. */
  const [models, setModels] = useState<OmpModel[]>([]);
  const [modelsStatus, setModelsStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [raw, setRaw] = useState("");
  /** The file version `raw` was loaded from: a raw save refuses to overwrite newer edits. */
  const [rawVersion, setRawVersion] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [rawSaving, setRawSaving] = useState(false);
  const rawErrorId = useId();
  const advancedId = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    setSnapshot(null);
    try {
      const next = await api.ompConfig.get();
      setSnapshot(next);
      setDraft(toForm(next));
      setRaw(next.raw);
      setRawVersion(next.version);
      setRawError(null);
    } catch (err) {
      setLoadError(message(err, "Could not load omp's config."));
    }
  }, []);

  const loadModels = useCallback(() => {
    api.ompConfig
      .models()
      .then((res) => {
        setModels(res.models);
        setModelsStatus(res.models.length > 0 ? "ready" : "failed");
      })
      .catch(() => setModelsStatus("failed"));
  }, []);

  useEffect(() => {
    void load();
    loadModels();
  }, [load, loadModels]);

  // Saved or tested AI provider keys change which models omp lists (the server refreshed its cache).
  useEffect(() => {
    window.addEventListener(AI_PROVIDERS_CHANGED_EVENT, loadModels);
    return () => window.removeEventListener(AI_PROVIDERS_CHANGED_EVENT, loadModels);
  }, [loadModels]);

  const saved = snapshot ? toForm(snapshot) : {};
  const changedKeys = snapshot ? snapshot.schema.filter((f) => draft[f.key] !== saved[f.key]).map((f) => f.key) : [];
  const dirty = changedKeys.length > 0;
  const errors = Object.fromEntries((snapshot?.schema ?? []).map((f) => [f.key, fieldError(f, draft[f.key] ?? null)]));
  const valid = Object.values(errors).every((e) => e === null);
  const rawDirty = snapshot !== null && (raw !== snapshot.raw || rawVersion !== snapshot.version);
  const thinkingOptions = snapshot?.schema.find((f) => f.key === "defaultThinkingLevel")?.options ?? [];
  const thinkingLevels = new Set(["off", ...thinkingOptions.map((o) => o.value), ...models.flatMap((m) => m.thinking)]);

  function applySaved(next: OmpConfigSnapshot, { keepDraft, keepRaw }: { keepDraft: boolean; keepRaw: boolean }) {
    setSnapshot(next);
    if (!keepDraft) setDraft(toForm(next));
    if (!keepRaw) {
      setRaw(next.raw);
      setRawVersion(next.version);
      setRawError(null);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!snapshot || !dirty || !valid || saving) return;
    setSaving(true);
    try {
      const values: Record<string, OmpConfigValue> = {};
      for (const field of snapshot.schema) {
        if (changedKeys.includes(field.key)) values[field.key] = toValue(field, draft[field.key] ?? null);
      }
      // Key-level edits: omp applies them over whatever the file holds now, so no version guard.
      const next = await api.ompConfig.update({ values });
      applySaved(next, { keepDraft: false, keepRaw: rawDirty });
      toast.success("OMP settings saved", { description: "Applies to the next agent run." });
    } catch (err) {
      toast.error(message(err, "Could not save omp's config."));
    } finally {
      setSaving(false);
    }
  }

  async function saveRaw() {
    if (!snapshot || rawSaving || !rawDirty) return;
    setRawSaving(true);
    setRawError(null);
    try {
      const next = await api.ompConfig.update({ raw, version: rawVersion });
      applySaved(next, { keepDraft: dirty, keepRaw: false });
      toast.success("config.yml saved", { description: `Previous version kept at ${next.backupPath}` });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        toast.error(err.message, { action: { label: "Reload", onClick: () => void load() } });
      }
      setRawError(message(err, "Could not save config.yml."));
    } finally {
      setRawSaving(false);
    }
  }

  function renderField(field: OmpConfigField) {
    const id = `omp-${field.key.replace(/[^a-zA-Z0-9]+/g, "-")}`;
    const value = draft[field.key] ?? null;
    const fallback = snapshot?.defaults[field.key] ?? null;

    if (field.type === "boolean") {
      const effective = typeof value === "boolean" ? value : fallback === true;
      return (
        <SettingsToggle key={field.key} htmlFor={id} title={field.label} description={field.help}>
          <Switch
            id={id}
            checked={effective}
            onCheckedChange={(checked) => setDraft((d) => ({ ...d, [field.key]: checked }))}
            disabled={saving}
          />
        </SettingsToggle>
      );
    }

    if (field.type === "enum") {
      return (
        <SettingsField key={field.key} label={field.label} htmlFor={id} hint={field.help}>
          <Select
            value={typeof value === "string" && value ? value : DEFAULT_OPTION}
            onValueChange={(next) => setDraft((d) => ({ ...d, [field.key]: next === DEFAULT_OPTION ? "" : next }))}
            disabled={saving}
          >
            <SelectTrigger id={id} className="w-full data-[size=default]:h-11 md:data-[size=default]:h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={DEFAULT_OPTION} className="min-h-11 md:min-h-8">
                omp default ({describe(field, fallback)})
              </SelectItem>
              {field.options?.map((o) => (
                <SelectItem key={o.value} value={o.value} className="min-h-11 md:min-h-8">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>
      );
    }

    if (field.type === "model" && modelsStatus !== "failed") {
      const { model, thinking } = splitModel(typeof value === "string" ? value : "", thinkingLevels);
      const known = models.find((m) => m.selector === model);
      // Levels the picked model supports; an unknown model offers every level, a current one always stays listed.
      const levels = known ? [...known.thinking] : model ? [...thinkingLevels] : [];
      if (thinking && !levels.includes(thinking)) levels.push(thinking);
      const setRole = (nextModel: string, nextThinking: string) =>
        setDraft((d) => ({ ...d, [field.key]: nextModel && nextThinking ? `${nextModel}:${nextThinking}` : nextModel }));
      return (
        <SettingsField key={field.key} label={field.label} htmlFor={id} hint={field.help}>
          <div className="flex min-w-0 gap-2">
            <Select
              value={model || DEFAULT_OPTION}
              onValueChange={(next) => {
                if (next === DEFAULT_OPTION) return setRole("", "");
                const supported = models.find((m) => m.selector === next)?.thinking ?? [];
                setRole(next, supported.includes(thinking) ? thinking : "");
              }}
              disabled={saving}
            >
              <SelectTrigger id={id} className="w-full min-w-0 flex-1 data-[size=default]:h-11 md:data-[size=default]:h-9">
                <SelectValue>{model ? (known?.name ?? model) : `omp default (${describe(field, fallback)})`}</SelectValue>
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={DEFAULT_OPTION} className="min-h-11 md:min-h-8">
                  omp default ({describe(field, fallback)})
                </SelectItem>
                {model && !known && (
                  <SelectItem value={model} className="min-h-11 font-mono md:min-h-8 md:text-xs">
                    {model}
                  </SelectItem>
                )}
                {modelsStatus === "loading" && (
                  <SelectItem value="__loading__" disabled className="min-h-11 md:min-h-8">
                    <Loader2Icon className="animate-spin" />
                    Loading models…
                  </SelectItem>
                )}
                {byProvider(models).map(([provider, list]) => (
                  <SelectGroup key={provider}>
                    <SelectLabel>{provider}</SelectLabel>
                    {list.map((m) => (
                      <SelectItem key={m.selector} value={m.selector} className="min-h-11 md:min-h-8">
                        {m.name}
                        <span className="font-mono text-xs text-muted-foreground">{m.selector.slice(provider.length + 1)}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={thinking || DEFAULT_OPTION}
              onValueChange={(next) => setRole(model, next === DEFAULT_OPTION ? "" : next)}
              disabled={saving || levels.length === 0}
            >
              <SelectTrigger
                aria-label={`${field.label}: thinking level`}
                title="Thinking level"
                className="w-28 shrink-0 data-[size=default]:h-11 md:data-[size=default]:h-9"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={DEFAULT_OPTION} className="min-h-11 md:min-h-8">
                  Default
                </SelectItem>
                {levels.map((level) => (
                  <SelectItem key={level} value={level} className="min-h-11 md:min-h-8">
                    {thinkingOptions.find((o) => o.value === level)?.label ?? level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsField>
      );
    }

    const error = errors[field.key];
    const text = typeof value === "string" ? value : "";
    const placeholder =
      field.type === "number" ? (fallback !== null ? `Default: ${fallback}` : undefined) : field.placeholder;
    return (
      <SettingsField key={field.key} label={field.label} htmlFor={id} hint={field.help} error={error}>
        <Input
          id={id}
          value={text}
          onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
          placeholder={placeholder}
          type={field.type === "number" ? "number" : "text"}
          inputMode={field.type === "number" ? "numeric" : undefined}
          min={field.min}
          max={field.max}
          step={field.type === "number" ? 1 : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          disabled={saving}
          className={`${FIELD} ${field.type === "model" || field.type === "string" ? "font-mono md:text-xs" : ""}`}
        />
      </SettingsField>
    );
  }

  const description = (
    <>
      omp&apos;s user config, used by card runs and omp in your terminal. Changes apply to the next agent run.
    </>
  );
  const reloadButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => void load()}
      disabled={!snapshot && !loadError}
      aria-label="Reload omp's config"
      title="Reload from disk"
      className="pressable-icon size-11 md:size-8"
    >
      <RefreshCwIcon />
    </Button>
  );

  return (
    <SettingsSection id="omp" icon={<SquareTerminalIcon />} title="OMP" description={description} action={reloadButton}>
      {loadError ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Could not load omp&apos;s config</AlertTitle>
          <AlertDescription className="space-y-3">
            <p className="break-words">{loadError}</p>
            <Button type="button" variant="outline" onClick={() => void load()} className={`${FIELD} pressable`}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : !snapshot ? (
        <SettingsPanel>
          <SettingsGroup>
            <div className="space-y-5" aria-busy="true" aria-label="Loading omp's config">
              <Skeleton className="h-4 w-64 max-w-full" />
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-11 w-full md:h-9" />
                  </div>
                ))}
              </div>
            </div>
          </SettingsGroup>
        </SettingsPanel>
      ) : (
        <>
          <form onSubmit={onSubmit} noValidate>
            <SettingsPanel>
              <SettingsGroup>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Config file</span>
                  <code className="min-w-0 font-mono break-all text-foreground">{snapshot.path}</code>
                  {!snapshot.exists && <Badge variant="secondary">Created on first save</Badge>}
                </div>
              </SettingsGroup>
              {GROUPS.map((group) => {
                const fields = snapshot.schema.filter((f) => f.group === group.id);
                if (fields.length === 0) return null;
                const inputs = fields.filter((f) => f.type !== "boolean");
                const toggles = fields.filter((f) => f.type === "boolean");
                return (
                  <SettingsGroup key={group.id} title={group.title}>
                    {inputs.length > 0 && (
                      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">{inputs.map(renderField)}</div>
                    )}
                    {toggles.length > 0 && <SettingsRows>{toggles.map(renderField)}</SettingsRows>}
                  </SettingsGroup>
                );
              })}
              <SettingsSaveBar
                dirty={dirty}
                saving={saving}
                disabled={!dirty || !valid}
                onDiscard={() => setDraft(toForm(snapshot))}
                discardLabel="Reset"
              />
            </SettingsPanel>
          </form>

          <OmpAllSettings snapshot={snapshot} onSaved={(next) => applySaved(next, { keepDraft: dirty, keepRaw: rawDirty })} />

          {isAdmin && (
            <SettingsPanel>
              <button
                type="button"
                onClick={() => setAdvancedOpen((open) => !open)}
                aria-expanded={advancedOpen}
                aria-controls={advancedId}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:bg-muted/70 sm:px-5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Advanced: edit config.yml</span>
                  <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
                    All omp settings, comments included. omp validates the file before saving.
                  </span>
                </span>
                {rawDirty && <Badge variant="secondary">Unsaved</Badge>}
                <ChevronDownIcon
                  className={`size-4 shrink-0 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                />
              </button>
              {advancedOpen && (
                <div id={advancedId} className="space-y-3 border-t p-4 sm:p-5">
                  <Textarea
                    value={raw}
                    onChange={(e) => {
                      setRaw(e.target.value);
                      setRawError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void saveRaw();
                      }
                    }}
                    aria-label="config.yml"
                    aria-invalid={rawError ? true : undefined}
                    aria-describedby={rawError ? rawErrorId : undefined}
                    placeholder={"# omp settings (YAML), e.g.\ndefaultThinkingLevel: high"}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    wrap="off"
                    disabled={rawSaving}
                    className="max-h-[70dvh] min-h-64 overflow-auto font-mono text-base leading-6 md:text-xs md:leading-5"
                  />
                  {rawError && (
                    <p id={rawErrorId} role="alert" className="text-xs whitespace-pre-wrap text-destructive">
                      {rawError}
                    </p>
                  )}
                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
                    <p className="hidden text-xs text-muted-foreground sm:mr-auto sm:block">
                      <Kbd>Ctrl</Kbd> / <Kbd>⌘</Kbd> + <Kbd>Enter</Kbd> to save. Previous file kept as{" "}
                      <code className="font-mono">config.yml.bak</code>.
                    </p>
                    {rawDirty && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={rawSaving}
                        onClick={() => {
                          setRaw(snapshot.raw);
                          setRawVersion(snapshot.version);
                          setRawError(null);
                        }}
                        className={`${FIELD} pressable`}
                      >
                        Revert
                      </Button>
                    )}
                    <Button
                      type="button"
                      onClick={() => void saveRaw()}
                      disabled={!rawDirty || rawSaving}
                      className={`${FIELD} pressable`}
                    >
                      {rawSaving && <Loader2Icon className="animate-spin" />}
                      Save config.yml
                    </Button>
                  </div>
                </div>
              )}
            </SettingsPanel>
          )}
        </>
      )}
    </SettingsSection>
  );
}
