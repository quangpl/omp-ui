"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/components/board/format";
import { SettingsGroup, SettingsPanel, SettingsSaveBar } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AI_OTHER_OAUTH_LOGINS, AI_PROVIDERS, type AiProvidersResponse } from "@/lib/ai-providers";
import { api } from "@/lib/api-client";
import { providerRoleModel, quotaBlocks, selectorProvider, type ProviderPriorityEntry } from "@/lib/provider-priority";
import type { ModelRoles } from "@/lib/agent/model-select";
import type { OmpSettingValue } from "@/lib/types";

/** An omp provider runs can use: it is authenticated and omp lists models for it. */
interface ProviderOption {
  id: string;
  label: string;
}

let seq = 0;
const nextId = () => ++seq;

interface Row extends ProviderPriorityEntry {
  id: number;
}

/**
 * omp providers (the first segment of model selectors) of the authenticated catalog providers and
 * of the providers omp uses outside the catalog.
 */
function providerOptions(data: AiProvidersResponse): ProviderOption[] {
  const options = new Map<string, ProviderOption>();
  const add = (label: (id: string) => string, models: { selector: string }[]) => {
    for (const model of models) {
      const id = selectorProvider(model.selector);
      if (!id) continue;
      if (!options.has(id)) options.set(id, { id, label: label(id) });
    }
  };
  for (const provider of AI_PROVIDERS) {
    const state = data.providers.find((p) => p.id === provider.id);
    if (state?.status !== "authenticated") continue;
    add((id) => (id === provider.id ? provider.name : `${provider.name} (${id})`), state.models);
  }
  for (const other of data.other) {
    add((id) => AI_OTHER_OAUTH_LOGINS.find((login) => login.id === id)?.label ?? id, other.models);
  }
  return [...options.values()];
}

/** omp's `modelRoles` (role → model selector) out of GET /omp-config `settings`; null when it sets none. */
function rolesOf(value: OmpSettingValue | undefined): ModelRoles | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const roles: ModelRoles = {};
  for (const [role, selector] of Object.entries(value)) if (typeof selector === "string") roles[role] = selector;
  return roles;
}

/**
 * Settings → AI Providers → Provider priority: the Main provider agents run on, and the providers
 * that take over, in order, only while the ones above are out of quota (lib/provider-priority.ts).
 * Only providers are chosen here: each runs the model of one of omp's model roles.
 */
