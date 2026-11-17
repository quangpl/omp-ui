"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArchiveRestoreIcon,
  CheckIcon,
  DownloadIcon,
  FileArchiveIcon,
  Loader2Icon,
  RotateCcwIcon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime, formatRelative, useNow } from "@/components/board/format";
import { SettingsGroup, SettingsPanel, SettingsSection } from "@/components/settings/settings-section";
import { formatBytes } from "@/components/stats/shared";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { DataImportResult, DataTransferStatus, ImportedCredentialsKey } from "@/lib/types";
import { cn } from "@/lib/utils";

const FIELD = "h-11 md:h-9";
/** Typed into the confirmation dialog to start an import. */
const CONFIRM_WORD = "REPLACE";

const DRIVER_LABELS: Record<DataTransferStatus["driver"], string> = {
  sqlite: "SQLite",
  postgres: "PostgreSQL",
  mongodb: "MongoDB",
};

const KEY_OUTCOMES: Record<ImportedCredentialsKey, { ok: boolean; text: string }> = {
  restored: { ok: true, text: "Saved API keys, tokens and MCP secrets work as on the old server." },
  ignored: {
    ok: false,
    text: "This server's CREDENTIALS_KEY overrides the imported key: saved secrets only open if it has the old server's value.",
  },
  "set-env": {
    ok: false,
    text: "The old server sealed its secrets with CREDENTIALS_KEY: set the same value here and restart, or enter the secrets again.",
  },
  none: { ok: true, text: "The old server had no saved secrets." },
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** Settings → Data transfer: export everything to move this server, or import such an export. */
export function DataTransferSettingsSection() {
  const [status, setStatus] = useState<DataTransferStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<DataImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const now = useNow();

  const load = useCallback(() => {
    setLoadError(null);
    api.dataTransfer
      .status()
      .then(setStatus)
      .catch((err) => setLoadError(errorText(err, "Could not load the data transfer status.")));
  }, []);

  useEffect(load, [load]);

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
  }

  function openConfirm() {
    setTyped("");
    setConfirming(true);
  }

  async function runImport(e: React.MouseEvent) {
    // Keep the dialog open until the upload settles.
    e.preventDefault();
    if (!file || importing || typed !== CONFIRM_WORD) return;
    setImporting(true);
    try {
      setResult(await api.dataTransfer.import(file));
    } catch (err) {
      toast.error("Import failed", { description: errorText(err, "The archive could not be imported.") });
      // Busy agents or a bad archive changed nothing; refresh the counts either way.
      load();
    } finally {
      setImporting(false);
      setConfirming(false);
    }
  }

  /** Every page holds data from before the import: start over (at sign-in when the session ended). */
  function continueAfterImport() {
    window.location.href = result?.signedOut ? "/login" : "/";
  }

  const busyAgents = status?.activeAgents ?? 0;

  return (
    <SettingsSection
      id="data"
      icon={<ArchiveRestoreIcon />}
      title="Data transfer"
      description="Move AgentMan to another server: export every project, card, comment, run, scheduler, user, setting and shared file as one archive, then import it on the new server."
    >
      {loadError ? (
        <SettingsPanel className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="flex min-w-0 flex-1 gap-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">Couldn't load data transfer</p>
              <p className="text-destructive">{loadError}</p>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={load} className={cn(FIELD, "pressable w-full gap-2 sm:w-auto")}>
            <RotateCcwIcon />
            Try again
          </Button>
        </SettingsPanel>
      ) : !status ? (
        <SettingsPanel>
          <div aria-busy="true" className="divide-y">
            {[0, 1].map((i) => (
              <div key={i} className="space-y-3 p-4 sm:p-5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-11 w-full sm:w-48 md:h-9" />
              </div>
            ))}
          </div>
        </SettingsPanel>
      ) : (
        <SettingsPanel>
          <SettingsGroup title="Export">
            <p className="text-pretty">
              {DRIVER_LABELS[status.driver]} database with {plural(status.users, "user")},{" "}
              {plural(status.projects, "project")}, {plural(status.cards, "card")} and{" "}
              {plural(status.schedulers, "scheduler")}, plus {formatBytes(status.filesBytes)} of shared files.
            </p>
            <div className="flex gap-2.5 rounded-lg bg-amber-500/10 p-3 text-xs text-pretty text-amber-800 dark:text-amber-300">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <p>
                The archive holds password hashes, saved API keys and bot tokens
                {status.credentialsKey === "file" ? ", and the key that decrypts them" : ""}. Keep it as safe as a
                password and delete it once the move is done.
                {status.credentialsKey === "env" &&
                  " Saved secrets are sealed with CREDENTIALS_KEY, which is not in the archive: set the same value on the new server."}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button asChild className={cn(FIELD, "pressable w-full gap-2 sm:w-auto")}>
                <a href={api.dataTransfer.exportUrl} download>
                  <DownloadIcon />
                  Download export
                </a>
              </Button>
              <p className="text-xs text-pretty text-muted-foreground">
                A <span className="font-mono">.tar.gz</span>; the download starts once it is packed.
              </p>
            </div>
            <p className="text-xs text-pretty text-muted-foreground">
              Not included: project folders (copy or clone them to the same paths on the new server) and omp's own
              setup in <span className="font-mono">~/.omp</span> (sign in to omp there; agent sessions start fresh).
            </p>
          </SettingsGroup>

          <SettingsGroup title="Import">
            <p className="text-pretty">
              Replaces <strong>everything</strong> on this server (projects, cards, users, settings and shared files)
              with the export. The current data is saved as a backup first. Afterwards you sign in with the accounts
              from the export.
            </p>
            {busyAgents > 0 && (
              <div className="flex gap-2.5 rounded-lg bg-destructive/10 p-3 text-xs text-pretty text-destructive">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <p>
                  {plural(busyAgents, "agent")} running or queued. Stop them before importing: the import replaces
                  their cards.
                </p>
              </div>
            )}
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor="data-import-file">Export archive</Label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  ref={fileInput}
                  id="data-import-file"
                  type="file"
                  accept=".gz,.tgz,application/gzip"
                  onChange={pickFile}
                  className="sr-only"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInput.current?.click()}
                  disabled={importing}
                  className={cn(FIELD, "pressable w-full min-w-0 justify-start gap-2 sm:w-auto sm:max-w-80")}
                >
                  <FileArchiveIcon />
                  <span className="truncate">{file ? file.name : "Choose file…"}</span>
                  {file && <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={openConfirm}
                  disabled={!file || importing || busyAgents > 0 || status.importing}
                  className={cn(FIELD, "pressable w-full gap-2 sm:w-auto")}
                >
                  {importing ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}
                  {importing ? "Importing…" : "Import and replace"}
                </Button>
              </div>
              {status.importing && !importing && (
                <p className="text-xs text-muted-foreground">Another import is in progress.</p>
              )}
            </div>
          </SettingsGroup>

          {status.backups.length > 0 && (
            <SettingsGroup title="Backups before imports">
              <ul className="-mx-4 divide-y divide-border/70 sm:-mx-5">
                {status.backups.map((backup) => (
                  <li key={backup.name} className="flex min-h-12 items-center gap-3 px-4 py-2 sm:px-5">
                    <FileArchiveIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">{backup.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        <time dateTime={backup.createdAt} title={formatDateTime(backup.createdAt)}>
                          {formatRelative(backup.createdAt, now)}
                        </time>
                        {" · "}
                        {formatBytes(backup.size)}
                      </span>
                    </span>
                    <Button asChild variant="ghost" size="icon" className="pressable size-11 shrink-0 md:size-8">
                      <a href={api.dataTransfer.backupUrl(backup.name)} download aria-label={`Download ${backup.name}`}>
                        <DownloadIcon />
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-pretty text-muted-foreground">
                Importing a backup restores the data it holds. The newest 3 are kept.
              </p>
            </SettingsGroup>
          )}
        </SettingsPanel>
      )}

      <AlertDialog open={confirming} onOpenChange={(open) => !importing && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <TriangleAlertIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>Replace all data on this server?</AlertDialogTitle>
            <AlertDialogDescription>
              Every project, card, user, setting and shared file here is replaced by{" "}
              <span className="font-medium [overflow-wrap:anywhere] text-foreground">{file?.name}</span>. A backup of
              the current data is saved first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="data-import-confirm">
              Type <span className="font-mono">{CONFIRM_WORD}</span> to confirm
            </Label>
            <Input
              id="data-import-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={importing}
              className={FIELD}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing} className="max-md:h-11">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={importing || typed !== CONFIRM_WORD}
              onClick={runImport}
              className="max-md:h-11"
            >
              {importing && <Loader2Icon className="animate-spin" />}
              {importing ? "Importing…" : "Replace all data"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={result !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-success/10 text-success">
              <CheckIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>Import complete</AlertDialogTitle>
            <AlertDialogDescription>
              {result &&
                `Export of ${formatDateTime(result.source.createdAt)} (${DRIVER_LABELS[result.source.driver as DataTransferStatus["driver"]] ?? result.source.driver}).`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {result && (
            <ul className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-xs">
              <li>
                {plural(result.counts.users ?? 0, "user")}, {plural(result.counts.boards ?? 0, "project")},{" "}
                {plural(result.counts.tasks ?? 0, "card")}, {plural(result.counts.comments ?? 0, "comment")},{" "}
                {plural(result.counts.runs ?? 0, "run")} and {plural(result.files, "shared file")}.
              </li>
              {result.interrupted > 0 && (
                <li>{plural(result.interrupted, "card")} had a working agent: stopped, Resume continues it.</li>
              )}
              {result.skipped > 0 && (
                <li>{plural(result.skipped, "row")} left out: what they belonged to is not in the export.</li>
              )}
              <li className={cn(!KEY_OUTCOMES[result.credentialsKey].ok && "text-amber-700 dark:text-amber-400")}>
                {KEY_OUTCOMES[result.credentialsKey].text}
              </li>
              <li>
                Previous data saved as{" "}
                <a href={api.dataTransfer.backupUrl(result.backup.name)} download className="font-mono underline underline-offset-2">
                  {result.backup.name}
                </a>
                .
              </li>
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogAction onClick={continueAfterImport} className="max-md:h-11">
              {result?.signedOut ? "Sign in" : "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
