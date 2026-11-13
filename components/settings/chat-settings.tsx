"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MessageCircleIcon,
  MessagesSquareIcon,
  PlugIcon,
  RotateCcwIcon,
  SendIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PasswordInput } from "@/components/password-input";
import { SettingsField, SettingsGroup, SettingsPanel, SettingsSection } from "@/components/settings/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { CHAT_PLATFORMS, type ChatPlatform, type ChatPlatformStatus, type ChatStatusResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

const FIELD = "h-11 md:h-9";
/** How often the section re-reads GET /chat/status while mounted. */
const POLL_MS = 5_000;

const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs break-all text-foreground";
const LINK = "font-medium text-foreground underline underline-offset-4 hover:text-primary";

/** The chat commands, identical on Telegram and Discord (lib/server/chat/commands.ts). */
const COMMANDS: { usage: string; description: string }[] = [
  { usage: "/login <password>", description: "Unlock control with the admin password" },
  { usage: "/boards", description: "List the projects" },
  { usage: "/board <name>", description: "Pick the project /create adds cards to" },
  { usage: "/create <title>", description: "Add a To do card; replies with its id" },
  { usage: "/status [board]", description: "Cards and running agents" },
  { usage: "/run <cardId>", description: "Start a card's agent; its output streams here" },
  { usage: "/stop <cardId>", description: "Stop a card's agent" },
  { usage: "/help", description: "Show the commands" },
];

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Per-platform copy: name, icon, token placeholder, bot link label and setup steps. */
const PLATFORMS: Record<
  ChatPlatform,
  { label: string; icon: React.ReactNode; placeholder: string; openLabel: string; steps: React.ReactNode[] }
> = {
  telegram: {
    label: "Telegram",
    icon: <SendIcon />,
    placeholder: "123456789:AA…",
    openLabel: "Open bot",
    steps: [
      <>
        Open{" "}
        <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className={LINK}>
          @BotFather
        </a>{" "}
        and send <code className={CODE}>/newbot</code>.
      </>,
      <>Copy the token it gives you, paste it here and click Connect.</>,
      <>
        Open your bot and send <code className={CODE}>/login &lt;admin password&gt;</code>; it answers
        &ldquo;AgentMan connected&rdquo;.
      </>,
    ],
  },
  discord: {
    label: "Discord",
    icon: <MessagesSquareIcon />,
    placeholder: "Paste the bot token",
    openLabel: "Add to server",
    steps: [
      <>
        Create an application at{" "}
        <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className={LINK}>
          discord.com/developers
        </a>
        , open Bot, click Reset Token and copy it.
      </>,
      <>
        Under Bot, turn on <span className="font-medium text-foreground">Message Content Intent</span> (needed to
        read server messages).
      </>,
      <>Paste the token here and click Connect; the bot sends you a DM.</>,
      <>
        Use &ldquo;Add to server&rdquo; or DM the bot, then send{" "}
        <code className={CODE}>/login &lt;admin password&gt;</code>.
      </>,
    ],
  },
};

/** Connection state as a badge: Connected, Connecting…, Error or Not connected. */
function StateBadge({ status }: { status: ChatPlatformStatus }) {
  switch (status.state) {
    case "connected":
      return (
        <Badge className="bg-success/15 text-success">
          <CheckIcon />
          Connected
        </Badge>
      );
    case "connecting":
      return (
        <Badge className="bg-primary/10 text-primary">
          <Loader2Icon className="animate-spin" />
          Connecting…
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive">
          <TriangleAlertIcon />
          Error
        </Badge>
      );
    default:
      return <Badge className="bg-muted text-muted-foreground">Not connected</Badge>;
  }
}

/** How the bot receives messages, as one short line. */
function modeText(status: ChatPlatformStatus): string | null {
  switch (status.mode) {
    case "polling":
      return "Long polling";
    case "webhook":
      return status.webhookUrl ? `Webhook: ${status.webhookUrl}` : "Webhook";
    case "gateway":
      return "Gateway";
    default:
      return null;
  }
}

