"use client";

import { useDeferredValue, useId, useState } from "react";
import { ChevronDownIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { FALLBACK_SETTINGS_KEYS } from "@/components/settings/omp-fallback-models";
import { SettingsPanel, SettingsSaveBar } from "@/components/settings/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import type { OmpConfigSnapshot, OmpSettingInfo, OmpSettingValue } from "@/lib/types";

const FIELD = "h-11 md:h-9";
const DEFAULT_OPTION = "__default__";
/** A search or filter opens every matching section only up to this many rows; beyond, sections stay collapsed. */
const AUTO_EXPAND_MAX = 60;
const GENERAL_GROUP = "general";

/** Edited keys → form text; null = remove the key from config.yml (omp's default applies). */
type Draft = Record<string, string | null>;

/** A value as form text: JSON for lists and mappings, "" when unset. */
function toText(setting: OmpSettingInfo, value: OmpSettingValue | undefined): string {
  if (value === undefined || value === null) return "";
  return setting.type === "array" || setting.type === "record" ? JSON.stringify(value, null, 2) : String(value);
}

/** Form text → the value to save ("" unsets), or why it is invalid. */
function parse(setting: OmpSettingInfo, text: string): { value: OmpSettingValue } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { value: null };
  switch (setting.type) {
    case "boolean":
      return { value: trimmed === "true" };
    case "number": {
      const n = Number(trimmed);
      return Number.isFinite(n) ? { value: n } : { error: "Enter a number." };
    }
    case "array":
    case "record": {
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        return { error: "Not valid JSON." };
      }
      if (setting.type === "array" && !Array.isArray(value)) return { error: 'Enter a JSON list, e.g. ["a", "b"].' };
      if (setting.type === "record" && (value === null || typeof value !== "object" || Array.isArray(value))) {
        return { error: 'Enter a JSON object, e.g. {"key": "value"}.' };
      }
      return { value: value as OmpSettingValue };
    }
    default:
      return { value: text };
  }
}

