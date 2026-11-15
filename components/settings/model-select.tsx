"use client";

import { Loader2Icon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OmpModel } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Whether `omp models` answered: on `failed` pickers fall back to text inputs. */
export type ModelsStatus = "loading" | "ready" | "failed";

/** A model role value "provider/model-id[:thinking]" split into its model and thinking level ("" = none). */
export function splitModel(value: string, levels: ReadonlySet<string>): { model: string; thinking: string } {
  const text = value.trim();
  const colon = text.lastIndexOf(":");
  if (colon > 0 && levels.has(text.slice(colon + 1))) return { model: text.slice(0, colon), thinking: text.slice(colon + 1) };
  return { model: text, thinking: "" };
}

/** Models by provider, in omp's order. */
export function byProvider(models: OmpModel[]): [string, OmpModel[]][] {
  const groups = new Map<string, OmpModel[]>();
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return [...groups];
}

/**
 * Picks a model selector: omp's models grouped by provider, optionally with "provider/*" wildcards
 * (any model of that provider); a current value omp did not list stays selectable. While the model
 * listing loads the list shows a spinner; when it failed the picker is a plain text input.
 */
export function ModelSelect({
  value,
  onChange,
  models,
  status,
  wildcards = false,
  placeholder,
  ariaLabel,
  disabled,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  models: OmpModel[];
  status: ModelsStatus;
  /** Offer "provider/*" entries (any model of that provider). */
  wildcards?: boolean;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  if (status === "failed") {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="provider/model-id"
        aria-label={ariaLabel}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        className={cn("h-11 font-mono md:h-9 md:text-xs", className)}
      />
    );
  }
  const providers = byProvider(models);
  const known = models.some((m) => m.selector === value) || (wildcards && providers.some(([p]) => `${p}/*` === value));
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn("w-full min-w-0 data-[size=default]:h-11 md:data-[size=default]:h-9", className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {value && !known && (
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
        {wildcards && providers.length > 0 && (
          <SelectGroup>
            <SelectLabel>Any model of a provider</SelectLabel>
            {providers.map(([provider]) => (
              <SelectItem key={provider} value={`${provider}/*`} className="min-h-11 md:min-h-8">
                Any {provider} model
                <span className="font-mono text-xs text-muted-foreground">{provider}/*</span>
              </SelectItem>
            ))}
          </SelectGroup>
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
  );
}
