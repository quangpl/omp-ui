"use client";

import { useEffect, useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  CpuIcon,
  ExternalLinkIcon,
  InfoIcon,
  KeyRoundIcon,
  Loader2Icon,
  ServerIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, type SystemInfo } from "@/lib/api-client";
import type { AppSettings, ApprovalMode, BrowserMode } from "@/lib/types";
import { copyText } from "@/lib/utils";

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
    hint: "Every tool that changes something needs approval, so agents can do very little unattended.",
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
    hint: "The browser window opens on the server's desktop, so you can watch it work.",
  },
  {
    value: "relay",
    label: "Your Chrome via omp browser-relay",
    hint: "Agents use your own Chrome (logins included); run “omp browser-relay” on the server first.",
  },
];

const MIN_PASSWORD = 8;
const FIELD = "h-11 md:h-9";

function SectionHeader({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <CardHeader className="flex items-start gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 space-y-1">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
    </CardHeader>
  );
}

function AgentSettingsCard() {
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [maxAgents, setMaxAgents] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings
      .get()
      .then((settings) => {
        setSaved(settings);
        setDraft(settings);
        setMaxAgents(String(settings.maxConcurrentAgents));
      })
      .catch((err) =>
        setLoadError(err instanceof Error && err.message ? err.message : "Could not load settings."),
      );
  }, []);

  const parsedMax = Number(maxAgents);
  const maxValid = Number.isInteger(parsedMax) && parsedMax >= 1 && parsedMax <= 16;
  const dirty =
    saved !== null &&
    draft !== null &&
    (String(saved.maxConcurrentAgents) !== maxAgents ||
      saved.ompPath !== draft.ompPath ||
      saved.approvalMode !== draft.approvalMode ||
      saved.defaultModel !== draft.defaultModel ||
      saved.autoModel !== draft.autoModel ||
      saved.browser !== draft.browser);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft || !dirty || saving || !maxValid) return;
    setSaving(true);
    try {
      const next = await api.settings.update({
        maxConcurrentAgents: parsedMax,
        ompPath: draft.ompPath.trim(),
        approvalMode: draft.approvalMode,
        defaultModel: draft.defaultModel.trim(),
        autoModel: draft.autoModel,
        browser: draft.browser,
      });
      setSaved(next);
      setDraft(next);
      setMaxAgents(String(next.maxConcurrentAgents));
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  }

  const mode = APPROVAL_MODES.find((m) => m.value === draft?.approvalMode);
  const browser = BROWSER_OPTIONS.find((b) => b.value === draft?.browser);

  return (
    <Card>
      <SectionHeader
        icon={<CpuIcon />}
        title="Agent"
        description="How omp is launched for every board."
      />
      {loadError ? (
        <CardContent>
          <p className="text-sm text-destructive">{loadError}</p>
        </CardContent>
      ) : !draft ? (
        <CardContent className="space-y-5" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-11 w-full md:h-9" />
            </div>
          ))}
        </CardContent>
      ) : (
        <form onSubmit={onSubmit} noValidate className="contents">
          <CardContent className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="max-agents">Max concurrent agents</Label>
              <Input
                id="max-agents"
                type="number"
                inputMode="numeric"
                min={1}
                max={16}
                step={1}
                value={maxAgents}
                onChange={(e) => setMaxAgents(e.target.value)}
                aria-invalid={maxValid ? undefined : true}
                disabled={saving}
                className={FIELD}
              />
              <p className={maxValid ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
                {maxValid ? "Extra runs wait in a queue." : "Enter a whole number from 1 to 16."}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="omp-path">omp path</Label>
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
              <p className="text-xs text-muted-foreground">Executable name on PATH or absolute path.</p>
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="approval-mode">Approval mode</Label>
              <Select
                value={draft.approvalMode}
                onValueChange={(value) => setDraft({ ...draft, approvalMode: value as ApprovalMode })}
                disabled={saving}
              >
                <SelectTrigger
                  id="approval-mode"
                  className="w-full data-[size=default]:h-11 md:data-[size=default]:h-9"
                >
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
              {mode && <p className="text-xs text-muted-foreground">{mode.hint}</p>}
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="default-model">Default model</Label>
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
              <p className="text-xs text-muted-foreground">
                Used when a board has no model of its own. Leave empty for omp's default.
              </p>
            </div>

            <label htmlFor="auto-model" className="flex min-h-12 cursor-pointer items-center gap-4 sm:col-span-2">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Auto-select model per card</span>
                <span className="block text-xs text-muted-foreground">
                  On boards without a model, each run picks one from the card: omp's <code>smol</code> role for
                  small edits, <code>slow</code> for debugging, performance, security and architecture work,{" "}
                  <code>designer</code> (if configured) for UI work, the default model otherwise.
                </span>
              </span>
              <Switch
                id="auto-model"
                checked={draft.autoModel}
                onCheckedChange={(checked) => setDraft({ ...draft, autoModel: checked })}
                disabled={saving}
              />
            </label>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="browser-mode">Browser control</Label>
              <Select
                value={draft.browser}
                onValueChange={(value) => setDraft({ ...draft, browser: value as BrowserMode })}
                disabled={saving}
              >
                <SelectTrigger
                  id="browser-mode"
                  className="w-full data-[size=default]:h-11 md:data-[size=default]:h-9"
                >
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
              {browser && <p className="text-xs text-muted-foreground">{browser.hint}</p>}
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setDraft(saved);
                  setMaxAgents(String(saved?.maxConcurrentAgents ?? ""));
                }}
                className={FIELD}
              >
                Discard
              </Button>
            )}
            <Button
              type="submit"
              disabled={!dirty || saving || !maxValid}
              className={`${FIELD} flex-1 sm:flex-none`}
            >
              {saving && <Loader2Icon className="animate-spin" />}
              Save changes
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}

