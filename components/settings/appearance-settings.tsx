"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, PaletteIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { SettingsGroup, SettingsPanel, SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import {
  DEFAULT_PRIMARY_COLOR,
  PRIMARY_COLOR_ATTRIBUTE,
  PRIMARY_COLORS,
  type PrimaryColorId,
} from "@/lib/primary-colors";
import { cn } from "@/lib/utils";

const FIELD = "h-11 md:h-9";
const NEXT_KEYS = ["ArrowRight", "ArrowDown"];
const PREV_KEYS = ["ArrowLeft", "ArrowUp"];

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Settings → Appearance: the primary color preset. A pick previews instantly on the whole page,
 * then saves; a failed save restores the last saved color.
 */
export function AppearanceSettingsSection() {
  const [selected, setSelected] = useState<PrimaryColorId | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The last color the server confirmed, restored when a save fails.
  const savedRef = useRef<PrimaryColorId | null>(null);
  // Only the newest save's response is applied: an older one would undo picks made since.
  const saveSeq = useRef(0);

  // Recolors the whole UI: the theme stylesheet keys every preset off this attribute on <html>.
  const show = useCallback((id: PrimaryColorId) => {
    setSelected(id);
    document.documentElement.setAttribute(PRIMARY_COLOR_ATTRIBUTE, id);
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    api.settings
      .get()
      .then((settings) => {
        savedRef.current = settings.primaryColor;
        show(settings.primaryColor);
      })
      .catch((err) => setLoadError(errorText(err, "Could not load the appearance settings.")));
  }, [show]);

  useEffect(load, [load]);

  async function onPick(id: PrimaryColorId) {
    if (selected === null || id === selected) return;
    const seq = ++saveSeq.current;
    show(id);
    try {
      const saved = await api.settings.update({ primaryColor: id });
      savedRef.current = saved.primaryColor;
      if (seq === saveSeq.current) show(saved.primaryColor);
    } catch (err) {
      if (seq === saveSeq.current && savedRef.current) show(savedRef.current);
      toast.error(errorText(err, "Could not save the theme color."));
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = NEXT_KEYS.includes(e.key) ? 1 : PREV_KEYS.includes(e.key) ? -1 : 0;
    if (!step || selected === null) return;
    e.preventDefault();
    const index = PRIMARY_COLORS.findIndex((preset) => preset.id === selected);
    const next = PRIMARY_COLORS[(index + step + PRIMARY_COLORS.length) % PRIMARY_COLORS.length].id;
    void onPick(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus();
  }

  return (
    <SettingsSection
      id="appearance"
      icon={<PaletteIcon />}
      title="Appearance"
      description="Choose the color the interface is tinted with."
    >
      {loadError ? (
        <SettingsPanel className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="flex min-w-0 flex-1 gap-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">Couldn't load appearance settings</p>
              <p className="text-destructive">{loadError}</p>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={load} className={cn(FIELD, "pressable w-full gap-2 sm:w-auto")}>
            <RotateCcwIcon />
            Try again
          </Button>
        </SettingsPanel>
      ) : (
        <SettingsPanel>
          <SettingsGroup title="Theme color" className="space-y-3">
            <p id="appearance-color-hint" className="text-muted-foreground">
              Primary color for buttons, links, active navigation and focus rings. Applies to every page.
            </p>
            {selected === null ? (
              <div aria-busy="true" className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                {PRIMARY_COLORS.map((preset) => (
                  <div key={preset.id} className="flex flex-col items-center gap-1.5 p-1.5">
                    <Skeleton className="h-11 w-full rounded-lg md:h-9" />
                    <Skeleton className="h-3 w-10" />
                  </div>
                ))}
              </div>
            ) : (
              <div
                role="radiogroup"
                aria-label="Theme color"
                aria-describedby="appearance-color-hint"
                className="grid grid-cols-4 gap-2 sm:grid-cols-8"
                onKeyDown={onKeyDown}
              >
                {PRIMARY_COLORS.map((preset) => {
                  const checked = preset.id === selected;
                  const isDefault = preset.id === DEFAULT_PRIMARY_COLOR;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-label={isDefault ? `${preset.label} (default)` : preset.label}
                      data-value={preset.id}
                      // Scopes this preset's tokens onto the swatch, so it previews the real colors.
                      {...{ [PRIMARY_COLOR_ATTRIBUTE]: preset.id }}
                      tabIndex={checked ? 0 : -1}
                      onClick={() => void onPick(preset.id)}
                      className={cn(
                        "flex min-w-0 flex-col items-center gap-1.5 rounded-lg p-1.5 transition-[background-color,box-shadow,scale] duration-150 ease-(--ease-fluid) outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:transition-none",
                        checked && "bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-11 w-full items-center justify-center rounded-lg bg-accent ring-1 ring-ring/40 ring-offset-card md:h-9",
                          checked && "ring-2 ring-primary ring-offset-2",
                        )}
                      >
                        <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm md:size-6">
                          {checked && <CheckIcon className="size-4 md:size-3.5" strokeWidth={3} />}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "w-full truncate text-center text-xs leading-tight",
                          checked ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {preset.label}
                        {isDefault && <span className="block text-[10px] text-muted-foreground">Default</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </SettingsGroup>
        </SettingsPanel>
      )}
    </SettingsSection>
  );
}
