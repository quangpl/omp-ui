"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2Icon, RotateCcwIcon, SendIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import {
  SettingsField,
  SettingsGroup,
  SettingsPanel,
  SettingsRows,
  SettingsSaveBar,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { ORCHESTRATION_LIMITS, type AppSettings, type OrchestrationNumberKey } from "@/lib/types";
import { cn } from "@/lib/utils";

const FIELD = "h-11 md:h-9";
const TELEMETRY_PLACEHOLDER = "http://localhost:4318/v1/traces";
/** Same rule PATCH /settings applies to `telemetryEndpoint`. */
const HTTP_URL = /^https?:\/\/\S+$/i;

type ToggleKey =
  | "runTimeLimit"
  | "stallWatchdog"
  | "runBudget"
  | "wrapUpNudge"
  | "loopDetection"
  | "gitCheckpoints"
  | "subagentLimits"
  | "contextCompaction"
  | "telemetryExport"
  | "loadGuard";

/** The form state: toggles as booleans, numbers as the raw text typed so invalid input can be shown and rejected. */
type Draft = Record<ToggleKey, boolean> & Record<OrchestrationNumberKey, string> & { telemetryEndpoint: string };

const TOGGLE_KEYS: ToggleKey[] = [
  "runTimeLimit",
  "stallWatchdog",
  "runBudget",
  "wrapUpNudge",
  "loopDetection",
  "gitCheckpoints",
  "subagentLimits",
  "contextCompaction",
  "telemetryExport",
  "loadGuard",
];
const NUMBER_KEYS = Object.keys(ORCHESTRATION_LIMITS) as OrchestrationNumberKey[];

