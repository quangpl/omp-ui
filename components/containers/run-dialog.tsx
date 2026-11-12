"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDownIcon, Loader2Icon, PlayIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import {
  appendJobLine,
  errorMessage,
  JobLog,
  plainText,
  randomSecret,
  type RunForm,
} from "@/components/containers/shared";
import { TagPicker } from "@/components/containers/tag-picker";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import type { DockerNetwork, RestartPolicy, RunContainerSpec } from "@/lib/docker-types";
import { cn } from "@/lib/utils";

const RESTART_LABELS: Record<RestartPolicy, string> = {
  "unless-stopped": "Unless stopped",
  always: "Always",
  "on-failure": "On failure",
  no: "Never",
};

function RowRemove({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 shrink-0 md:size-9"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      <XIcon />
    </Button>
  );
}

function SectionHeader({ title, onAdd, disabled }: { title: string; onAdd: () => void; disabled: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-xs font-medium text-muted-foreground">{title}</Label>
      <Button type="button" variant="ghost" size="sm" onClick={onAdd} disabled={disabled} className="gap-1">
        <PlusIcon />
        Add
      </Button>
    </div>
  );
}

/**
 * Run a container: image, name, ports, env, volumes, restart policy. Prefilled from a template
 * or an image. Streams pull/run output while it starts.
 */
