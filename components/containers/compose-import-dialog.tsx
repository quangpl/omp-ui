"use client";

import { useEffect, useId, useState } from "react";
import { Loader2Icon, PencilIcon, RocketIcon } from "lucide-react";
import { toast } from "sonner";
import { appendJobLine, errorMessage, JobLog, projectNameFrom } from "@/components/containers/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";

/** A pasted link rather than YAML: one line starting with http(s)://. */
function pastedUrl(text: string): string | null {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : null;
}

/** Project name hint from a link: the repository on GitHub, else the folder holding the file. */
function nameHint(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    const parts = pathname.split("/").filter(Boolean);
    if (hostname.endsWith("github.com") || hostname === "raw.githubusercontent.com") return parts[1] ?? "stack";
    return parts.at(-2) ?? parts[0] ?? "stack";
  } catch {
    return "stack";
  }
}

/** Paste a compose file or a link to one, then `up` it in one go (or open it in the editor first). */
export function ComposeImportDialog({
  open,
  composeNames,
  onClose,
  onEdit,
  onDeployed,
}: {
  open: boolean;
  composeNames: Set<string>;
  onClose: () => void;
  onEdit: (draft: { name: string; yaml: string }) => void;
  onDeployed: (project: string) => void;
}) {
  const formId = useId();
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState<"up" | "edit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource("");
    setName("");
    setLines([]);
    setBusy(null);
    setError(null);
  }, [open]);

  const url = pastedUrl(source);
  const suggested = projectNameFrom(url ? nameHint(url) : "stack", composeNames);
  const project = name.trim() || suggested;

  async function up(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !source.trim()) return;
    setBusy("up");
    setError(null);
    setLines([url ? `Fetching ${url}` : "$ docker compose up -d"]);
    try {
      const result = await api.docker.quickCompose(
        url ? { name: project, url } : { name: project, yaml: source },
        (line) => setLines((prev) => appendJobLine(prev, line)),
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(result.message);
      onDeployed(result.id ?? project);
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not start the stack"));
    } finally {
      setBusy(null);
    }
  }

  async function edit() {
    if (busy || !source.trim()) return;
    if (!url) {
      onEdit({ name: project, yaml: source });
      return;
    }
    setBusy("edit");
    setError(null);
    try {
      const { yaml } = await api.docker.composeFromUrl(url);
      onEdit({ name: project, yaml });
    } catch (err) {
      setError(errorMessage(err, "Could not download the compose file"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="flex max-h-[min(92dvh,48rem)] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle>Compose from YAML or URL</DialogTitle>
          <DialogDescription>
            Paste a compose file or a link to one (GitHub, GitLab, Gist). Busy host ports are remapped to free ones.
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          onSubmit={up}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void up();
            }
          }}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-source`}>compose.yaml or link</Label>
            <Textarea
              id={`${formId}-source`}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={"https://github.com/owner/repo/blob/main/compose.yaml\n\nor\n\nservices:\n  web:\n    image: nginx:alpine\n    ports:\n      - \"8080:80\""}
              className="min-h-56 font-mono text-xs leading-relaxed"
              disabled={Boolean(busy)}
              spellCheck={false}
              autoFocus
              required
            />
            {url && <p className="text-xs text-muted-foreground">Link detected; the server downloads it.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-name`}>Project name</Label>
            <Input
              id={`${formId}-name`}
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={suggested}
              className="h-11 font-mono text-sm md:h-9"
              disabled={Boolean(busy)}
              pattern="[a-z0-9][a-z0-9_\-]*"
              title="Lowercase letters, digits, - and _"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <JobLog lines={lines} />
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm whitespace-pre-wrap text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={Boolean(busy)} className="h-11 md:h-9">
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => void edit()}
            disabled={Boolean(busy) || !source.trim()}
            className="h-11 gap-2 md:h-9"
          >
            {busy === "edit" ? <Loader2Icon className="animate-spin" /> : <PencilIcon />}
            Edit first
          </Button>
          <Button type="submit" form={formId} disabled={Boolean(busy) || !source.trim()} className="h-11 gap-2 md:h-9">
            {busy === "up" ? <Loader2Icon className="animate-spin" /> : <RocketIcon />}
            {busy === "up" ? "Starting…" : "Up"}
            <Kbd className="max-md:hidden bg-primary-foreground/15 text-primary-foreground">⌘↵</Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
