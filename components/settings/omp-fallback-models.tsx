"use client";

import { useId, useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { ModelSelect, splitModel, type ModelsStatus } from "@/components/settings/model-select";
import {
  SettingsGroup,
  SettingsPanel,
  SettingsRows,
  SettingsSaveBar,
  SettingsToggle,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import type { OmpConfigSnapshot, OmpModel, OmpSettingValue } from "@/lib/types";

/** The omp settings this editor owns (hidden from the generic "All settings" list). */
export const FALLBACK_SETTINGS_KEYS = ["retry.modelFallback", "retry.fallbackChains"] as const;

const NO_THINKING = "__none__";

let seq = 0;
const nextId = () => ++seq;

/** One `retry.fallbackChains` entry: a primary selector and its ordered fallback selectors. */
interface Chain {
  id: number;
  primary: string;
  fallbacks: { id: number; value: string }[];
}

interface EditorState {
  /** `retry.modelFallback` as the file sets it (omp's default: on). */
  enabled: boolean;
  chains: Chain[];
}

function initialState(snapshot: OmpConfigSnapshot): EditorState {
  const raw = snapshot.settings["retry.fallbackChains"];
  const chains: Chain[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [primary, list] of Object.entries(raw)) {
      chains.push({
        id: nextId(),
        primary,
        fallbacks: (Array.isArray(list) ? list : [])
          .filter((v): v is string => typeof v === "string")
          .map((value) => ({ id: nextId(), value })),
      });
    }
  }
  const enabled = snapshot.settings["retry.modelFallback"];
  return { enabled: typeof enabled === "boolean" ? enabled : true, chains };
}

/** The chains as saved: non-empty primaries with their non-empty fallbacks, in order. */
function toRecord(chains: Chain[]): Record<string, string[]> {
  const record: Record<string, string[]> = {};
  for (const chain of chains) {
    const primary = chain.primary.trim();
    const fallbacks = chain.fallbacks.map((f) => f.value.trim()).filter(Boolean);
    if (primary && fallbacks.length > 0) record[primary] = fallbacks;
  }
  return record;
}

/** Why a chain cannot be saved yet; null when it is fine (a fully empty chain is just dropped). */
function chainError(chain: Chain, index: number, chains: Chain[]): string | null {
  const primary = chain.primary.trim();
  const fallbacks = chain.fallbacks.map((f) => f.value.trim()).filter(Boolean);
  if (!primary && fallbacks.length === 0) return null;
  if (!primary) return "Pick the model these fallbacks are for.";
  if (/\s/.test(primary) || fallbacks.some((f) => /\s/.test(f))) {
    return "Model selectors can't contain spaces, e.g. provider/model-id.";
  }
  if (chains.slice(0, index).some((c) => c.primary.trim() === primary)) return "This model already has a chain.";
  if (fallbacks.length === 0) return "Add at least one fallback model.";
  return null;
}

/**
 * Settings → OMP → Fallback models: an editor for omp's `retry.fallbackChains` (which models a
 * failing model falls back to, in order) and the `retry.modelFallback` switch, with the same model
 * pickers as the role fields instead of raw YAML/JSON.
 */
export function OmpFallbackModels({
  snapshot,
  models,
  modelsStatus,
  thinkingLevels,
  thinkingOptions,
  onSaved,
}: {
  snapshot: OmpConfigSnapshot;
  models: OmpModel[];
  modelsStatus: ModelsStatus;
  /** Every thinking level a fallback entry may carry as a ":<level>" suffix. */
  thinkingLevels: ReadonlySet<string>;
  thinkingOptions: { value: string; label: string }[];
  onSaved: (next: OmpConfigSnapshot) => void;
}) {
  const initial = useMemo(() => initialState(snapshot), [snapshot]);
  /** null = untouched: the form shows what the file holds. */
  const [draft, setDraft] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const toggleId = useId();
  const state = draft ?? initial;

  const edit = (fn: (s: EditorState) => EditorState) => setDraft(fn(state));
  const editChain = (id: number, fn: (c: Chain) => Chain | null) =>
    edit((s) => ({ ...s, chains: s.chains.flatMap((c) => (c.id === id ? (fn(c) ?? []) : c)) }));

  const record = toRecord(state.chains);
  const errors = state.chains.map((c, i) => chainError(c, i, state.chains));
  const valid = errors.every((e) => e === null);
  const dirty = state.enabled !== initial.enabled || JSON.stringify(record) !== JSON.stringify(toRecord(initial.chains));

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dirty || !valid || saving) return;
    setSaving(true);
    try {
      const values: Record<string, OmpSettingValue> = {};
      if (JSON.stringify(record) !== JSON.stringify(toRecord(initial.chains))) {
        values["retry.fallbackChains"] = Object.keys(record).length > 0 ? record : null;
      }
      if (state.enabled !== initial.enabled) values["retry.modelFallback"] = state.enabled;
      const next = await api.ompConfig.update({ values });
      setDraft(null);
      onSaved(next);
      toast.success("Fallback models saved", { description: "Applies to the next agent run." });
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Could not save omp's config.");
    } finally {
      setSaving(false);
    }
  }

  function renderFallback(chain: Chain, entry: Chain["fallbacks"][number], index: number) {
    const { model, thinking } = splitModel(entry.value, thinkingLevels);
    const known = models.find((m) => m.selector === model);
    const wildcard = model.endsWith("/*");
    // Levels the picked model supports; an unknown (non-wildcard) model offers every level.
    const levels = known ? [...known.thinking] : model && !wildcard ? [...thinkingLevels] : [];
    if (thinking && !levels.includes(thinking)) levels.push(thinking);
    const set = (nextModel: string, nextThinking: string) =>
      editChain(chain.id, (c) => ({
        ...c,
        fallbacks: c.fallbacks.map((f) =>
          f.id === entry.id ? { ...f, value: nextModel && nextThinking ? `${nextModel}:${nextThinking}` : nextModel } : f,
        ),
      }));
    const move = (delta: number) =>
      editChain(chain.id, (c) => {
        const fallbacks = [...c.fallbacks];
        const [row] = fallbacks.splice(index, 1);
        fallbacks.splice(index + delta, 0, row);
        return { ...c, fallbacks };
      });
    const iconButton = "pressable-icon size-11 shrink-0 text-muted-foreground md:size-8";
    return (
      <li key={entry.id} className="flex flex-wrap items-center gap-2">
        <span className="w-4 shrink-0 text-right font-mono text-xs text-muted-foreground" aria-hidden="true">
          {index + 1}.
        </span>
        <ModelSelect
          value={model}
          onChange={(next) => {
            const supported = models.find((m) => m.selector === next)?.thinking ?? [];
            set(next, supported.includes(thinking) ? thinking : "");
          }}
          models={models}
          status={modelsStatus}
          wildcards
          placeholder="Pick a fallback model"
          ariaLabel={`Fallback ${index + 1} for ${chain.primary.trim() || "this chain"}`}
          disabled={saving}
          className="min-w-44 flex-1 basis-52"
        />
        <div className="flex items-center gap-1">
          <Select
            value={thinking || NO_THINKING}
            onValueChange={(next) => set(model, next === NO_THINKING ? "" : next)}
            disabled={saving || levels.length === 0}
          >
            <SelectTrigger
              aria-label={`Fallback ${index + 1}: thinking level`}
              title="Thinking level"
              className="w-24 shrink-0 data-[size=default]:h-11 md:data-[size=default]:h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value={NO_THINKING} className="min-h-11 md:min-h-8">
                Default
              </SelectItem>
              {levels.map((level) => (
                <SelectItem key={level} value={level} className="min-h-11 md:min-h-8">
                  {thinkingOptions.find((o) => o.value === level)?.label ?? level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => move(-1)}
            disabled={saving || index === 0}
            aria-label={`Move fallback ${index + 1} up`}
            title="Try earlier"
            className={iconButton}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => move(1)}
            disabled={saving || index === chain.fallbacks.length - 1}
            aria-label={`Move fallback ${index + 1} down`}
            title="Try later"
            className={iconButton}
          >
            <ArrowDownIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => editChain(chain.id, (c) => ({ ...c, fallbacks: c.fallbacks.filter((f) => f.id !== entry.id) }))}
            disabled={saving}
            aria-label={`Remove fallback ${index + 1}`}
            title="Remove"
            className={iconButton}
          >
            <XIcon />
          </Button>
        </div>
      </li>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <SettingsPanel>
        <SettingsGroup title="Fallback models">
          <p className="text-xs text-pretty text-muted-foreground">
            When a model keeps failing (rate limit, quota, outage), omp retries the request on that model&apos;s
            fallbacks, in order, so runs keep going. A chain for &quot;any provider model&quot; covers every model of
            that provider.
          </p>
          <SettingsRows>
            <SettingsToggle
              htmlFor={toggleId}
              title="Switch to fallback models"
              description="Let failing requests move to the chains below. Off keeps retrying the same model."
            >
              <Switch
                id={toggleId}
                checked={state.enabled}
                onCheckedChange={(checked) => edit((s) => ({ ...s, enabled: checked }))}
                disabled={saving}
              />
            </SettingsToggle>
          </SettingsRows>
          {state.chains.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              No fallback chains yet. Add one to keep runs going when a provider fails.
            </p>
          ) : (
            <ul className="space-y-4">
              {state.chains.map((chain, index) => {
                const error = errors[index];
                return (
                  <li key={chain.id} className="space-y-3 rounded-lg border p-3 sm:p-4">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <span className="block text-xs font-medium text-muted-foreground">When this model fails</span>
                        <ModelSelect
                          value={chain.primary}
                          onChange={(next) => editChain(chain.id, (c) => ({ ...c, primary: next }))}
                          models={models}
                          status={modelsStatus}
                          wildcards
                          placeholder="Pick a model"
                          ariaLabel={`Chain ${index + 1}: model that fails`}
                          disabled={saving}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => editChain(chain.id, () => null)}
                        disabled={saving}
                        aria-label={`Remove the chain for ${chain.primary.trim() || "this model"}`}
                        title="Remove chain"
                        className="pressable-icon size-11 shrink-0 self-end text-muted-foreground md:size-9"
                      >
                        <XIcon />
                      </Button>
                    </div>
                    <div className="space-y-1.5">
                      <span className="block text-xs font-medium text-muted-foreground">Try instead, in order</span>
                      <ul className="space-y-2">{chain.fallbacks.map((entry, i) => renderFallback(chain, entry, i))}</ul>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        editChain(chain.id, (c) => ({ ...c, fallbacks: [...c.fallbacks, { id: nextId(), value: "" }] }))
                      }
                      disabled={saving}
                      className="pressable h-9 md:h-8"
                    >
                      <PlusIcon />
                      Add fallback
                    </Button>
                    {error && (
                      <p role="alert" className="animate-fade-in-soft text-xs text-destructive">
                        {error}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => edit((s) => ({ ...s, chains: [...s.chains, { id: nextId(), primary: "", fallbacks: [{ id: nextId(), value: "" }] }] }))}
            disabled={saving}
            className="pressable h-11 md:h-9"
          >
            <PlusIcon />
            Add fallback chain
          </Button>
        </SettingsGroup>
        <SettingsSaveBar dirty={dirty} saving={saving} disabled={!dirty || !valid} onDiscard={() => setDraft(null)} discardLabel="Reset" />
      </SettingsPanel>
    </form>
  );
}
