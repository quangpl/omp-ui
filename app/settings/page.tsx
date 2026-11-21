"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArchiveRestoreIcon,
  BellIcon,
  BrainCircuitIcon,
  BrainIcon,
  BrushCleaningIcon,
  CheckIcon,
  CopyIcon,
  CpuIcon,
  ExternalLinkIcon,
  InfoIcon,
  KeyRoundIcon,
  Loader2Icon,
  MessageCircleIcon,
  NetworkIcon,
  PaletteIcon,
  PanelLeftIcon,
  RotateCcwIcon,
  ServerIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { PasswordInput } from "@/components/password-input";
import { AiProvidersSettingsSection } from "@/components/settings/ai-providers-settings";
import { AppearanceSettingsSection } from "@/components/settings/appearance-settings";
import { ChatSettingsSection } from "@/components/settings/chat-settings";
import { CleanupSettingsSection } from "@/components/settings/cleanup-settings";
import { DataTransferSettingsSection } from "@/components/settings/data-transfer-settings";
import { ClusterSettingsSection } from "@/components/settings/cluster-settings";
import { MemorySettingsSection } from "@/components/settings/memory-settings";
import { MenuSettingsSection } from "@/components/settings/menu-settings";
import { NotificationSettingsSection } from "@/components/settings/notification-settings";
import { OmpSettingsSection } from "@/components/settings/omp-settings";
import { OrchestrationSettingsSection } from "@/components/settings/orchestration-settings";
import { SettingsNav, type SettingsNavItem } from "@/components/settings/settings-nav";
import {
  SettingsField,
  SettingsGroup,
  SettingsPanel,
  SettingsRows,
  SettingsReadOnly,
  SettingsSaveBar,
  SettingsSection,
  SettingsToggle,
} from "@/components/settings/settings-section";
import { UsersSettingsSection } from "@/components/settings/users-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api, type SystemInfo } from "@/lib/api-client";
import type { AppSettings, ApprovalMode, BrowserMode, ConcurrencyInfo } from "@/lib/types";
import { cn, copyText } from "@/lib/utils";

const APPROVAL_MODES: { value: ApprovalMode; label: string; hint: string }[] = [
  {
    value: "yolo",
    label: "Yolo",
    hint: "Runs every tool without asking. Recommended: headless agents can't answer prompts.",
  },
  {
    value: "write",
    label: "Write",
    hint: "Auto-approves reads and file edits; tools that need approval are blocked.",
  },
  {
    value: "always-ask",
    label: "Always ask",
    hint: "Any tool that changes something needs approval. Unattended agents can do very little.",
  },
];

const BROWSER_OPTIONS: { value: BrowserMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Agents can't use a web browser." },
  {
    value: "headless",
    label: "Headless (invisible)",
    hint: "Agents drive an invisible browser on the server to test pages and read the web.",
  },
  {
    value: "visible",
    label: "Visible window on the server",
    hint: "Opens a browser window on the server's desktop so you can watch it.",
  },
  {
    value: "relay",
    label: "Your Chrome via omp browser-relay",
    hint: "Agents use your Chrome, logins included. Run “omp browser-relay” on the server first.",
  },
];

const SECTIONS: SettingsNavItem[] = [
  { id: "agent", label: "Agent", icon: <CpuIcon /> },
  { id: "orchestration", label: "Orchestration", icon: <ShieldCheckIcon /> },
  { id: "omp", label: "OMP", icon: <SquareTerminalIcon /> },
  { id: "ai-providers", label: "AI Providers", icon: <BrainCircuitIcon /> },
  { id: "memory", label: "Memory", icon: <BrainIcon /> },
  { id: "cleanup", label: "Data cleanup", icon: <BrushCleaningIcon /> },
  { id: "data", label: "Data transfer", icon: <ArchiveRestoreIcon /> },
  { id: "notifications", label: "Notifications", icon: <BellIcon /> },
  { id: "chat", label: "Chat", icon: <MessageCircleIcon /> },
  { id: "menu", label: "Menu", icon: <PanelLeftIcon /> },
  { id: "appearance", label: "Appearance", icon: <PaletteIcon /> },
  { id: "system", label: "System", icon: <ServerIcon /> },
  { id: "cluster", label: "Cluster", icon: <NetworkIcon /> },
  { id: "security", label: "Security", icon: <KeyRoundIcon /> },
  { id: "users", label: "Users", icon: <UsersIcon /> },
  { id: "api", label: "Mobile & API", icon: <SmartphoneIcon /> },
];

