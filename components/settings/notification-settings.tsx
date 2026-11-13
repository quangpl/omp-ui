"use client";

import { useCallback, useEffect, useState } from "react";
import { BellIcon, BellRingIcon, CheckIcon, Loader2Icon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { SettingsGroup, SettingsPanel, SettingsSection, SettingsToggle } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { notificationPermission, requestNotificationPermission } from "@/lib/notifications";
import { cn } from "@/lib/utils";

const FIELD = "h-11 md:h-9";

type Permission = NotificationPermission | "unsupported";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Toast for a permission request that didn't end in "granted". */
function permissionToast(permission: Exclude<Permission, "granted">) {
  if (permission === "denied") {
    toast.error("Notifications are blocked for this site", {
      description: "Allow notifications for this site in your browser settings, then try again.",
    });
  } else if (permission === "unsupported") {
    toast.error("This browser doesn't support notifications");
  } else {
    toast("Notification permission not granted");
  }
}

/** This browser's permission, as a one-line status under the toggle. */
function PermissionStatus({ permission }: { permission: Permission }) {
  if (permission === "granted") {
    return (
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <CheckIcon className="mt-px size-3.5 shrink-0 text-success" aria-hidden="true" />
        Allowed in this browser
      </p>
    );
  }
  if (permission === "denied") {
    return (
      <p className="flex items-start gap-2 text-xs text-pretty text-amber-700 dark:text-amber-400">
        <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        Blocked in this browser — allow notifications for this site in your browser settings
      </p>
    );
  }
  return (
    <p className="text-xs text-pretty text-muted-foreground">
      {permission === "unsupported"
        ? "Not supported in this browser"
        : "This browser will ask for permission when you turn this on"}
    </p>
  );
}

/**
 * Settings → Notifications: a browser notification when a card on the open board moves to Done.
 * The setting is server-wide but permission is per browser, so permission is asked for only when
 * the user turns it on (or presses "Allow notifications"), never on mount.
 */
export function NotificationSettingsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState(false);
  // Unknown until mounted: `Notification` doesn't exist during SSR.
  const [permission, setPermission] = useState<Permission | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api.settings
      .get()
      .then((settings) => setEnabled(settings.taskCompletionNotifications))
      .catch((err) => setLoadError(errorText(err, "Could not load the notification settings.")));
  }, []);

  useEffect(load, [load]);
  useEffect(() => setPermission(notificationPermission()), []);

  async function save(next: boolean) {
    setSaving(true);
    try {
      const settings = await api.settings.update({ taskCompletionNotifications: next });
      setEnabled(settings.taskCompletionNotifications);
      toast.success(next ? "Task notifications on" : "Task notifications off");
    } catch (err) {
      toast.error(errorText(err, "Could not save the notification setting."));
    } finally {
      setSaving(false);
    }
  }

  async function onToggle(checked: boolean) {
    if (saving) return;
    if (!checked) {
      await save(false);
      return;
    }
    setSaving(true);
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result !== "granted") {
      setSaving(false);
      permissionToast(result);
      return;
    }
    await save(true);
  }

  async function allow() {
    setRequesting(true);
    try {
      const result = await requestNotificationPermission();
      setPermission(result);
      if (result === "granted") toast.success("Notifications allowed in this browser");
      else permissionToast(result);
    } finally {
      setRequesting(false);
    }
  }

  const unsupported = permission === "unsupported";
  const needsPermission = enabled === true && (permission === "default" || permission === "denied");

  return (
    <SettingsSection
      id="notifications"
      icon={<BellIcon />}
      title="Notifications"
      description="Get a browser notification when a card on the open project finishes."
    >
      {loadError ? (
        <SettingsPanel className="flex flex-col items-start gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="flex min-w-0 flex-1 gap-3">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">Couldn't load notification settings</p>
              <p className="text-destructive">{loadError}</p>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={load} className={cn(FIELD, "w-full gap-2 sm:w-auto")}>
            <RotateCcwIcon />
            Try again
          </Button>
        </SettingsPanel>
      ) : enabled === null ? (
        <SettingsPanel>
          <div aria-busy="true" className="space-y-3 p-4 sm:p-5">
            <div className="flex items-center gap-4">
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-full max-w-md" />
              </div>
              <Skeleton className="h-[18px] w-8 rounded-full" />
            </div>
            <Skeleton className="h-3 w-48" />
          </div>
        </SettingsPanel>
      ) : (
        <SettingsPanel>
          <SettingsGroup className="space-y-3">
            <SettingsToggle
              htmlFor="task-completion-notifications"
              title="Task completion"
              description="Notify when a card on the open project moves to Done. Click the notification to go to the main page."
            >
              <Switch
                id="task-completion-notifications"
                checked={enabled}
                disabled={saving || unsupported}
                onCheckedChange={(checked) => void onToggle(checked)}
              />
            </SettingsToggle>
            {permission && (
              <div aria-live="polite">
                <PermissionStatus permission={permission} />
              </div>
            )}
            {needsPermission && (
              <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3 sm:flex-row sm:items-center">
                <p className="min-w-0 flex-1 text-xs text-pretty text-muted-foreground">
                  Notifications are on, but this browser hasn't allowed them yet. Permission is per browser.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void allow()}
                  disabled={requesting}
                  className={cn(FIELD, "w-full gap-2 active:scale-[0.98] sm:w-auto")}
                >
                  {requesting ? <Loader2Icon className="animate-spin" /> : <BellRingIcon />}
                  Allow notifications
                </Button>
              </div>
            )}
          </SettingsGroup>
        </SettingsPanel>
      )}
    </SettingsSection>
  );
}
