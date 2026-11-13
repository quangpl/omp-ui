"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { CheckIcon, Loader2Icon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { RestartStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const RESTART_EVENT = "omp-ui:restart-server";
const POLL_MS = 1000;
/** The CLI waits up to 10 s for the server to drain (pm2 up to 15 s, systemd up to 30 s); `npx -y pm2` may download pm2 first. */
const STOP_TIMEOUT_MS = 5 * 60_000;
/** Install + build + start; a first build on a slow machine takes a few minutes. */
const START_TIMEOUT_MS = 15 * 60_000;

/** Ask the global restart dialog (mounted in `Providers`) to open. */
export function openRestartServer(): void {
  window.dispatchEvent(new Event(RESTART_EVENT));
}

type Phase =
  | { name: "confirm" }
  | { name: "stopping"; since: number }
  | { name: "building"; since: number }
  | { name: "failed"; title: string; message: string; log: string | null };

function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch("/api/v1/health", { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Poll until the server stops answering: "stopped". "failed" when it still answers but the restart
 * CLI has already exited (it failed before stopping the server); "timeout" on timeout or abort.
 */
async function waitForStop(timeoutMs: number, signal: AbortSignal): Promise<"stopped" | "failed" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    let restarting = true;
    try {
      const res = await fetch("/api/v1/system/restart", {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(3000),
      });
      // 5xx: a proxy in front of the stopped server, or the server shutting down.
      if (res.status >= 500) return "stopped";
      if (res.ok) restarting = ((await res.json()) as RestartStatus).restarting;
    } catch {
      return "stopped";
    }
    if (!restarting) return "failed";
    await pause(POLL_MS);
  }
  return "timeout";
}

/** Poll /health until the server answers again; false on timeout or abort. */
async function waitForStart(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    if (await serverUp()) return true;
    await pause(POLL_MS);
  }
  return false;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function Step({ state, children }: { state: "done" | "active" | "pending"; children: React.ReactNode }) {
  return (
    <li className={cn("flex items-center gap-2.5 text-sm", state === "pending" && "text-muted-foreground")}>
      <span className="flex size-5 items-center justify-center">
        {state === "done" ? (
          <CheckIcon className="size-4 text-primary" />
        ) : state === "active" ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <span className="size-1.5 rounded-full bg-muted-foreground/50" />
        )}
      </span>
      {children}
    </li>
  );
}

/**
 * Global "Restart server" dialog: stops the server, rebuilds it from the current sources and starts
 * it again (through the omp-ui CLI), then reloads the page on the new build.
 */