function describeDefault(setting: OmpSettingInfo): string {
  const value = setting.default;
  if (setting.secret) return "secret";
  if (value === null || value === "") return "none";
  if (typeof value === "boolean") return value ? "On" : "Off";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * Settings → OMP → All settings: every key omp knows (`omp config list`), grouped by section, each
 * with a control for its type; the form above keeps its own keys. Saves only the edited keys.
 */
export function OmpAllSettings({
  snapshot,
  onSaved,
}: {
  snapshot: OmpConfigSnapshot;
  onSaved: (next: OmpConfigSnapshot) => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<OmpSettingInfo[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlySet, setOnlySet] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const panelId = useId();
  const onlySetId = useId();

  function loadCatalog(refresh: boolean) {
    setCatalog(null);
    setCatalogError(null);
    api.ompConfig
      .settings(refresh)
      .then((res) => setCatalog(res.settings))
      .catch((err: unknown) =>
        setCatalogError(err instanceof Error && err.message ? err.message : "Could not list omp's settings."),
      );
  }

  const formKeys = new Set<string>([...snapshot.schema.map((f) => f.key), ...FALLBACK_SETTINGS_KEYS]);
  const settings = (catalog ?? []).filter((s) => !formKeys.has(s.key));
  const isSet = (key: string) => key in snapshot.settings || snapshot.secretsSet.includes(key);
  const initial = (s: OmpSettingInfo) => (s.secret ? "" : toText(s, snapshot.settings[s.key]));
  const isChanged = (s: OmpSettingInfo) => {
    if (!(s.key in draft)) return false;
    const text = draft[s.key];
    if (text === null) return isSet(s.key);
    return s.secret ? text !== "" : text !== initial(s);
  };
  const changed = settings.filter(isChanged);
  const errors: Record<string, string> = {};
  for (const s of changed) {
    const text = draft[s.key];
    const parsed = text === null ? null : parse(s, text);
    if (parsed && "error" in parsed) errors[s.key] = parsed.error;
  }
  const dirty = changed.length > 0;
  const valid = Object.keys(errors).length === 0;

  const q = useDeferredValue(query).trim().toLowerCase();
  const groups = new Map<string, OmpSettingInfo[]>();
  for (const s of settings) {
    if (onlySet && !isSet(s.key) && !isChanged(s)) continue;
    if (q && !s.key.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) continue;
    const group = s.key.includes(".") ? s.key.slice(0, s.key.indexOf(".")) : GENERAL_GROUP;
    groups.set(group, [...(groups.get(group) ?? []), s]);
  }
  const groupNames = [...groups.keys()].sort((a, b) =>
    a === GENERAL_GROUP ? -1 : b === GENERAL_GROUP ? 1 : a.localeCompare(b),
  );
  const matchCount = groupNames.reduce((n, group) => n + groups.get(group)!.length, 0);
  const filtered = q !== "" || onlySet;
  const autoExpand = filtered && matchCount <= AUTO_EXPAND_MAX;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || !valid || saving) return;
    setSaving(true);
    try {
      const values: Record<string, OmpSettingValue> = {};
      for (const s of changed) {
        const text = draft[s.key];
        const parsed = text === null ? null : parse(s, text);
        values[s.key] = parsed && "value" in parsed ? parsed.value : null;
      }
      const next = await api.ompConfig.update({ values });
      setDraft({});
      onSaved(next);
      toast.success(`Saved ${changed.length} omp setting${changed.length === 1 ? "" : "s"}`, {
        description: "Applies to the next agent run.",
      });
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Could not save omp's config.");
    } finally {
      setSaving(false);
    }
  }

  function renderControl(s: OmpSettingInfo, id: string, text: string, error: string | undefined) {
    const set = (next: string) => setDraft((d) => ({ ...d, [s.key]: next }));
    if (s.type === "boolean" || (s.type === "enum" && s.options.length > 0)) {
      const options =
        s.type === "boolean"
          ? [
              { value: "true", label: "On" },
              { value: "false", label: "Off" },
            ]
          : s.options.map((o) => ({ value: o, label: o }));
      if (text && !options.some((o) => o.value === text)) options.push({ value: text, label: text });
      return (
        <Select value={text || DEFAULT_OPTION} onValueChange={(v) => set(v === DEFAULT_OPTION ? "" : v)} disabled={saving}>
          <SelectTrigger id={id} className="w-full data-[size=default]:h-11 md:data-[size=default]:h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={DEFAULT_OPTION} className="min-h-11 md:min-h-8">
              omp default ({describeDefault(s)})
            </SelectItem>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} className="min-h-11 md:min-h-8">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (s.type === "array" || s.type === "record") {
      return (
        <Textarea
          id={id}
          value={text}
          onChange={(e) => set(e.target.value)}
          placeholder={s.default === null ? (s.type === "array" ? "[]" : "{}") : JSON.stringify(s.default)}
          aria-invalid={error ? true : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={saving}
          className="min-h-16 font-mono text-base md:text-xs"
        />
      );
    }
    return (
      <Input
        id={id}
        value={text}
        onChange={(e) => set(e.target.value)}
        placeholder={
          s.secret
            ? isSet(s.key)
              ? "Set; type to replace"
              : "Not set"
            : s.default === null || s.default === ""
              ? "Not set"
              : `Default: ${describeDefault(s)}`
        }
        type={s.secret ? "password" : s.type === "number" ? "number" : "text"}
        inputMode={s.type === "number" ? "decimal" : undefined}
        step={s.type === "number" ? "any" : undefined}
        autoComplete={s.secret ? "new-password" : "off"}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        disabled={saving}
        className={`${FIELD} font-mono md:text-xs`}
      />
    );
  }

  function renderRow(s: OmpSettingInfo, group: string) {
    const id = `omp-all-${s.key.replace(/[^a-zA-Z0-9]+/g, "-")}`;
    const pendingReset = draft[s.key] === null;
    const text = s.key in draft ? (draft[s.key] ?? "") : initial(s);
    const error = errors[s.key];
    const wide = s.type === "array" || s.type === "record";
    const name = group === GENERAL_GROUP ? s.key : s.key.slice(group.length + 1);
    return (
      <div key={s.key} className={`grid gap-2 py-3 ${wide ? "" : "sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-start sm:gap-4"}`}>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Label htmlFor={id} className="font-mono text-xs break-all" title={s.key}>
              {name}
            </Label>
            {pendingReset ? (
              <Badge variant="outline">Reset on save</Badge>
            ) : isChanged(s) ? (
              <Badge variant="outline">Changed</Badge>
            ) : (
              isSet(s.key) && <Badge variant="secondary">Set</Badge>
            )}
          </div>
          {s.description && <p className="text-xs text-pretty text-muted-foreground">{s.description}</p>}
        </div>
        <div className="min-w-0 space-y-1.5">
          {pendingReset ? (
            <p className="flex min-h-11 items-center text-xs text-muted-foreground md:min-h-9">
              omp default ({describeDefault(s)})
            </p>
          ) : (
            renderControl(s, id, text, error)
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-1 empty:hidden">
            {s.key in draft && (pendingReset || isChanged(s)) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() =>
                  setDraft((d) => {
                    const rest = { ...d };
                    delete rest[s.key];
                    return rest;
                  })
                }
              >
                Undo
              </Button>
            )}
            {isSet(s.key) && !pendingReset && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => setDraft((d) => ({ ...d, [s.key]: null }))}
                title="Remove from config.yml so omp's default applies"
              >
                Reset to default
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const total = settings.length;
  return (
    <SettingsPanel>
      <button
        type="button"
        onClick={() => {
          if (!open && !catalog && !catalogError) loadCatalog(false);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none active:bg-muted/70 sm:px-5"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">All settings{catalog ? ` (${total})` : ""}</span>
          <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
            Every setting omp knows, by section. The form above keeps its own settings.
          </span>
        </span>
        {dirty && <Badge variant="secondary">Unsaved</Badge>}
        <ChevronDownIcon
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div id={panelId} className="border-t">
          {catalogError ? (
            <div className="p-4 sm:p-5">
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Could not list omp&apos;s settings</AlertTitle>
                <AlertDescription className="space-y-3">
                  <p className="break-words">{catalogError}</p>
                  <Button type="button" variant="outline" onClick={() => loadCatalog(true)} className={`${FIELD} pressable`}>
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            </div>
          ) : !catalog ? (
            <div className="space-y-3 p-4 sm:p-5" aria-busy="true" aria-label="Loading omp's settings">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <form onSubmit={onSubmit} noValidate>
              <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:p-5">
                <div className="relative min-w-0 flex-1">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search settings"
                    aria-label="Search omp settings"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className={`${FIELD} pl-9`}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch id={onlySetId} checked={onlySet} onCheckedChange={setOnlySet} />
                    <Label htmlFor={onlySetId} className="text-xs whitespace-nowrap">
                      Only set in config.yml
                    </Label>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => loadCatalog(true)}
                    aria-label="Reload omp's settings list"
                    title="Reload the settings list from omp"
                    className="pressable-icon size-11 md:size-8"
                  >
                    <RefreshCwIcon />
                  </Button>
                </div>
              </div>
              {groupNames.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground sm:p-5">No settings match.</p>
              ) : (
                <div className="divide-y">
                  {filtered && !autoExpand && (
                    <p className="px-4 py-2 text-xs text-muted-foreground sm:px-5" aria-live="polite">
                      {matchCount} matching settings. Open a section, or narrow the search.
                    </p>
                  )}
                  {groupNames.map((group) => {
                    const list = groups.get(group)!;
                    const isOpen = autoExpand || expanded.has(group);
                    const setCount = list.filter((s) => isSet(s.key)).length;
                    const changedCount = list.filter(isChanged).length;
                    return (
                      <section key={group} aria-label={group}>
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(group)) next.delete(group);
                              else next.add(group);
                              return next;
                            })
                          }
                          aria-expanded={isOpen}
                          className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:px-5"
                        >
                          <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{group}</span>
                          {changedCount > 0 && <Badge variant="outline">{changedCount} changed</Badge>}
                          {setCount > 0 && <Badge variant="secondary">{setCount} set</Badge>}
                          <span className="text-xs text-muted-foreground tabular-nums">{list.length}</span>
                          <ChevronDownIcon
                            className={`size-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                          />
                        </button>
                        {isOpen && (
                          <div className="divide-y divide-border/70 px-4 pb-2 sm:px-5">
                            {list.map((s) => renderRow(s, group))}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
              <SettingsSaveBar
                dirty={dirty}
                saving={saving}
                disabled={!dirty || !valid}
                onDiscard={() => setDraft({})}
                discardLabel="Reset"
              />
            </form>
          )}
        </div>
      )}
    </SettingsPanel>
  );
}