/** One platform: state, bot details, token form (Connect / Reconnect, Disconnect) and setup steps. */
function ChatPlatformPanel({
  status,
  onChange,
}: {
  status: ChatPlatformStatus;
  onChange: (status: ChatPlatformStatus) => void;
}) {
  const { platform } = status;
  const meta = PLATFORMS[platform];
  const id = useId();
  const tokenId = `${id}-token`;
  const webhookId = `${id}-webhook`;
  const [token, setToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmed = token.trim();
  const authorized = status.authorizedUsers;
  const mode = modeText(status);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || pending) return;
    setPending("connect");
    setError(null);
    try {
      const next = await api.chat.connect(
        platform,
        platform === "telegram" ? { token: trimmed, webhookUrl: webhookUrl.trim() || null } : { token: trimmed },
      );
      onChange(next);
      setToken("");
      if (next.state === "connected") toast.success(`${meta.label} bot connected`);
      else if (next.error) toast.error(next.error);
    } catch (err) {
      const message = errorText(err, `Could not connect the ${meta.label} bot.`);
      setError(message);
      toast.error(message);
    } finally {
      setPending(null);
    }
  }

  async function disconnect() {
    if (pending) return;
    setPending("disconnect");
    setError(null);
    try {
      onChange(await api.chat.disconnect(platform));
      toast.success(`${meta.label} bot disconnected`);
    } catch (err) {
      toast.error(errorText(err, `Could not disconnect the ${meta.label} bot.`));
    } finally {
      setPending(null);
    }
  }

  return (
    <SettingsPanel>
      <SettingsGroup className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg]:size-4">
            {meta.icon}
          </span>
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{meta.label}</h3>
          <StateBadge status={status} />
        </div>

        {status.configured && (
          <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 space-y-0.5">
              {status.bot ? (
                <p className="truncate font-medium">
                  {status.bot.name}
                  {status.bot.username && (
                    <span className="ml-1.5 font-normal text-muted-foreground">@{status.bot.username}</span>
                  )}
                </p>
              ) : (
                <p className="font-medium">Bot token saved</p>
              )}
              <p className="text-xs text-pretty text-muted-foreground">
                {authorized} authorized {authorized === 1 ? "user" : "users"}
                {status.tokenHint && (
                  <>
                    {" · "}token <span className="font-mono">••••{status.tokenHint}</span>
                  </>
                )}
                {mode && <span className="break-all">{` · ${mode}`}</span>}
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
              {status.botUrl && (
                <Button asChild variant="outline" className={cn(FIELD, "pressable gap-2")}>
                  <a href={status.botUrl} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon />
                    {meta.openLabel}
                  </a>
                </Button>
              )}
              <Button
                type="button"
                variant="destructive"
                onClick={() => void disconnect()}
                disabled={pending !== null}
                className={cn(FIELD, "pressable gap-2")}
              >
                {pending === "disconnect" ? <Loader2Icon className="animate-spin" /> : <UnplugIcon />}
                Disconnect
              </Button>
            </div>
          </div>
        )}

        {status.error && (
          <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
            <TriangleAlertIcon />
            <AlertTitle>{meta.label} bot problem</AlertTitle>
            <AlertDescription className="text-amber-900/85 dark:text-amber-200/85">
              <p className="break-words">{status.error}</p>
            </AlertDescription>
          </Alert>
        )}

        <form onSubmit={(e) => void connect(e)} noValidate className="space-y-3">
          <SettingsField
            label={status.configured ? "New bot token" : "Bot token"}
            htmlFor={tokenId}
            error={error}
            hint={status.configured ? "Paste a new token to replace the saved one." : undefined}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="min-w-0 flex-1">
                <PasswordInput
                  id={tokenId}
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setError(null);
                  }}
                  placeholder={meta.placeholder}
                  autoComplete="off"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${tokenId}-error` : undefined}
                  className="font-mono"
                />
              </div>
              <Button
                type="submit"
                disabled={!trimmed || pending !== null}
                className={cn(FIELD, "pressable shrink-0 gap-2 sm:min-w-28")}
              >
                {pending === "connect" ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
                {status.configured && trimmed ? "Reconnect" : "Connect"}
              </Button>
            </div>
          </SettingsField>

          {platform === "telegram" && (
            <details className="group text-sm">
              <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground select-none hover:text-foreground md:min-h-8 [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                Advanced
              </summary>
              <SettingsField
                label="Public webhook URL"
                htmlFor={webhookId}
                hint="Leave empty to use long polling (works behind NAT)."
                className="pt-2"
              >
                <Input
                  id={webhookId}
                  type="url"
                  inputMode="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://agentman.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(FIELD, "font-mono")}
                />
              </SettingsField>
            </details>
          )}
        </form>
      </SettingsGroup>

      <SettingsGroup title="Setup" className="space-y-3">
        <ol className="list-decimal space-y-1.5 pl-5 text-xs text-pretty text-muted-foreground marker:text-muted-foreground">
          {meta.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </SettingsGroup>
    </SettingsPanel>
  );
}

/**
 * Settings → Chat integrations: connect a Telegram and/or Discord bot by pasting its token. The
 * admin then controls AgentMan from chat (create cards, status, run/stop agents with streamed
 * output) after `/login <admin password>`. Status is re-read every 5 s while mounted.
 */
export function ChatSettingsSection() {
  const [status, setStatus] = useState<ChatStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.chat.status());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, "Could not load the chat integrations."));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function retry() {
    setRetrying(true);
    await refresh();
    setRetrying(false);
  }

  const onChange = useCallback(
    (next: ChatPlatformStatus) => {
      setStatus((prev) => (prev ? { ...prev, [next.platform]: next } : prev));
      void refresh();
    },
    [refresh],
  );

  return (
    <SettingsSection
      id="chat"
      icon={<MessageCircleIcon />}
      title="Chat integrations"
      description="Control AgentMan from Telegram or Discord: create cards, check status, start and stop agents, and get their output streamed to the chat."
    >
      {loadError && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-destructive" role="alert">
          <span className="flex min-w-0 items-center gap-1.5">
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            <span className="break-words">{loadError}</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void retry()}
            disabled={retrying}
            className="pressable h-9 gap-1.5 md:h-7"
          >
            {retrying ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />}
            Retry
          </Button>
        </div>
      )}

      {status ? (
        CHAT_PLATFORMS.map((platform) => (
          <ChatPlatformPanel key={platform} status={status[platform]} onChange={onChange} />
        ))
      ) : loadError ? null : (
        CHAT_PLATFORMS.map((platform) => (
          <SettingsPanel key={platform}>
            <div aria-busy="true" className="space-y-4 p-4 sm:p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-lg" />
                <Skeleton className="h-3.5 w-24 flex-1" />
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
              <Skeleton className="h-3 w-20" />
              <div className="flex gap-2">
                <Skeleton className="h-11 flex-1 md:h-9" />
                <Skeleton className="h-11 w-28 md:h-9" />
              </div>
              <Skeleton className="h-3 w-full max-w-md" />
            </div>
          </SettingsPanel>
        ))
      )}

      <SettingsPanel>
        <SettingsGroup title="Commands" className="space-y-3">
          <ul className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
            {COMMANDS.map((command) => (
              <li key={command.usage} className="flex min-w-0 flex-col gap-0.5">
                <code className="font-mono text-foreground">{command.usage}</code>
                <span className="text-pretty text-muted-foreground">{command.description}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-pretty text-muted-foreground">
            The same commands work on Telegram and Discord. Only someone who knows the admin password can control
            AgentMan. Changing the password logs every chat out.
          </p>
        </SettingsGroup>
      </SettingsPanel>
    </SettingsSection>
  );
}