export function RestartServerDialog() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: "confirm" });
  const [status, setStatus] = useState<RestartStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const pathname = usePathname();
  const busy = phase.name === "stopping" || phase.name === "building";

  useEffect(() => {
    if (pathname === "/login") return;
    const onOpen = () => {
      setPhase({ name: "confirm" });
      setStatus(null);
      setStatusError(null);
      setOpen(true);
      api.restart
        .status()
        .then(setStatus)
        .catch((err: unknown) =>
          setStatusError(err instanceof Error && err.message ? err.message : "Could not reach the server."),
        );
    };
    window.addEventListener(RESTART_EVENT, onOpen);
    return () => window.removeEventListener(RESTART_EVENT, onOpen);
  }, [pathname]);

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function onConfirm(e: React.MouseEvent) {
    // Keep the dialog open: it follows the restart until the new server answers.
    e.preventDefault();
    if (requesting || !status?.available) return;
    setRequesting(true);
    try {
      await api.restart.start();
    } catch (err) {
      setPhase({
        name: "failed",
        title: "Could not restart",
        message: err instanceof Error && err.message ? err.message : "The server refused to restart.",
        log: null,
      });
      return;
    } finally {
      setRequesting(false);
    }

    const abort = new AbortController();
    abortRef.current = abort;
    const started = Date.now();
    setNow(started);
    setPhase({ name: "stopping", since: started });
    const stop = await waitForStop(STOP_TIMEOUT_MS, abort.signal);
    if (stop !== "stopped") {
      if (abort.signal.aborted) return;
      const latest = await api.restart.status().catch(() => null);
      setPhase({
        name: "failed",
        title: "The server did not stop",
        message: "Still running the old build. See the restart output below.",
        log: latest?.log ?? null,
      });
      return;
    }
    setPhase({ name: "building", since: Date.now() });
    if (!(await waitForStart(START_TIMEOUT_MS, abort.signal))) {
      if (abort.signal.aborted) return;
      setPhase({
        name: "failed",
        title: "The server did not come back",
        message:
          status?.mode === "systemd"
            ? "On the server, check `omp-ui systemd logs`, then start it with `omp-ui systemd restart`."
            : status?.mode === "pm2"
              ? "On the server, check data/restart.log (or run `omp-ui pm2 logs`), then start it with `omp-ui pm2 restart`."
              : "On the server, check data/restart.log (or run `omp-ui logs`), then start it with `omp-ui restart`.",
        log: null,
      });
      return;
    }
    const latest = await api.restart.status().catch(() => null);
    if (latest?.buildFailed) {
      setPhase({
        name: "failed",
        title: "Build failed — the previous build is running",
        message: "Fix the error below and restart again.",
        log: latest.log,
      });
      return;
    }
    location.reload();
  }

  const elapsed = busy ? formatElapsed(now - phase.since) : "";
  const failed = phase.name === "failed";
  const log = failed ? phase.log : null;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && !requesting && setOpen(next)}>
      <AlertDialogContent className={cn(log && "data-[size=default]:sm:max-w-2xl")}>
        <AlertDialogHeader>
          <AlertDialogMedia
            className={failed ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}
          >
            {failed ? <TriangleAlertIcon /> : <RotateCwIcon className={cn("size-6", busy && "animate-spin")} />}
          </AlertDialogMedia>
          <AlertDialogTitle>
            {phase.name === "confirm"
              ? "Restart the server?"
              : phase.name === "failed"
                ? phase.title
                : "Restarting the server…"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {phase.name === "confirm" &&
                (statusError ? (
                  <p>{statusError}</p>
                ) : !status ? (
                  <p className="flex items-center gap-2">
                    <Loader2Icon className="size-3.5 animate-spin" /> Checking how the server runs…
                  </p>
                ) : !status.available ? (
                  <p>{status.reason}</p>
                ) : (
                  <>
                    <p>
                      Stops AgentMan, rebuilds it from the current sources and starts it again. The app is unavailable
                      for about a minute.
                    </p>
                    {status.running > 0 && (
                      <p className="mt-2 font-medium text-amber-600 dark:text-amber-400">
                        {status.running} running agent{status.running === 1 ? " is" : "s are"} interrupted. With
                        automatic retries on, {status.running === 1 ? "it resumes" : "they resume"} after the restart;
                        otherwise press Resume on the card.
                      </p>
                    )}
                  </>
                ))}
              {busy && (
                <ol className="mt-1 grid gap-2 text-foreground">
                  <Step state={phase.name === "stopping" ? "active" : "done"}>Stopping the server</Step>
                  <Step state={phase.name === "building" ? "active" : "pending"}>
                    Rebuilding and starting
                    {phase.name === "building" && (
                      <span className="text-muted-foreground tabular-nums">· {elapsed}</span>
                    )}
                  </Step>
                  <Step state="pending">Reloading this page</Step>
                </ol>
              )}
              {failed && <p>{phase.message}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {log && (
          <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            {log}
          </pre>
        )}
        <AlertDialogFooter>
          {phase.name === "confirm" && (
            <>
              <AlertDialogCancel disabled={requesting} className="max-md:h-11">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={requesting || !status?.available}
                onClick={onConfirm}
                className="max-md:h-11"
              >
                {requesting ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />}
                Rebuild &amp; restart
              </AlertDialogAction>
            </>
          )}
          {busy && (
            <p className="text-xs text-muted-foreground sm:mr-auto">
              This page reloads when the new build is up.
            </p>
          )}
          {failed && (
            <>
              <AlertDialogCancel className="max-md:h-11">Close</AlertDialogCancel>
              <Button className="max-md:h-11" onClick={() => location.reload()}>
                Reload page
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
