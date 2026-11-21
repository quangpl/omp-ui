"use client";

import { useEffect, useId, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { byProvider, type ModelsStatus } from "@/components/settings/model-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api-client";
import type { OmpModel } from "@/lib/types";

/** Select value of the "no model" entry (Radix items cannot have an empty value). */
const DEFAULT_VALUE = "__default__";

/** Chat models omp can use, loaded once on mount; `failed` (omp unreachable, no models) makes the field a text input. */
function useOmpModels(): { models: OmpModel[]; status: ModelsStatus } {
  const [state, setState] = useState<{ models: OmpModel[]; status: ModelsStatus }>({ models: [], status: "loading" });
  useEffect(() => {
    let cancelled = false;
    api.ompConfig
      .models()
      .then((res) => {
        if (!cancelled) setState({ models: res.models, status: res.models.length > 0 ? "ready" : "failed" });
      })
      .catch(() => {
        if (!cancelled) setState({ models: [], status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/**
 * "Model" field of a scheduler: a dropdown of the models omp can use (grouped by provider) that the
 * cards it creates run on; "Project default" (null) leaves the choice to the project and settings.
 * A value omp no longer lists stays selectable so it is never dropped silently.
 */
export function SchedulerModelField({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const { models, status } = useOmpModels();
  const providers = byProvider(models);
  const known = models.some((m) => m.selector === value);

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-model`}>
        Model <span className="font-normal text-muted-foreground">(optional)</span>
      </Label>
      {status === "failed" ? (
        <Input
          id={`${id}-model`}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value.trim() || null)}
          placeholder="Project default (provider/model-id)"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={disabled}
          className="h-11 font-mono md:h-9 md:text-xs"
        />
      ) : (
        <Select
          value={value ?? DEFAULT_VALUE}
          onValueChange={(next) => onChange(next === DEFAULT_VALUE ? null : next)}
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-model`} className="w-full min-w-0 data-[size=default]:h-11 md:data-[size=default]:h-9">
            <SelectValue placeholder="Project default" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={DEFAULT_VALUE} className="min-h-11 md:min-h-8">
              Project default
            </SelectItem>
            {value !== null && !known && (
              <SelectItem value={value} className="min-h-11 font-mono md:min-h-8 md:text-xs">
                {value}
              </SelectItem>
            )}
            {status === "loading" && (
              <SelectItem value="__loading__" disabled className="min-h-11 md:min-h-8">
                <Loader2Icon className="animate-spin" />
                Loading models…
              </SelectItem>
            )}
            {providers.map(([provider, list]) => (
              <SelectGroup key={provider}>
                <SelectLabel>{provider}</SelectLabel>
                {list.map((m) => (
                  <SelectItem key={m.selector} value={m.selector} className="min-h-11 md:min-h-8">
                    {m.name}
                    <span className="font-mono text-xs text-muted-foreground">{m.selector.slice(provider.length + 1)}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