export function AiProviderPriority({ data }: { data: AiProvidersResponse }) {
  const options = useMemo(() => providerOptions(data), [data]);
  const [saved, setSaved] = useState<ProviderPriorityEntry[] | null>(null);
  /** null = untouched: the form shows what is saved. */
  const [draft, setDraft] = useState<Row[] | null>(null);
  const initialRows = useMemo(() => (saved ?? []).map((entry) => ({ ...entry, id: nextId() })), [saved]);
  const [saving, setSaving] = useState(false);
  /** omp's model roles; null until read (or when omp's config could not be read: no hints then). */
  const [roles, setRoles] = useState<ModelRoles | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** omp provider → when its exhausted quota resets (ms epoch), per `omp usage`. */
  const [outOfQuota, setOutOfQuota] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    api.settings
      .get()
      .then((settings) => {
        if (!cancelled) setSaved(settings.providerPriority);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error && err.message ? err.message : "Could not load settings.");
      });
    // The roles are a hint here: a failed read just shows no model notes.
    api.ompConfig
      .get()
      .then((config) => {
        if (!cancelled) setRoles(rolesOf(config.settings.modelRoles) ?? {});
      })
      .catch(() => {
        if (!cancelled) setRoles(null);
      });
    // Quota is a hint here: a failed read just shows no "out of quota" badges.
    api.stats
      .ai()
      .then((stats) => {
        if (!cancelled) setOutOfQuota(quotaBlocks(stats.quota.providers, Date.now()));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = draft ?? initialRows;
  const entries = rows.map(({ provider }) => ({ provider }));
  const incomplete = rows.some((row) => !row.provider);
  const dirty = saved !== null && JSON.stringify(entries) !== JSON.stringify(saved);

  const edit = (fn: (rows: Row[]) => Row[]) => setDraft(fn(rows));
  const editRow = (id: number, patch: ProviderPriorityEntry) =>
    edit((list) => list.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const move = (index: number, delta: number) =>
    edit((list) => {
      const next = [...list];
      const [row] = next.splice(index, 1);
      next.splice(index + delta, 0, row!);
      return next;
    });
  const unused = options.filter((option) => !rows.some((row) => row.provider === option.id));

  function addRow() {
    const option = unused[0];
    edit((list) => [...list, { id: nextId(), provider: option?.id ?? "" }]);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || incomplete || saving) return;
    setSaving(true);
    try {
      const next = await api.settings.update({ providerPriority: entries });
      setSaved(next.providerPriority);
      setDraft(null);
      toast.success("Provider priority saved", { description: "Applies to the next agent run." });
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Could not save the provider priority.");
    } finally {
      setSaving(false);
    }
  }

  const iconButton = "pressable-icon size-11 shrink-0 text-muted-foreground md:size-8";

  return (
    <form onSubmit={onSubmit} noValidate>
      <SettingsPanel>
        <SettingsGroup title="Provider priority">
          <p className="-mt-2 text-xs text-pretty text-muted-foreground">
            Agents run on the Main provider. Only while it is out of quota (omp reports a used-up limit, or a run
            fails on one) do runs move to the next provider below; a run that fails on a provider error — a usage
            limit, or the provider being unavailable — continues on the next provider's model. They go back to Main
            once its quota resets. Models are not chosen here: each provider runs the model of one of your omp model
            roles (OMP config); a model pinned on a board still wins.
          </p>
          {loadError ? (
            <p role="alert" className="text-xs text-destructive">
              {loadError}
            </p>
          ) : saved === null ? (
            <Skeleton className="h-12" />
          ) : rows.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              No Main provider: runs use the default model.
              {options.length === 0 && " Authenticate a provider above to choose one."}
            </p>
          ) : (
            <ol className="space-y-2">
              {rows.map((row, index) => {
                const option = options.find((o) => o.id === row.provider);
                const until = outOfQuota.get(row.provider);
                const choices = options.filter((o) => o.id === row.provider || !rows.some((r) => r.provider === o.id));
                return (
                  <li key={row.id} className="space-y-1.5 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={index === 0 ? "default" : "secondary"} className="w-20 shrink-0 justify-center">
                        {index === 0 ? "Main" : `Backup ${index}`}
                      </Badge>
                      <Select
                        value={row.provider}
                        onValueChange={(provider) => editRow(row.id, { provider })}
                        disabled={saving}
                      >
                        <SelectTrigger
                          aria-label={`${index === 0 ? "Main" : `Backup ${index}`} provider`}
                          className="min-w-40 flex-1 basis-40 data-[size=default]:h-11 md:data-[size=default]:h-9"
                        >
                          <SelectValue placeholder="Pick a provider" />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          {!option && row.provider && (
                            <SelectItem value={row.provider} className="min-h-11 font-mono md:min-h-8">
                              {row.provider}
                            </SelectItem>
                          )}
                          {choices.map((o) => (
                            <SelectItem key={o.id} value={o.id} className="min-h-11 md:min-h-8">
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => move(index, -1)}
                          disabled={saving || index === 0}
                          aria-label={`Move ${row.provider || "provider"} up`}
                          title={index === 1 ? "Make Main" : "Use earlier"}
                          className={iconButton}
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => move(index, 1)}
                          disabled={saving || index === rows.length - 1}
                          aria-label={`Move ${row.provider || "provider"} down`}
                          title="Use later"
                          className={iconButton}
                        >
                          <ArrowDownIcon />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => edit((list) => list.filter((r) => r.id !== row.id))}
                          disabled={saving}
                          aria-label={`Remove ${row.provider || "provider"}`}
                          title="Remove"
                          className={iconButton}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    </div>
                    {row.provider && !option && (
                      <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        Not authenticated: omp lists no models for {row.provider}, so its runs fail over to the next provider.
                      </p>
                    )}
                    {row.provider && option && roles !== undefined && roles !== null && (
                      <RoleNote provider={row.provider} roles={roles} />
                    )}
                    {until !== undefined && (
                      <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        Out of quota until {formatDateTime(new Date(until).toISOString())}: runs use the next provider meanwhile.
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {saved !== null && (
            <Button
              type="button"
              variant="outline"
              onClick={addRow}
              disabled={saving || unused.length === 0}
              className="pressable h-11 md:h-9"
            >
              <PlusIcon />
              {rows.length === 0 ? "Choose Main provider" : "Add backup provider"}
            </Button>
          )}
        </SettingsGroup>
        <SettingsSaveBar
          dirty={dirty}
          saving={saving}
          disabled={!dirty || incomplete}
          onDiscard={() => setDraft(null)}
        />
      </SettingsPanel>
    </form>
  );
}

/** What a provider runs: the model of the omp role that uses it, or why it is skipped. */
function RoleNote({ provider, roles }: { provider: string; roles: ModelRoles }) {
  const model = providerRoleModel(roles, provider);
  if (!model) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
        No omp model role uses {provider}: runs skip it. Set a role to one of its models in OMP config.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Model from omp roles: <span className="font-mono">{model}</span>
    </p>
  );
}