export function RunDialog({
  form: initial,
  title,
  networks,
  onClose,
  onStarted,
}: {
  form: RunForm | null;
  title?: string;
  networks: DockerNetwork[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const formId = useId();
  const [form, setForm] = useState<RunForm | null>(initial);
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    setForm(initial);
    setLines([]);
    setError(null);
    setRunning(false);
    setAdvanced(Boolean(initial && (initial.network || initial.privileged || initial.interactive)));
  }, [initial]);

  if (!form) return null;
  const update = (patch: Partial<RunForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form || running) return;
    const spec: RunContainerSpec = {
      image: form.image.trim(),
      name: form.name.trim() || undefined,
      ports: form.ports
        .filter((p) => p.container.trim())
        .map((p) => ({ host: p.host.trim(), container: Number(p.container), protocol: p.protocol })),
      env: form.env.filter((v) => v.key.trim()).map(({ key, value }) => ({ key: key.trim(), value })),
      volumes: form.volumes
        .filter((v) => v.target.trim())
        .map((v) => ({ source: v.source.trim(), target: v.target.trim(), readonly: v.readonly })),
      restart: form.restart,
      command: form.command.trim() || undefined,
      network: form.network || undefined,
      interactive: form.interactive,
      privileged: form.privileged,
    };
    setRunning(true);
    setError(null);
    setLines([`$ docker run ${spec.image}`]);
    try {
      const result = await api.docker.run(spec, (line) => setLines((prev) => appendJobLine(prev, line)));
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const port = spec.ports?.[0];
      const hostPort = port ? (port.host.split(":").pop() || String(port.container)) : null;
      toast.success(`Started ${spec.name ?? spec.image}`, {
        description: hostPort ? `Listening on port ${hostPort}` : undefined,
      });
      onStarted();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not start the container"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent className="flex max-h-[min(92dvh,52rem)] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle>{title ?? "Run a container"}</DialogTitle>
          <DialogDescription>
            Missing images are pulled first. Edit ports, volumes and variables before starting.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={submit} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {form.note && (
            <p className="rounded-lg bg-muted/60 p-3 text-xs whitespace-pre-line text-muted-foreground">
              {plainText(form.note)}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-image`}>Image</Label>
              <div className="flex gap-2">
                <Input
                  id={`${formId}-image`}
                  value={form.image}
                  onChange={(e) => update({ image: e.target.value })}
                  placeholder="nginx:alpine or ghcr.io/org/app:tag"
                  className="h-11 font-mono text-sm md:h-9"
                  disabled={running}
                  required
                  autoComplete="off"
                  spellCheck={false}
                />
                <TagPicker image={form.image} onPick={(image) => update({ image })} disabled={running} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-name`}>Container name</Label>
              <Input
                id={`${formId}-name`}
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="auto"
                className="h-11 font-mono text-sm md:h-9"
                disabled={running}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="space-y-2">
            <SectionHeader
              title="Ports (host → container)"
              disabled={running}
              onAdd={() => update({ ports: [...form.ports, { host: "", container: "", protocol: "tcp" }] })}
            />
            {form.ports.length === 0 && <p className="text-xs text-muted-foreground">No published ports.</p>}
            {form.ports.map((port, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={port.host}
                  onChange={(e) =>
                    update({ ports: form.ports.map((p, i) => (i === index ? { ...p, host: e.target.value } : p)) })
                  }
                  placeholder="same"
                  aria-label="Host port"
                  inputMode="numeric"
                  className="h-11 font-mono text-sm md:h-9"
                  disabled={running}
                />
                <span className="text-muted-foreground">→</span>
                <Input
                  value={port.container}
                  onChange={(e) =>
                    update({
                      ports: form.ports.map((p, i) => (i === index ? { ...p, container: e.target.value } : p)),
                    })
                  }
                  placeholder="80"
                  aria-label="Container port"
                  inputMode="numeric"
                  className="h-11 font-mono text-sm md:h-9"
                  disabled={running}
                  required
                />
                <Select
                  value={port.protocol}
                  onValueChange={(value) =>
                    update({
                      ports: form.ports.map((p, i) => (i === index ? { ...p, protocol: value as "tcp" | "udp" } : p)),
                    })
                  }
                  disabled={running}
                >
                  <SelectTrigger className="h-11! w-24 shrink-0 md:h-9!" aria-label="Protocol">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="udp">UDP</SelectItem>
                  </SelectContent>
                </Select>
                <RowRemove
                  label="Remove port"
                  disabled={running}
                  onClick={() => update({ ports: form.ports.filter((_, i) => i !== index) })}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <SectionHeader
              title="Environment variables"
              disabled={running}
              onAdd={() => update({ env: [...form.env, { key: "", value: "" }] })}
            />
            {form.env.length === 0 && <p className="text-xs text-muted-foreground">No variables.</p>}
            {form.env.map((row, index) => {
              const set = (patch: Partial<typeof row>) =>
                update({ env: form.env.map((v, i) => (i === index ? { ...v, ...patch } : v)) });
              return (
                <div key={index} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Input
                      value={row.key}
                      onChange={(e) => set({ key: e.target.value })}
                      placeholder="NAME"
                      aria-label="Variable name"
                      className="h-11 w-2/5 shrink-0 font-mono text-xs md:h-9"
                      disabled={running}
                      spellCheck={false}
                    />
                    {row.options?.length ? (
                      <Select value={row.value} onValueChange={(value) => set({ value })} disabled={running}>
                        <SelectTrigger className="h-11! min-w-0 flex-1 md:h-9!" aria-label={`${row.key} value`}>
                          <SelectValue placeholder="Choose…" />
                        </SelectTrigger>
                        <SelectContent>
                          {row.options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.text}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={row.value}
                        onChange={(e) => set({ value: e.target.value })}
                        placeholder={row.label ?? "value"}
                        aria-label={`${row.key || "Variable"} value`}
                        className="h-11 min-w-0 flex-1 font-mono text-xs md:h-9"
                        disabled={running}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    )}
                    {row.secret && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-11 shrink-0 md:size-9"
                        onClick={() => set({ value: randomSecret() })}
                        disabled={running}
                        aria-label="Generate a new password"
                        title="Generate a new password"
                      >
                        <RefreshCwIcon />
                      </Button>
                    )}
                    <RowRemove
                      label="Remove variable"
                      disabled={running}
                      onClick={() => update({ env: form.env.filter((_, i) => i !== index) })}
                    />
                  </div>
                  {(row.label || row.description) && (
                    <p className="pl-1 text-[0.7rem] text-muted-foreground">
                      {[row.label, row.description].filter(Boolean).join(" — ")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="space-y-2">
            <SectionHeader
              title="Volumes (volume name or host path → container path)"
              disabled={running}
              onAdd={() => update({ volumes: [...form.volumes, { source: "", target: "", readonly: false }] })}
            />
            {form.volumes.length === 0 && <p className="text-xs text-muted-foreground">No volumes.</p>}
            {form.volumes.map((volume, index) => {
              const set = (patch: Partial<typeof volume>) =>
                update({ volumes: form.volumes.map((v, i) => (i === index ? { ...v, ...patch } : v)) });
              return (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={volume.source}
                    onChange={(e) => set({ source: e.target.value })}
                    placeholder="my-data or /srv/data"
                    aria-label="Volume name or host path"
                    className="h-11 min-w-0 flex-1 font-mono text-xs md:h-9"
                    disabled={running}
                    spellCheck={false}
                  />
                  <span className="text-muted-foreground">→</span>
                  <Input
                    value={volume.target}
                    onChange={(e) => set({ target: e.target.value })}
                    placeholder="/data"
                    aria-label="Container path"
                    className="h-11 min-w-0 flex-1 font-mono text-xs md:h-9"
                    disabled={running}
                    spellCheck={false}
                    required
                  />
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch
                      checked={volume.readonly}
                      onCheckedChange={(readonly) => set({ readonly })}
                      disabled={running}
                      aria-label="Read-only"
                    />
                    RO
                  </label>
                  <RowRemove
                    label="Remove volume"
                    disabled={running}
                    onClick={() => update({ volumes: form.volumes.filter((_, i) => i !== index) })}
                  />
                </div>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Restart</Label>
              <Select
                value={form.restart}
                onValueChange={(value) => update({ restart: value as RestartPolicy })}
                disabled={running}
              >
                <SelectTrigger className="h-11! w-full md:h-9!">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(RESTART_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-cmd`}>Command (optional)</Label>
              <Input
                id={`${formId}-cmd`}
                value={form.command}
                onChange={(e) => update({ command: e.target.value })}
                placeholder="image default"
                className="h-11 font-mono text-xs md:h-9"
                disabled={running}
                spellCheck={false}
              />
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={advanced}
            >
              <ChevronDownIcon className={cn("size-3.5 transition-transform", !advanced && "-rotate-90")} />
              Advanced
            </button>
            {advanced && (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Network</Label>
                  <Select
                    value={form.network || "__default"}
                    onValueChange={(value) => update({ network: value === "__default" ? "" : value })}
                    disabled={running}
                  >
                    <SelectTrigger className="h-11! w-full md:h-9!">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default">Default (bridge)</SelectItem>
                      {networks
                        .filter((n) => n.name !== "bridge")
                        .map((n) => (
                          <SelectItem key={n.id} value={n.name}>
                            {n.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 pt-6 text-sm">
                  <Switch
                    checked={form.interactive}
                    onCheckedChange={(interactive) => update({ interactive })}
                    disabled={running}
                  />
                  Keep a TTY open (-it)
                </label>
                <label className="flex items-center gap-2 pt-6 text-sm">
                  <Switch
                    checked={form.privileged}
                    onCheckedChange={(privileged) => update({ privileged })}
                    disabled={running}
                  />
                  Privileged
                </label>
              </div>
            )}
          </div>

          <JobLog lines={lines} />
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </form>

        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={running} className="h-11 md:h-9">
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={running || !form.image.trim()} className="h-11 gap-2 md:h-9">
            {running ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            {running ? "Starting…" : "Start container"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
