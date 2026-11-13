"use client";

import { useEffect, useRef, useState } from "react";
import { ActivityIcon, CircleAlertIcon, Loader2Icon, PlayIcon, SmartphoneIcon } from "lucide-react";
import { LogoMark } from "@/components/app-header";
import { PasswordInput } from "@/components/password-input";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type Mode = "loading" | "setup" | "login";

const CAPABILITIES = [
  {
    icon: PlayIcon,
    title: "Write a card, press Start",
    body: "An omp agent does the work in your project folder.",
  },
  {
    icon: ActivityIcon,
    title: "Watch and steer live",
    body: "Follow tool calls as they happen. Comment to redirect the agent.",
  },
  {
    icon: SmartphoneIcon,
    title: "Self-hosted, phone-ready",
    body: "Runs on your machine or server. Use it from any device on your network.",
  },
] as const;

const MIN_PASSWORD = 8;

/** Only same-origin absolute paths are allowed as redirect targets. */
function nextTarget(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/api/")) return "/";
  return next;
}

export default function LoginPage() {
  useDocumentTitle("Sign in");
  const [mode, setMode] = useState<Mode>("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.auth
      .status()
      .then((status) => {
        if (cancelled) return;
        if (status.authenticated) {
          window.location.replace(nextTarget());
          return;
        }
        setMode(status.configured ? "login" : "setup");
      })
      .catch(() => {
        if (!cancelled) setMode("login");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (mode !== "loading") passwordRef.current?.focus();
  }, [mode]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    if (mode === "setup") {
      if (password.length < MIN_PASSWORD) {
        setError(`Use at least ${MIN_PASSWORD} characters.`);
        return;
      }
      if (password !== confirm) {
        setError("Passwords don't match.");
        return;
      }
    } else if (!password) {
      setError("Enter the admin password.");
      return;
    }

    setSubmitting(true);
    try {
      if (mode === "setup") await api.auth.setup(password);
      else await api.auth.login(password);
      window.location.replace(nextTarget());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Something went wrong. Try again.");
      setSubmitting(false);
      passwordRef.current?.select();
    }
  }

  const isSetup = mode === "setup";

  return (
    <main className="pt-safe pb-safe px-safe grid min-h-dvh md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      {/* Brand panel: md+ only, so phones get the form first. */}
      <aside
        aria-label="About AgentMan"
        className={cn(
          "relative hidden overflow-hidden border-r bg-muted/40 md:flex md:flex-col md:justify-between md:gap-10 md:p-10 lg:p-14",
          // Subtle dotted floor-plan texture, faded toward the bottom.
          "before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_1px_1px,color-mix(in_oklch,var(--color-foreground)_10%,transparent)_1px,transparent_0)] before:[background-size:20px_20px] before:[mask-image:linear-gradient(to_bottom,black,transparent_80%)]",
        )}
      >
        <div className="relative flex items-center gap-2.5">
          <LogoMark className="size-8" />
          <span className="text-base font-semibold tracking-tight">AgentMan</span>
        </div>

        <div className="relative max-w-md space-y-10">
          <p className="text-3xl leading-tight font-semibold tracking-tight text-balance lg:text-4xl">
            A self-hosted kanban board where coding agents do the work.
          </p>
          <ul className="space-y-6">
            {CAPABILITIES.map(({ icon: Icon, title, body }, i) => (
              <li
                key={title}
                className="animate-card-in flex gap-4"
                style={{ "--stagger": i + 1 } as React.CSSProperties}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-primary ring-1 ring-foreground/10">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{title}</p>
                  <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-muted-foreground">
          Powered by <span className="font-mono">omp</span> coding agents.
        </p>
      </aside>

      <div className="flex min-w-0 flex-col">
        <div className="flex items-center justify-between gap-2 p-2 pl-4 md:justify-end">
          <div className="flex items-center gap-2 md:hidden">
            <LogoMark className="size-7" />
            <span className="text-sm font-semibold tracking-tight">AgentMan</span>
          </div>
          <ThemeToggle />
        </div>

        <div className="flex flex-1 flex-col justify-center px-4 pt-6 pb-16 sm:px-6 md:px-12 lg:px-16 xl:px-24">
          <div className="animate-page-in mx-auto w-full max-w-sm md:mx-0">
            <div className="mb-8 space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                {isSetup ? "Welcome to AgentMan" : "Sign in to AgentMan"}
              </h1>
              <p className="text-sm text-muted-foreground">
                {mode === "loading"
                  ? "Checking your session…"
                  : isSetup
                    ? "Set an admin password to protect this server."
                    : "Enter the admin password to continue."}
              </p>
            </div>

            {mode === "loading" ? (
              <div className="space-y-5" aria-hidden="true">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-11 w-full md:h-9" />
                </div>
                <Skeleton className="h-12 w-full md:h-10" />
              </div>
            ) : (
              <form onSubmit={onSubmit} noValidate aria-busy={submitting || undefined} className="space-y-5">
                {/* Helps password managers associate the credential with this server. */}
                <input
                  type="text"
                  name="username"
                  autoComplete="username"
                  value="admin"
                  readOnly
                  hidden
                />
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password">{isSetup ? "New admin password" : "Password"}</Label>
                  <PasswordInput
                    id="password"
                    ref={passwordRef}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={isSetup ? "new-password" : "current-password"}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "auth-error" : isSetup ? "password-hint" : undefined}
                    disabled={submitting}
                    required
                  />
                  {isSetup && (
                    <p id="password-hint" className="text-xs text-muted-foreground">
                      At least {MIN_PASSWORD} characters. You'll use it on every device.
                    </p>
                  )}
                </div>

                {isSetup && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="confirm">Confirm password</Label>
                    <PasswordInput
                      id="confirm"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      autoComplete="new-password"
                      aria-invalid={error && password !== confirm ? true : undefined}
                      disabled={submitting}
                      required
                    />
                  </div>
                )}

                {error && (
                  <div className="animate-fade-in-soft flex items-start gap-2 text-sm text-destructive">
                    <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <p id="auth-error" role="alert">
                      {error}
                    </p>
                  </div>
                )}

                <Button
                  type="submit"
                  className="pressable h-12 w-full text-base md:h-10 md:text-sm"
                  disabled={submitting}
                >
                  {submitting && <Loader2Icon className="animate-spin" />}
                  {isSetup ? "Set password and continue" : "Sign in"}
                </Button>
              </form>
            )}

            <p className="mt-8 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
              Forgot it? Restart the server with <code className="font-mono">ADMIN_PASSWORD</code> set.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