function SystemInfoCard() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .system()
      .then(setInfo)
      .catch((err) =>
        setError(err instanceof Error && err.message ? err.message : "Could not load system info."),
      );
  }, []);

  return (
    <Card>
      <SectionHeader
        icon={<ServerIcon />}
        title="System"
        description="What this server is running."
      />
      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !info ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
          </div>
        ) : (
          <>
            <dl className="divide-y rounded-lg border text-sm">
              <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                <dt className="text-muted-foreground">OMP UI version</dt>
                <dd className="font-mono text-xs">{info.version}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                <dt className="text-muted-foreground">Database</dt>
                <dd>
                  <Badge variant="secondary">{info.db === "mongodb" ? "MongoDB" : "SQLite"}</Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                <dt className="text-muted-foreground">omp</dt>
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
              </div>
              <div className="flex items-center justify-between gap-4 px-3 py-2.5">
                <dt className="shrink-0 text-muted-foreground">Path</dt>
                <dd className="min-w-0 truncate font-mono text-xs" title={info.omp.path}>
                  {info.omp.path}
                </dd>
              </div>
            </dl>

            {!info.omp.installed && (
              <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
                <TriangleAlertIcon />
                <AlertTitle>omp is not installed on this server</AlertTitle>
                <AlertDescription className="text-amber-900/85 dark:text-amber-200/85 [&_p:not(:last-child)]:mb-1">
                  <p>
                    Agents can't start until omp is available as{" "}
                    <code className="font-mono break-all">{info.omp.path}</code>. Install it, or set the omp
                    path above.
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
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SecurityCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    if (!current) return setError("Enter your current password.");
    if (next.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (next !== confirm) return setError("New passwords don't match.");
    if (next === current) return setError("Pick a password different from the current one.");

    setError(null);
    setSaving(true);
    try {
      await api.auth.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed — other devices were signed out");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not change the password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <SectionHeader
        icon={<KeyRoundIcon />}
        title="Security"
        description="Change the admin password. Every other signed-in device is signed out."
      />
      <form onSubmit={onSubmit} noValidate className="contents">
        <CardContent className="space-y-4">
          <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
          <div className="space-y-2">
            <Label htmlFor="current-password">Current password</Label>
            <PasswordInput
              id="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              disabled={saving}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <PasswordInput
                id="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <PasswordInput
                id="confirm-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                disabled={saving}
              />
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">At least {MIN_PASSWORD} characters.</p>
          )}
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            type="submit"
            disabled={saving || !current || !next || !confirm}
            className={`${FIELD} flex-1 sm:flex-none`}
          >
            {saving && <Loader2Icon className="animate-spin" />}
            Change password
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function ApiAccessCard() {
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
      toast.error("Couldn't copy. Select the URL and copy it manually.");
    }
  }

  return (
    <Card>
      <SectionHeader
        icon={<SmartphoneIcon />}
        title="Mobile & API access"
        description="Connect a phone app or script to this server."
      />
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="server-url">Server URL</Label>
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
              className={`${FIELD} shrink-0 px-3`}
              aria-label="Copy server URL"
            >
              {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
              <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>
        </div>
        <div className="flex gap-2.5 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
          <InfoIcon className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0">
            A mobile or API client signs in with this URL and the admin password:{" "}
            <code className="rounded bg-background px-1 py-0.5 font-mono text-xs break-all text-foreground">
              POST /api/v1/auth/login
            </code>{" "}
            returns a token to send as{" "}
            <code className="rounded bg-background px-1 py-0.5 font-mono text-xs break-all text-foreground">
              Authorization: Bearer &lt;token&gt;
            </code>
            . Full reference: <code className="font-mono text-xs text-foreground">docs/API.md</code> in
            the OMP UI repository.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Settings" backHref="/" />
      <main className="px-safe pb-safe mx-auto w-full max-w-2xl flex-1">
        <div className="space-y-4 px-4 py-5 sm:px-6 sm:py-8">
          <AgentSettingsCard />
          <SystemInfoCard />
          <SecurityCard />
          <ApiAccessCard />
        </div>
      </main>
    </div>
  );
}
