"use client";

import { useEffect, useId, useState } from "react";
import { Loader2Icon, PlusIcon, RefreshCwIcon, RocketIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import {
  appendJobLine,
  type EnvRow,
  errorMessage,
  JobLog,
  plainText,
  randomSecret,
} from "@/components/containers/shared";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";

export interface ComposeDraft {
  title: string;
  name: string;
  yaml: string;
  env: EnvRow[];
  /** Redeploying an existing AgentMan project: the name is fixed. */
  editing: boolean;
  /** A project AgentMan did not create: shown, not deployable from here. */
  readOnly?: boolean;
  configFile?: string;
  note?: string;
}

/** Edit and `up -d` a compose stack under DATA_DIR/compose/<name>/. */
export function ComposeDialog({
  draft: initial,
  onClose,
  onDeployed,
}: {
  draft: ComposeDraft | null;
  onClose: () => void;
  onDeployed: () => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<ComposeDraft | null>(initial);
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial);
    setLines([]);
    setError(null);
    setRunning(false);
  }, [initial]);

  if (!draft) return null;
  const update = (patch: Partial<ComposeDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setEnv = (index: number, patch: Partial<EnvRow>) =>
    update({ env: draft.env.map((row, i) => (i === index ? { ...row, ...patch } : row)) });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || running || draft.readOnly) return;
    setRunning(true);
    setError(null);
    setLines([`$ docker compose -p ${draft.name} up -d`]);
    try {
      const result = await api.docker.deployCompose(
        {
          name: draft.name.trim(),
          yaml: draft.yaml,
          env: draft.env.filter((row) => row.key.trim()).map(({ key, value }) => ({ key: key.trim(), value })),
        },
        (line) => setLines((prev) => appendJobLine(prev, line)),
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      toast.success(result.message);
      onDeployed();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not deploy the stack"));
    } finally {
      setRunning(false);
    }
  }

  const locked = running || Boolean(draft.readOnly);

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent className="flex max-h-[min(92dvh,56rem)] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle>{draft.title}</DialogTitle>
          <DialogDescription className="truncate">
            {draft.readOnly
              ? `Managed outside AgentMan: ${draft.configFile ?? "compose file"}`
              : "Saved in AgentMan's data folder, started with docker compose up -d."}
          </DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={submit} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {draft.note && (
            <p className="rounded-lg bg-muted/60 p-3 text-xs whitespace-pre-line text-muted-foreground">
              {plainText(draft.note)}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-name`}>Project name</Label>
            <Input
              id={`${formId}-name`}
              value={draft.name}
              onChange={(e) => update({ name: e.target.value.toLowerCase() })}
              className="h-11 font-mono text-sm md:h-9"
              disabled={locked || draft.editing}
              pattern="[a-z0-9][a-z0-9_\-]*"
              title="Lowercase letters, digits, - and _"
              required
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {(draft.env.length > 0 || !draft.readOnly) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium text-muted-foreground">
                  Variables (.env, used as ${"{NAME}"} in the file)
                </Label>
                {!draft.readOnly && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1"
                    disabled={locked}
                    onClick={() => update({ env: [...draft.env, { key: "", value: "" }] })}
                  >
                    <PlusIcon />
                    Add
                  </Button>
                )}
              </div>
              {draft.env.map((row, index) => (
                <div key={index} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Input
                      value={row.key}
                      onChange={(e) => setEnv(index, { key: e.target.value })}
                      placeholder="NAME"
                      aria-label="Variable name"
                      className="h-11 w-2/5 shrink-0 font-mono text-xs md:h-9"
                      disabled={locked}
                      spellCheck={false}
                    />
                    <Input
                      value={row.value}
                      onChange={(e) => setEnv(index, { value: e.target.value })}
                      placeholder={row.label ?? "value"}
                      aria-label={`${row.key || "Variable"} value`}
                      className="h-11 min-w-0 flex-1 font-mono text-xs md:h-9"
                      disabled={locked}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    {row.secret && !draft.readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-11 shrink-0 md:size-9"
                        onClick={() => setEnv(index, { value: randomSecret() })}
                        disabled={locked}
                        aria-label="Generate a new password"
                        title="Generate a new password"
                      >
                        <RefreshCwIcon />
                      </Button>
                    )}
                    {!draft.readOnly && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-11 shrink-0 md:size-9"
                        onClick={() => update({ env: draft.env.filter((_, i) => i !== index) })}
                        disabled={locked}
                        aria-label="Remove variable"
                      >
                        <XIcon />
                      </Button>
                    )}
                  </div>
                  {(row.label || row.description) && (
                    <p className="pl-1 text-[0.7rem] text-muted-foreground">
                      {[row.label, row.description].filter(Boolean).join(" — ")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-yaml`}>compose.yaml</Label>
            <Textarea
              id={`${formId}-yaml`}
              value={draft.yaml}
              onChange={(e) => update({ yaml: e.target.value })}
              className="min-h-72 font-mono text-xs leading-relaxed"
              readOnly={Boolean(draft.readOnly)}
              disabled={running}
              spellCheck={false}
              required
            />
          </div>

          <JobLog lines={lines} />
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm whitespace-pre-wrap text-destructive">
              {error}
            </p>
          )}
        </form>

        <DialogFooter className="mx-0 mb-0 border-t px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={running} className="h-11 md:h-9">
            {draft.readOnly ? "Close" : "Cancel"}
          </Button>
          {!draft.readOnly && (
            <Button
              type="submit"
              form={formId}
              disabled={running || !draft.name.trim() || !draft.yaml.trim()}
              className="h-11 gap-2 md:h-9"
            >
              {running ? <Loader2Icon className="animate-spin" /> : <RocketIcon />}
              {running ? "Deploying…" : draft.editing ? "Save & redeploy" : "Deploy"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
