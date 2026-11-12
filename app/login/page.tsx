"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { LogoMark } from "@/components/app-header";
import { PasswordInput } from "@/components/password-input";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";

type Mode = "loading" | "setup" | "login";

const MIN_PASSWORD = 8;

/** Only same-origin absolute paths are allowed as redirect targets. */
function nextTarget(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/api/")) return "/";
  return next;
}

export default function LoginPage() {
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
    <main className="pt-safe pb-safe px-safe relative flex min-h-dvh flex-col">
      <div className="flex justify-end p-2">
        <ThemeToggle />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <LogoMark className="size-12" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                {isSetup ? "Welcome to OMP UI" : "Sign in to OMP UI"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {mode === "loading"
                  ? "Checking your session…"
                  : isSetup
                    ? "Set an admin password to protect this server."
                    : "Enter the admin password to continue."}
              </p>
            </div>
          </div>

          <div className="rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
            {mode === "loading" ? (
              <div className="space-y-4" aria-hidden="true">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-11 w-full md:h-9" />
                <Skeleton className="h-11 w-full md:h-9" />
              </div>
            ) : (
              <form onSubmit={onSubmit} noValidate className="space-y-4">
                {/* Helps password managers associate the credential with this server. */}
                <input
                  type="text"
                  name="username"
                  autoComplete="username"
                  value="admin"
                  readOnly
                  hidden
                />
                <div className="space-y-2">
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
                  <div className="space-y-2">
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
                  <p id="auth-error" role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}

                <Button type="submit" className="h-11 w-full text-base md:h-10 md:text-sm" disabled={submitting}>
                  {submitting && <Loader2Icon className="animate-spin" />}
                  {isSetup ? "Set password and continue" : "Sign in"}
                </Button>
              </form>
            )}
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Forgot it? Restart the server with <code className="font-mono">ADMIN_PASSWORD</code> set.
          </p>
        </div>
      </div>
    </main>
  );
}