/** Sections only admins get: the agent runtime, orchestration, cleanup, data transfer, chat bots and accounts. */
const ADMIN_ONLY_SECTIONS: Record<string, true> = {
  agent: true,
  orchestration: true,
  cleanup: true,
  data: true,
  chat: true,
  users: true,
};
const USER_SECTIONS = SECTIONS.filter((section) => !ADMIN_ONLY_SECTIONS[section.id]);

const MIN_PASSWORD = 8;
/** Highest explicit agent limit the server accepts (MAX_EXPLICIT_AGENTS). */
const MAX_AGENTS = 16;
/** The server re-samples the automatic agent limit every 30 s. */
const CONCURRENCY_REFRESH_MS = 30_000;
const FIELD = "h-11 md:h-9";
const SELECT_TRIGGER = "w-full data-[size=default]:h-11 md:data-[size=default]:h-9";

type LimitMode = "auto" | "manual";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The effective agent limit from GET /queue, re-read while the page is visible. */
function useConcurrency(): [ConcurrencyInfo | null, () => void] {
  const [info, setInfo] = useState<ConcurrencyInfo | null>(null);

  const refresh = useCallback(() => {
    api.queue
      .get()
      .then((snapshot) => setInfo(snapshot.concurrency ?? null))
      .catch(() => {
        // Only feeds helper text; keep the last value.
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, CONCURRENCY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  return [info, refresh];
}

/** Two-option segmented radio group (Auto / Manual). */
function LimitModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: LimitMode;
  onChange: (mode: LimitMode) => void;
  disabled?: boolean;
}) {
  const options: { value: LimitMode; label: string }[] = [
    { value: "auto", label: "Auto" },
    { value: "manual", label: "Manual" },
  ];
  return (
    <div
      role="radiogroup"
      aria-labelledby="max-agents-label"
      className="grid w-full grid-cols-2 rounded-lg bg-muted p-1 sm:w-56"
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        const next = value === "auto" ? "manual" : "auto";
        onChange(next);
        e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus();
      }}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-10 rounded-md text-sm font-medium transition-[background-color,color,box-shadow,scale] duration-150 ease-(--ease-fluid) outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] disabled:opacity-50 motion-reduce:transition-none md:h-7",
              checked
                ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function AgentSettingsSection() {
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [limitMode, setLimitMode] = useState<LimitMode>("auto");
  const [maxAgents, setMaxAgents] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [concurrency, refreshConcurrency] = useConcurrency();

  const applySettings = useCallback((settings: AppSettings) => {
    setSaved(settings);
    setDraft(settings);
    setLimitMode(settings.maxConcurrentAgents === "auto" ? "auto" : "manual");
    setMaxAgents(settings.maxConcurrentAgents === "auto" ? "" : String(settings.maxConcurrentAgents));
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    api.settings
      .get()
      .then(applySettings)
      .catch((err) => setLoadError(errorText(err, "Could not load settings.")));
  }, [applySettings]);

  useEffect(load, [load]);

  const parsedMax = Number(maxAgents);
  const maxValid =
    limitMode === "auto" || (Number.isInteger(parsedMax) && parsedMax >= 1 && parsedMax <= MAX_AGENTS);
  const limitValue: AppSettings["maxConcurrentAgents"] = limitMode === "auto" ? "auto" : parsedMax;
  const dirty =
    saved !== null &&
    draft !== null &&
    (saved.maxConcurrentAgents !== limitValue ||
      saved.ompPath !== draft.ompPath ||
      saved.approvalMode !== draft.approvalMode ||
      saved.defaultModel !== draft.defaultModel ||
      saved.smartQueue !== draft.smartQueue ||
      saved.autoRetry !== draft.autoRetry ||
      saved.persistentRetry !== draft.persistentRetry ||
      saved.maxAutoRetries !== draft.maxAutoRetries ||
      saved.browser !== draft.browser ||
      saved.useSystemPrompt !== draft.useSystemPrompt);

  function onLimitModeChange(mode: LimitMode) {
    setLimitMode(mode);
    // Switching to a fixed limit starts from what the machine allows right now.
    if (mode === "manual" && !maxAgents) {
      setMaxAgents(String(Math.min(MAX_AGENTS, Math.max(1, concurrency?.limit ?? 2))));
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft || !dirty || saving || !maxValid) return;
    setSaving(true);
    try {
      const next = await api.settings.update({
        maxConcurrentAgents: limitValue,
        ompPath: draft.ompPath.trim(),
        approvalMode: draft.approvalMode,
        defaultModel: draft.defaultModel.trim(),
        smartQueue: draft.smartQueue,
        autoRetry: draft.autoRetry,
        persistentRetry: draft.persistentRetry,
        maxAutoRetries: draft.maxAutoRetries,
        browser: draft.browser,
        useSystemPrompt: draft.useSystemPrompt,
      });
      applySettings(next);
      refreshConcurrency();
      toast.success("Settings saved");
    } catch (err) {
      toast.error(errorText(err, "Could not save settings."));
    } finally {
      setSaving(false);
    }
  }

  const mode = APPROVAL_MODES.find((m) => m.value === draft?.approvalMode);
  const browser = BROWSER_OPTIONS.find((b) => b.value === draft?.browser);
  const limitHint =
    limitMode === "auto"
      ? concurrency?.mode === "auto"
        ? concurrency.reason
        : "Derived from this server's cores and free memory, re-checked every 30 s."
      : `Extra runs wait in a queue (1–${MAX_AGENTS}).`;

  return (
    <SettingsSection
      id="agent"
      icon={<CpuIcon />}
      title="Agent"
      description="How omp runs for every board."
    >
      {loadError ? (
        <SettingsPanel className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="flex min-w-0 flex-1 gap-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">Couldn't load agent settings</p>
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
            {[2, 1, 3].map((rows, group) => (
              <div key={group} className="space-y-5 p-4 sm:p-5">
                <Skeleton className="h-3 w-20" />
                <div className="grid gap-5 sm:grid-cols-2">
                  {Array.from({ length: rows }, (_, i) => (
                    <div key={i} className={cn("space-y-2", rows % 2 === 1 && i === rows - 1 && "sm:col-span-2")}>
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-11 w-full md:h-9" />
                      <Skeleton className="h-3 w-3/4" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SettingsPanel>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <SettingsPanel>
            <SettingsGroup title="Runtime">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <SettingsField
                  label="omp path"
                  htmlFor="omp-path"
                  hint="Executable name on PATH or absolute path."
                >
                  <Input
                    id="omp-path"
                    value={draft.ompPath}
                    onChange={(e) => setDraft({ ...draft, ompPath: e.target.value })}
                    placeholder="omp"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={saving}
                    className={`${FIELD} font-mono`}
                  />
                </SettingsField>

                <SettingsField label="Approval mode" htmlFor="approval-mode" hint={mode?.hint}>
                  <Select
                    value={draft.approvalMode}
                    onValueChange={(value) => setDraft({ ...draft, approvalMode: value as ApprovalMode })}
                    disabled={saving}
                  >
                    <SelectTrigger id="approval-mode" className={SELECT_TRIGGER}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {APPROVAL_MODES.map((m) => (
                        <SelectItem key={m.value} value={m.value} className="min-h-11 md:min-h-8">
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsField>

                <SettingsField
                  label="Browser control"
                  htmlFor="browser-mode"
                  hint={browser?.hint}
                  className="sm:col-span-2"
                >
                  <Select
                    value={draft.browser}
                    onValueChange={(value) => setDraft({ ...draft, browser: value as BrowserMode })}
                    disabled={saving}
                  >
                    <SelectTrigger id="browser-mode" className={SELECT_TRIGGER}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {BROWSER_OPTIONS.map((b) => (
                        <SelectItem key={b.value} value={b.value} className="min-h-11 md:min-h-8">
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsField>
              </div>
            </SettingsGroup>

            <SettingsGroup title="System prompt">
              <SettingsToggle
                htmlFor="use-system-prompt"
                title="Use AgentMan's system prompt"
                description="Prepend the workflow, quality gates, cleanup, summary and report instructions to every task sent to omp. When off, the task is forwarded to omp exactly as written, with nothing added."
              >
                <Switch
                  id="use-system-prompt"
                  checked={draft.useSystemPrompt}
                  onCheckedChange={(checked) => setDraft({ ...draft, useSystemPrompt: checked })}
                  disabled={saving}
                />
              </SettingsToggle>
            </SettingsGroup>

            <SettingsGroup title="Models">
              <SettingsField
                label="Default model"
                htmlFor="default-model"
                hint="Used for boards without a model. Leave empty and omp decides, from its own config (its default model role)."
              >
                <Input
                  id="default-model"
                  value={draft.defaultModel}
                  onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
                  placeholder="omp default"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={saving}
                  className={FIELD}
                />
              </SettingsField>
            </SettingsGroup>

            <SettingsGroup title="Queue">
              <SettingsField
                label="Max concurrent agents"
                labelId="max-agents-label"
                htmlFor={limitMode === "manual" ? "max-agents" : undefined}
                hint={limitHint}
                error={maxValid ? null : `Enter a whole number from 1 to ${MAX_AGENTS}.`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <LimitModeToggle value={limitMode} onChange={onLimitModeChange} disabled={saving} />
                  {limitMode === "manual" && (
                    <Input
                      id="max-agents"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_AGENTS}
                      step={1}
                      value={maxAgents}
                      onChange={(e) => setMaxAgents(e.target.value)}
                      aria-invalid={maxValid ? undefined : true}
                      disabled={saving}
                      className={`${FIELD} w-full font-mono tabular-nums sm:w-28`}
                    />
                  )}
                </div>
              </SettingsField>

              <SettingsRows>
                <SettingsToggle
                  htmlFor="smart-queue"
                  title="Smart queue"
                  description="When you add several cards, an agent orders them and links dependencies. Independent cards run in parallel; the rest wait on what they depend on."
                >
                  <Switch
                    id="smart-queue"
                    checked={draft.smartQueue}
                    onCheckedChange={(checked) => setDraft({ ...draft, smartQueue: checked })}
                    disabled={saving}
                  />
                </SettingsToggle>

                <SettingsToggle
                  htmlFor="auto-retry"
                  title="Retry failed runs automatically"
                  description="Failed or interrupted runs resume their agent session after 15 s, 30 s, 1 min… Working, queued and failed cards resume when the server restarts. A success or manual run resets the count."
                >
                  <Switch
                    id="auto-retry"
                    checked={draft.autoRetry}
                    onCheckedChange={(checked) => setDraft({ ...draft, autoRetry: checked })}
                    disabled={saving}
                  />
                </SettingsToggle>

                {draft.autoRetry && (
                  <SettingsToggle
                    htmlFor="persistent-retry"
                    title="Keep retrying until done"
                    description="Failed cards keep retrying until they're Done or you stop them. Quota and usage-limit errors wait 5, 10, 15, 30 min, then hourly (the card shows Waiting for quota); other errors retry up to 10 min apart."
                    className="animate-fade-in-soft"
                  >
                    <Switch
                      id="persistent-retry"
                      checked={draft.persistentRetry}
                      onCheckedChange={(checked) => setDraft({ ...draft, persistentRetry: checked })}
                      disabled={saving}
                    />
                  </SettingsToggle>
                )}
              </SettingsRows>

              {draft.autoRetry && (
                <SettingsField
                  label={draft.persistentRetry ? "Resumes after a server restart" : "Retries per card"}
                  htmlFor="max-auto-retries"
                  hint={
                    draft.persistentRetry
                      ? "Only limits resuming runs interrupted by a server restart; failed runs keep retrying (0–20)."
                      : "Limits all retries; then the card stays failed until you run it (0–20)."
                  }
                  className="animate-fade-in-soft sm:max-w-xs"
                >
                  <Input
                    id="max-auto-retries"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={20}
                    step={1}
                    value={draft.maxAutoRetries}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        maxAutoRetries: Math.min(20, Math.max(0, Math.floor(Number(e.target.value) || 0))),
                      })
                    }
                    disabled={saving}
                    className={`${FIELD} font-mono tabular-nums`}
                  />
                </SettingsField>
              )}
            </SettingsGroup>

            <SettingsSaveBar
              dirty={dirty}
              saving={saving}
              disabled={!dirty || !maxValid}
              onDiscard={() => saved && applySettings(saved)}
            />
          </SettingsPanel>
        </form>
      )}
    </SettingsSection>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5 sm:px-5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      {children}
    </div>
  );
}

function SystemInfoSection() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .system()
      .then(setInfo)
      .catch((err) => setError(errorText(err, "Could not load system info.")));
  }, []);

  return (
    <SettingsSection
      id="system"
      icon={<ServerIcon />}
      title="System"
      description="What this server is running."
    >
      {error ? (
        <SettingsPanel className="flex gap-3 p-4 sm:p-5">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="min-w-0 text-destructive">{error}</p>
        </SettingsPanel>
      ) : !info ? (
        <SettingsPanel>
          <div aria-busy="true" className="divide-y">
            {[24, 16, 32, 40].map((w, i) => (
              <div key={i} className="flex min-h-12 items-center justify-between gap-4 px-4 sm:px-5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        </SettingsPanel>
      ) : (
        <div className="space-y-4">
          <SettingsPanel>
            <dl className="divide-y">
              <InfoRow label="AgentMan version">
                <dd className="font-mono text-xs tabular-nums">{info.version}</dd>
              </InfoRow>
              <InfoRow label="Database">
                <dd>
                  <Badge variant="secondary">{info.db === "mongodb" ? "MongoDB" : "SQLite"}</Badge>
                </dd>
              </InfoRow>
              <InfoRow label="omp">
                <dd className="flex min-w-0 items-center gap-2">
                  {info.omp.installed ? (
                    <>
                      <span className="truncate font-mono text-xs">{info.omp.version ?? "installed"}</span>
                      <Badge className="bg-success/15 text-success">
                        <CheckIcon />
                        Installed
                      </Badge>
                    </>
                  ) : (
                    <Badge variant="destructive">Not found</Badge>
                  )}
                </dd>
              </InfoRow>
              <InfoRow label="Path">
                <dd className="min-w-0 truncate font-mono text-xs" title={info.omp.path}>
                  {info.omp.path}
                </dd>
              </InfoRow>
            </dl>
          </SettingsPanel>

          {!info.omp.installed && (
            <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
              <TriangleAlertIcon />
              <AlertTitle>omp is not installed on this server</AlertTitle>
              <AlertDescription className="text-amber-900/85 dark:text-amber-200/85 [&_p:not(:last-child)]:mb-1">
                <p>
                  Agents can't start until omp is available as{" "}
                  <code className="font-mono break-all">{info.omp.path}</code>. Install it, or set the omp path
                  in Agent settings.
                </p>
                <a
                  href="https://omp.sh/docs/quickstart"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex min-h-11 items-center gap-1 font-medium underline underline-offset-4 md:min-h-0"
                >
                  omp quickstart
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

type PasswordField = "current" | "next" | "confirm";

/** Change the signed-in account's password; `username` feeds password managers. */
function SecuritySection({ username }: { username: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  /** A validation error sits under its field; a server error (`field: null`) above the button. */
  const [error, setError] = useState<{ field: PasswordField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const fieldError = (field: PasswordField) => (error?.field === field ? error.message : null);
  const invalidProps = (field: PasswordField, id: string) =>
    error?.field === field ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    if (!current) return setError({ field: "current", message: "Enter your current password." });
    if (next.length < MIN_PASSWORD) return setError({ field: "next", message: `Use at least ${MIN_PASSWORD} characters.` });
    if (next !== confirm) return setError({ field: "confirm", message: "New passwords don't match." });
    if (next === current) return setError({ field: "next", message: "New password must differ from the current one." });

    setError(null);
    setSaving(true);
    try {
      await api.auth.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed — your other devices were signed out");
    } catch (err) {
      setError({ field: null, message: errorText(err, "Could not change the password.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      id="security"
      icon={<KeyRoundIcon />}
      title="Security"
      description="Change your password. Signs out your other devices."
    >
      <form onSubmit={onSubmit} noValidate>
        <SettingsPanel>
          <SettingsGroup>
            <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
            <SettingsField
              label="Current password"
              htmlFor="current-password"
              error={fieldError("current")}
              className="sm:max-w-sm"
            >
              <PasswordInput
                id="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                disabled={saving}
                {...invalidProps("current", "current-password")}
              />
            </SettingsField>
            <div className="grid gap-5 sm:grid-cols-2">
              <SettingsField
                label="New password"
                htmlFor="new-password"
                hint={`At least ${MIN_PASSWORD} characters.`}
                error={fieldError("next")}
              >
                <PasswordInput
                  id="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  autoComplete="new-password"
                  disabled={saving}
                  {...invalidProps("next", "new-password")}
                />
              </SettingsField>
              <SettingsField label="Confirm new password" htmlFor="confirm-password" error={fieldError("confirm")}>
                <PasswordInput
                  id="confirm-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  disabled={saving}
                  {...invalidProps("confirm", "confirm-password")}
                />
              </SettingsField>
            </div>
          </SettingsGroup>
          <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-5">
            {error && error.field === null && (
              <p role="alert" className="animate-fade-in-soft flex min-w-0 flex-1 items-start gap-2 text-sm text-destructive">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                {error.message}
              </p>
            )}
            <Button
              type="submit"
              disabled={saving || !current || !next || !confirm}
              className={cn(FIELD, "pressable w-full sm:w-auto")}
            >
              {saving && <Loader2Icon className="animate-spin" />}
              Change password
            </Button>
          </div>
        </SettingsPanel>
      </form>
    </SettingsSection>
  );
}

function ApiAccessSection() {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function onCopy() {
    try {
      await copyText(origin);
      setCopied(true);
      toast.success("Server URL copied");
    } catch {
      toast.error("Couldn't copy. Copy the URL manually.");
    }
  }

  return (
    <SettingsSection
      id="api"
      icon={<SmartphoneIcon />}
      title="Mobile & API access"
      description="Connect a phone app or script to this server."
    >
      <SettingsPanel>
        <SettingsGroup>
          <SettingsField label="Server URL" htmlFor="server-url">
            <div className="flex gap-2">
              <Input
                id="server-url"
                value={origin}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
                className={`${FIELD} min-w-0 flex-1 font-mono`}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void onCopy()}
                disabled={!origin}
                className={`${FIELD} pressable shrink-0 px-3`}
                aria-label="Copy server URL"
              >
                {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
                <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
              </Button>
            </div>
          </SettingsField>
          <div className="flex gap-2.5 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0">
              Clients sign in with this URL and a username (or email) and password:{" "}
              <code className="rounded bg-background px-1 py-0.5 font-mono text-xs break-all text-foreground">
                POST /api/v1/auth/login
              </code>{" "}
              with a JSON body{" "}
              <code className="rounded bg-background px-1 py-0.5 font-mono text-xs break-all text-foreground">
                {'{ "username": "…", "password": "…" }'}
              </code>{" "}
              returns a token; send it as{" "}
              <code className="rounded bg-background px-1 py-0.5 font-mono text-xs break-all text-foreground">
                Authorization: Bearer &lt;token&gt;
              </code>
              . Reference: <code className="font-mono text-xs text-foreground">docs/API.md</code> in the AgentMan
              repository.
            </p>
          </div>
        </SettingsGroup>
      </SettingsPanel>
    </SettingsSection>
  );
}

export default function SettingsPage() {
  useDocumentTitle("Settings");
  const { user, loading, isAdmin } = useCurrentUser();
  const readOnly = !isAdmin;
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Settings" backHref="/" />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 gap-6 px-4 py-6 sm:px-6 md:py-8 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10 lg:px-8 xl:grid-cols-[14rem_minmax(0,1fr)] xl:gap-14">
          {loading ? (
            // Which sections show (and which are read-only) depends on the role; wait for it.
            <div aria-busy="true" aria-label="Loading settings" className="min-w-0 max-w-3xl space-y-4 lg:col-start-2">
              <div className="flex items-start gap-3">
                <Skeleton className="size-8 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-4 w-72 max-w-full" />
                </div>
              </div>
              <Skeleton className="h-48 rounded-xl" />
            </div>
          ) : (
            <>
              {/* SettingsNav reads its items once: remount it when the role changes. */}
              <SettingsNav key={isAdmin ? "admin" : "user"} items={isAdmin ? SECTIONS : USER_SECTIONS} />
              <div
                className={cn(
                  "min-w-0 max-w-3xl space-y-10 md:space-y-12",
                  "[&>section+section]:border-t [&>section+section]:pt-10 md:[&>section+section]:pt-12",
                  "[&>section]:animate-card-in motion-reduce:[&>section]:animate-none",
                  "[&>section:nth-child(2)]:[--stagger:2] [&>section:nth-child(3)]:[--stagger:4] [&>section:nth-child(4)]:[--stagger:6] [&>section:nth-child(5)]:[--stagger:8] [&>section:nth-child(6)]:[--stagger:10] [&>section:nth-child(7)]:[--stagger:12] [&>section:nth-child(8)]:[--stagger:14] [&>section:nth-child(9)]:[--stagger:16] [&>section:nth-child(10)]:[--stagger:18] [&>section:nth-child(11)]:[--stagger:20] [&>section:nth-child(12)]:[--stagger:22] [&>section:nth-child(13)]:[--stagger:24] [&>section:nth-child(14)]:[--stagger:26] [&>section:nth-child(15)]:[--stagger:28]",
                )}
              >
                {isAdmin && <AgentSettingsSection />}
                {isAdmin && <OrchestrationSettingsSection />}
                <SettingsReadOnly value={readOnly}>
                  <OmpSettingsSection />
                  <AiProvidersSettingsSection />
                  <MemorySettingsSection />
                </SettingsReadOnly>
                {isAdmin && <CleanupSettingsSection />}
                {isAdmin && <DataTransferSettingsSection />}
                <SettingsReadOnly value={readOnly}>
                  <NotificationSettingsSection />
                </SettingsReadOnly>
                {isAdmin && <ChatSettingsSection />}
                <SettingsReadOnly value={readOnly}>
                  <MenuSettingsSection />
                  <AppearanceSettingsSection />
                </SettingsReadOnly>
                <SystemInfoSection />
                {/* Everyone sees the cluster's state; changing it is for admins. */}
                <SettingsReadOnly value={readOnly}>
                  <ClusterSettingsSection />
                </SettingsReadOnly>
                <SecuritySection username={user?.username ?? ""} />
                {isAdmin && <UsersSettingsSection />}
                <ApiAccessSection />
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