/** The toggle a number belongs to: a hidden number (toggle off) is neither validated nor saved. */
const NUMBER_TOGGLE: Record<OrchestrationNumberKey, ToggleKey> = {
  runTimeLimitMinutes: "runTimeLimit",
  stallTimeoutMinutes: "stallWatchdog",
  runBudgetUsd: "runBudget",
  runBudgetTokens: "runBudget",
  loadGuardPercent: "loadGuard",
  subagentMaxConcurrency: "subagentLimits",
  subagentMaxDepth: "subagentLimits",
  subagentTimeoutMinutes: "subagentLimits",
  contextCompactPercent: "contextCompaction",
  wrapUpPercent: "wrapUpNudge",
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function toDraft(settings: AppSettings): Draft {
  const draft = { telemetryEndpoint: settings.telemetryEndpoint } as Draft;
  for (const key of TOGGLE_KEYS) draft[key] = settings[key];
  for (const key of NUMBER_KEYS) draft[key] = String(settings[key]);
  return draft;
}

/** Why `raw` is not an acceptable value for `key` (ORCHESTRATION_LIMITS; dollars keep cents, the rest are whole), or null. */
function numberError(key: OrchestrationNumberKey, raw: string): string | null {
  const { min, max } = ORCHESTRATION_LIMITS[key];
  const n = Number(raw);
  if (key === "runBudgetUsd") {
    const cents = n * 100;
    const valid = raw.trim() !== "" && Number.isFinite(n) && Math.abs(cents - Math.round(cents)) < 1e-6;
    return valid && n >= min && n <= max
      ? null
      : `Enter an amount from $${min} to $${max.toLocaleString("en-US")}, at most 2 decimals.`;
  }
  return raw.trim() !== "" && Number.isInteger(n) && n >= min && n <= max
    ? null
    : `Enter a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.`;
}

/** Why the telemetry endpoint can't be saved while export is on, or null. */
function endpointError(raw: string): string | null {
  const url = raw.trim();
  if (!url) return "Enter the OTLP/HTTP traces URL.";
  return HTTP_URL.test(url) && url.length <= 2048 ? null : "Enter an http:// or https:// URL.";
}

/** A number input for one orchestration limit, with its bounds and inline error. */
function LimitField({
  id,
  label,
  hint,
  numberKey,
  draft,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: React.ReactNode;
  numberKey: OrchestrationNumberKey;
  draft: Draft;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { min, max } = ORCHESTRATION_LIMITS[numberKey];
  const dollars = numberKey === "runBudgetUsd";
  return (
    <SettingsField label={label} htmlFor={id} hint={hint} error={error}>
      <Input
        id={id}
        type="number"
        inputMode={dollars ? "decimal" : "numeric"}
        min={min}
        max={max}
        step={dollars ? 0.01 : 1}
        value={draft[numberKey]}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        disabled={disabled}
        className={`${FIELD} font-mono tabular-nums`}
      />
    </SettingsField>
  );
}

/**
 * Settings → Orchestration: opt-in guardrails (time limit, stall watchdog, budget, wrap-up nudge,
 * loop detection, load guard), git checkpoints, subagent limits, early context compaction and
 * OpenTelemetry export. Every switch is off by default; the server re-reads them whenever it
 * acts, so saved changes apply without a restart (subagent limits and compaction: to runs
 * started after saving).
 */
export function OrchestrationSettingsSection() {
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const applySettings = useCallback((settings: AppSettings) => {
    setSaved(settings);
    setDraft(toDraft(settings));
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    api.settings
      .get()
      .then(applySettings)
      .catch((err) => setLoadError(errorText(err, "Could not load settings.")));
  }, [applySettings]);

  useEffect(load, [load]);

  const errors = Object.fromEntries(
    NUMBER_KEYS.map((key) => [key, draft && draft[NUMBER_TOGGLE[key]] ? numberError(key, draft[key]) : null]),
  ) as Record<OrchestrationNumberKey, string | null>;
  const urlError = draft?.telemetryExport ? endpointError(draft.telemetryEndpoint) : null;
  const valid = NUMBER_KEYS.every((key) => !errors[key]) && !urlError;
  const baseline = saved && toDraft(saved);
  const dirty =
    baseline !== null &&
    draft !== null &&
    (baseline.telemetryEndpoint.trim() !== draft.telemetryEndpoint.trim() ||
      TOGGLE_KEYS.some((key) => baseline[key] !== draft[key]) ||
      NUMBER_KEYS.some((key) => baseline[key].trim() !== draft[key].trim()));

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!saved || !draft || !dirty || saving || !valid) return;
    setSaving(true);
    try {
      const patch: Partial<AppSettings> = {};
      for (const key of TOGGLE_KEYS) patch[key] = draft[key];
      // A hidden number (its switch off) keeps the saved value instead of whatever was last typed.
      for (const key of NUMBER_KEYS) patch[key] = draft[NUMBER_TOGGLE[key]] ? Number(draft[key]) : saved[key];
      const endpoint = draft.telemetryEndpoint.trim();
      patch.telemetryEndpoint = !draft.telemetryExport && endpointError(endpoint) ? saved.telemetryEndpoint : endpoint;
      applySettings(await api.settings.update(patch));
      toast.success("Orchestration settings saved");
    } catch (err) {
      toast.error(errorText(err, "Could not save settings."));
    } finally {
      setSaving(false);
    }
  }

  async function sendTestSpan() {
    if (!draft || testing) return;
    const endpoint = draft.telemetryEndpoint.trim();
    if (endpointError(endpoint)) return;
    setTesting(true);
    try {
      const result = await api.settings.testTelemetry(endpoint);
      if (result.ok) {
        toast.success("Test span sent", {
          description: `The collector accepted it${result.status ? ` (HTTP ${result.status})` : ""}.`,
        });
      } else {
        toast.error("Test span failed", {
          description: result.error ?? (result.status ? `The collector answered HTTP ${result.status}.` : undefined),
        });
      }
    } catch (err) {
      toast.error(errorText(err, "Could not send the test span."));
    } finally {
      setTesting(false);
    }
  }

  return (
    <SettingsSection
      id="orchestration"
      icon={<ShieldCheckIcon />}
      title="Orchestration"
      description="Guardrails and observability for running agents. All off by default; saved changes apply without a restart."
    >
      {loadError ? (
        <SettingsPanel className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="flex min-w-0 flex-1 gap-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">Couldn't load orchestration settings</p>
              <p className="text-destructive">{loadError}</p>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={load} className={cn(FIELD, "pressable w-full gap-2 sm:w-auto")}>
            <RotateCcwIcon />
            Try again
          </Button>
        </SettingsPanel>
      ) : !draft ? (
        <SettingsPanel>
          <div aria-busy="true" className="divide-y">
            {[4, 2, 2, 1, 1].map((rows, group) => (
              <div key={group} className="space-y-5 p-4 sm:p-5">
                <Skeleton className="h-3 w-20" />
                {Array.from({ length: rows }, (_, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-3/4" />
                    </div>
                    <Skeleton className="h-5 w-9 rounded-full" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </SettingsPanel>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <SettingsPanel>
            <SettingsGroup title="Run guards">
              <SettingsRows>
                <div>
                  <SettingsToggle
                    htmlFor="run-time-limit"
                    title="Run time limit"
                    description="Stops a run that is still working after the limit; the card fails without an automatic retry, since a retry would hit the same limit."
                  >
                    <Switch
                      id="run-time-limit"
                      checked={draft.runTimeLimit}
                      onCheckedChange={(checked) => set("runTimeLimit", checked)}
                      disabled={saving}
                    />
                  </SettingsToggle>
                  {draft.runTimeLimit && (
                    <div className="animate-fade-in-soft pb-4 sm:max-w-xs sm:pb-5">
                      <LimitField
                        id="run-time-limit-minutes"
                        label="Limit (minutes)"
                        hint={`Applies to runs already working too (${ORCHESTRATION_LIMITS.runTimeLimitMinutes.min}–${ORCHESTRATION_LIMITS.runTimeLimitMinutes.max} min).`}
                        numberKey="runTimeLimitMinutes"
                        draft={draft}
                        error={errors.runTimeLimitMinutes}
                        disabled={saving}
                        onChange={(value) => set("runTimeLimitMinutes", value)}
                      />
                    </div>
                  )}
                </div>

                <div>
                  <SettingsToggle
                    htmlFor="stall-watchdog"
                    title="Stall watchdog"
                    description="Aborts a run whose agent sends nothing (no output, tool calls or progress) for too long. It fails like a crash, so automatic retries resume it."
                  >
                    <Switch
                      id="stall-watchdog"
                      checked={draft.stallWatchdog}
                      onCheckedChange={(checked) => set("stallWatchdog", checked)}
                      disabled={saving}
                    />
                  </SettingsToggle>
                  {draft.stallWatchdog && (
                    <div className="animate-fade-in-soft pb-4 sm:max-w-xs sm:pb-5">
                      <LimitField
                        id="stall-timeout-minutes"
                        label="Silence before aborting (minutes)"
                        hint={`Waits on board tools don't count (${ORCHESTRATION_LIMITS.stallTimeoutMinutes.min}–${ORCHESTRATION_LIMITS.stallTimeoutMinutes.max} min).`}
                        numberKey="stallTimeoutMinutes"
                        draft={draft}
                        error={errors.stallTimeoutMinutes}
                        disabled={saving}
                        onChange={(value) => set("stallTimeoutMinutes", value)}
                      />
                    </div>
                  )}
                </div>

                <div>
                  <SettingsToggle
                    htmlFor="run-budget"
                    title="Run budget"
                    description="Stops a run once its agent session plus subagents report more than the dollar or token cap; the card fails without an automatic retry."
                  >
                    <Switch
                      id="run-budget"
                      checked={draft.runBudget}
                      onCheckedChange={(checked) => set("runBudget", checked)}
                      disabled={saving}
                    />
                  </SettingsToggle>
                  {draft.runBudget && (
                    <div className="animate-fade-in-soft grid grid-cols-1 gap-5 pb-4 sm:grid-cols-2 sm:pb-5">
                      <LimitField
                        id="run-budget-usd"
                        label="Cost cap (USD)"
                        hint={`Per run, from the cost omp reports ($${ORCHESTRATION_LIMITS.runBudgetUsd.min}–$${ORCHESTRATION_LIMITS.runBudgetUsd.max.toLocaleString("en-US")}).`}
                        numberKey="runBudgetUsd"
                        draft={draft}
                        error={errors.runBudgetUsd}
                        disabled={saving}
                        onChange={(value) => set("runBudgetUsd", value)}
                      />
                      <LimitField
                        id="run-budget-tokens"
                        label="Token cap"
                        hint="0 = no token cap."
                        numberKey="runBudgetTokens"
                        draft={draft}
                        error={errors.runBudgetTokens}
                        disabled={saving}
                        onChange={(value) => set("runBudgetTokens", value)}
                      />
                    </div>
                  )}
                </div>

                <div>
                  <SettingsToggle
                    htmlFor="wrap-up-nudge"
                    title="Wrap-up nudge"
                    description="Once a run has used most of its time limit or budget, the agent is told once to finish its current step, verify and write its summary, so the limit rarely cuts off unfinished work. Needs the run time limit or run budget."
                  >
                    <Switch
                      id="wrap-up-nudge"
                      checked={draft.wrapUpNudge}
                      onCheckedChange={(checked) => set("wrapUpNudge", checked)}
                      disabled={saving}
                    />
                  </SettingsToggle>
                  {draft.wrapUpNudge && (
                    <div className="animate-fade-in-soft pb-4 sm:max-w-xs sm:pb-5">
                      <LimitField
                        id="wrap-up-percent"
                        label="Nudge at (% used)"
                        hint={`Share of the time limit or budget used, whichever comes first (${ORCHESTRATION_LIMITS.wrapUpPercent.min}–${ORCHESTRATION_LIMITS.wrapUpPercent.max} %).`}
                        numberKey="wrapUpPercent"
                        draft={draft}
                        error={errors.wrapUpPercent}
                        disabled={saving}
                        onChange={(value) => set("wrapUpPercent", value)}
                      />
                    </div>
                  )}
                </div>
              </SettingsRows>
            </SettingsGroup>

            <SettingsGroup title="Agent behavior">
              <SettingsRows>
                <SettingsToggle
                  htmlFor="loop-detection"
                  title="Loop detection"
                  description="Warns an agent that repeats the same tool call or failing action, or ping-pongs between two calls. If it keeps looping, the run stops without an automatic retry."
                >
                  <Switch
                    id="loop-detection"
                    checked={draft.loopDetection}
                    onCheckedChange={(checked) => set("loopDetection", checked)}
                    disabled={saving}
                  />
                </SettingsToggle>

                <SettingsToggle
                  htmlFor="git-checkpoints"
                  title="Git checkpoints"
                  description="Snapshots the run's git folders (untracked files too) before each run without touching your working tree, so you can restore the card's changes from the card."
                >
                  <Switch
                    id="git-checkpoints"
                    checked={draft.gitCheckpoints}
                    onCheckedChange={(checked) => set("gitCheckpoints", checked)}
                    disabled={saving}
                  />
                </SettingsToggle>
              </SettingsRows>
            </SettingsGroup>

            <SettingsGroup title="Subagents & context">
              <SettingsRows>
                <div>
                  <SettingsToggle
                    htmlFor="subagent-limits"
                    title="Subagent limits"
                    description="Caps the subagents each run delegates to: how many work at once (scaled down to the run's fair share of this machine's cores and memory), how deep they may nest, and how long each may take. Applies to runs started after saving."
                  >
                    <Switch
                      id="subagent-limits"
                      checked={draft.subagentLimits}
                      onCheckedChange={(checked) => set("subagentLimits", checked)}
                      disabled={saving}
                    />
                  </SettingsToggle>
                  {draft.subagentLimits && (
                    <div className="animate-fade-in-soft grid grid-cols-1 gap-5 pb-4 sm:grid-cols-3 sm:pb-5">
                      <LimitField
                        id="subagent-max-concurrency"
                        label="Max at once"
                        hint={`Per run (${ORCHESTRATION_LIMITS.subagentMaxConcurrency.min}–${ORCHESTRATION_LIMITS.subagentMaxConcurrency.max}).`}
                        numberKey="subagentMaxConcurrency"
                        draft={draft}
                        error={errors.subagentMaxConcurrency}
                        disabled={saving}
                        onChange={(value) => set("subagentMaxConcurrency", value)}
                      />
                      <LimitField
                        id="subagent-max-depth"
                        label="Max depth"
                        hint={`1 = subagents cannot delegate further (${ORCHESTRATION_LIMITS.subagentMaxDepth.min}–${ORCHESTRATION_LIMITS.subagentMaxDepth.max}).`}
                        numberKey="subagentMaxDepth"
                        draft={draft}
                        error={errors.subagentMaxDepth}
                        disabled={saving}
                        onChange={(value) => set("subagentMaxDepth", value)}
                      />
                      <LimitField
                        id="subagent-timeout-minutes"
                        label="Time limit (minutes)"
                        hint={`0 = no limit (${ORCHESTRATION_LIMITS.subagentTimeoutMinutes.min}–${ORCHESTRATION_LIMITS.subagentTimeoutMinutes.max} min).`}
                        numberKey="subagentTimeoutMinutes"
                        draft={draft}
                        error={errors.subagentTimeoutMinutes}
                        disabled={saving}
                        onChange={(value) => set("subagentTimeoutMinutes", value)}
                      />
                    </div>
                  )}
                </div>

                <div>
                  <SettingsToggle
                    htmlFor="context-compaction"
                    title="Early context compaction"
                    description="Compacts an agent's context once it fills this share of the model's window, so every model request resends fewer tokens. Applies to runs started after saving."
                  >
                    <Switch
                      id="context-compaction"
                      checked={draft.contextCompaction}
                      onCheckedChange={(checked) => set("contextCompaction", checked)}
                      disabled={saving}
                    />
                  </SettingsToggle>
                  {draft.contextCompaction && (
                    <div className="animate-fade-in-soft pb-4 sm:max-w-xs sm:pb-5">
                      <LimitField
                        id="context-compact-percent"
                        label="Compact at (% of window)"
                        hint={`Share of the model's context window (${ORCHESTRATION_LIMITS.contextCompactPercent.min}–${ORCHESTRATION_LIMITS.contextCompactPercent.max} %).`}
                        numberKey="contextCompactPercent"
                        draft={draft}
                        error={errors.contextCompactPercent}
                        disabled={saving}
                        onChange={(value) => set("contextCompactPercent", value)}
                      />
                    </div>
                  )}
                </div>
              </SettingsRows>
            </SettingsGroup>

            <SettingsGroup title="Resources">
              <div>
                <SettingsToggle
                  htmlFor="load-guard"
                  title="Load guard"
                  description="Holds queued cards (starts no new runs) while the server is overloaded; running agents keep going and queued cards start once the load drops."
                >
                  <Switch
                    id="load-guard"
                    checked={draft.loadGuard}
                    onCheckedChange={(checked) => set("loadGuard", checked)}
                    disabled={saving}
                  />
                </SettingsToggle>
                {draft.loadGuard && (
                  <div className="animate-fade-in-soft pb-1 sm:max-w-xs">
                    <LimitField
                      id="load-guard-percent"
                      label="Max load (%)"
                      hint={`1-minute load average per CPU core; 100 % = all cores busy (${ORCHESTRATION_LIMITS.loadGuardPercent.min}–${ORCHESTRATION_LIMITS.loadGuardPercent.max} %).`}
                      numberKey="loadGuardPercent"
                      draft={draft}
                      error={errors.loadGuardPercent}
                      disabled={saving}
                      onChange={(value) => set("loadGuardPercent", value)}
                    />
                  </div>
                )}
              </div>
            </SettingsGroup>

            <SettingsGroup title="Telemetry">
              <div>
                <SettingsToggle
                  htmlFor="telemetry-export"
                  title="Export OpenTelemetry traces"
                  description="Sends each finished run as OpenTelemetry spans (GenAI conventions: model, tokens, cost, tool calls) to an OTLP/HTTP collector such as Jaeger, Langfuse or Grafana."
                >
                  <Switch
                    id="telemetry-export"
                    checked={draft.telemetryExport}
                    onCheckedChange={(checked) => set("telemetryExport", checked)}
                    disabled={saving}
                  />
                </SettingsToggle>
                {draft.telemetryExport && (
                  <div className="animate-fade-in-soft pb-1">
                    <SettingsField
                      label="Traces endpoint"
                      htmlFor="telemetry-endpoint"
                      hint={
                        <>
                          OTLP/HTTP JSON traces URL. Extra request headers (e.g. auth) come from the server&apos;s{" "}
                          <code>OTEL_EXPORTER_OTLP_HEADERS</code>.
                        </>
                      }
                      error={urlError}
                    >
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          id="telemetry-endpoint"
                          type="url"
                          inputMode="url"
                          value={draft.telemetryEndpoint}
                          onChange={(e) => set("telemetryEndpoint", e.target.value)}
                          placeholder={TELEMETRY_PLACEHOLDER}
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          aria-invalid={urlError ? true : undefined}
                          aria-describedby={urlError ? "telemetry-endpoint-error" : undefined}
                          disabled={saving}
                          className={`${FIELD} min-w-0 flex-1 font-mono`}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={sendTestSpan}
                          disabled={saving || testing || urlError !== null}
                          className={cn(FIELD, "pressable gap-2")}
                        >
                          {testing ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
                          Send test span
                        </Button>
                      </div>
                    </SettingsField>
                  </div>
                )}
              </div>
            </SettingsGroup>

            <SettingsSaveBar
              dirty={dirty}
              saving={saving}
              disabled={!dirty || !valid}
              onDiscard={() => saved && applySettings(saved)}
            />
          </SettingsPanel>
        </form>
      )}
    </SettingsSection>
  );
}
