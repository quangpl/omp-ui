"use client";

import { useId, useState } from "react";
import { GitBranchIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";

/** Folder name git would pick: last URL segment without `.git`. */
function repoBasename(url: string): string {
  return (
    url
      .trim()
      .replace(/[/\\]+$/, "")
      .split(/[/:\\]/)
      .pop()
      ?.replace(/\.git$/i, "") ?? ""
  );
}

/**
 * Clone a Git repository into the server's workspace folder.
 * Calls `onCloned` with the absolute path of the new folder.
 */
export function CloneRepoForm({
  onCloned,
  onBusyChange,
}: {
  onCloned: (path: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggested = repoBasename(url);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (cloning) return;
    const repoUrl = url.trim();
    if (!repoUrl) {
      setError("Paste the address of the repository.");
      return;
    }
    setError(null);
    setCloning(true);
    onBusyChange?.(true);
    try {
      const result = await api.git.clone({ url: repoUrl, name: name.trim() || undefined });
      toast.success("Repository cloned");
      onCloned(result.path);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't clone the repository.");
    } finally {
      setCloning(false);
      onBusyChange?.(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor={`${id}-url`}>Repository URL</Label>
        <Input
          id={`${id}-url`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={cloning}
          aria-invalid={error ? true : undefined}
          className="h-11 font-mono md:h-9"
        />
        <p className="text-xs text-muted-foreground">
          HTTPS or SSH. Private repos need git credentials set up on the server.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>
          Folder name <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={suggested || "Same as the repository"}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={cloning}
          className="h-11 font-mono md:h-9"
        />
        <p className="text-xs text-muted-foreground">Created inside the workspace folder on the server.</p>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2.5 text-sm [overflow-wrap:anywhere] text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={cloning || !url.trim()} className="h-11 w-full text-base md:h-9 md:text-sm">
        {cloning ? <Loader2Icon className="animate-spin" /> : <GitBranchIcon />}
        {cloning ? "Cloning…" : "Clone repository"}
      </Button>
      {cloning && (
        <p className="text-center text-xs text-muted-foreground" aria-live="polite">
          This can take a minute for big repositories.
        </p>
      )}
    </form>
  );
}
