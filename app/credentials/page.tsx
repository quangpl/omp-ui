"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ActivityIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { useNow } from "@/components/board/format";
import { type CredentialDialogState, CredentialFormDialog } from "@/components/credentials/credential-form-dialog";
import {
  CredentialsView,
  errorText,
  needsAttention,
  notifyCredentialsChanged,
  useCredentialsList,
} from "@/components/credentials/credentials-view";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api-client";
import type { CredentialProviderId, CredentialSummary } from "@/lib/credential-types";

export default function CredentialsPage() {
  useDocumentTitle("Credentials");
  const router = useRouter();
  const searchParams = useSearchParams();
  const list = useCredentialsList();
  const now = useNow(60_000);
  const [dialog, setDialog] = useState<CredentialDialogState | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  // Deep links: ?focus=<id> from the notification bell, ?new=1 to open the add dialog. The view
  // scrolls to and highlights the focused row once it is loaded; the URL is cleaned right away.
  const focusParam = searchParams.get("focus");
  const newParam = searchParams.get("new");
  useEffect(() => {
    if (!focusParam && !newParam) return;
    if (focusParam) setFocusId(focusParam);
    if (newParam) setDialog({ mode: "create" });
    router.replace("/credentials", { scroll: false });
  }, [focusParam, newParam, router]);

  const clearFocus = useCallback(() => setFocusId(null), []);

  async function checkAll() {
    setCheckingAll(true);
    try {
      const next = await api.credentials.checkAll();
      list.replace(next);
      notifyCredentialsChanged();
      const total = next.credentials.length;
      const failing = next.credentials.filter((c) => c.health === "failing").length;
      if (failing > 0) toast.warning(`${failing} of ${total} ${total === 1 ? "credential" : "credentials"} failing`);
      else toast.success(total === 1 ? "Credential is healthy" : `All ${total} credentials healthy`);
    } catch (err) {
      toast.error(errorText(err, "Could not check credentials"));
    } finally {
      setCheckingAll(false);
    }
  }

  async function handleSaved(saved: CredentialSummary) {
    setDialog(null);
    await list.reload();
    notifyCredentialsChanged();
    setFocusId(saved.id);
  }

  const credentials = list.data?.credentials ?? [];
  const attention = credentials.filter((c) => needsAttention(c, now)).length;
  const subtitle =
    list.data && credentials.length > 0
      ? [
          `${credentials.length} saved`,
          attention > 0 ? `${attention} need${attention === 1 ? "s" : ""} attention` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : undefined;

  const actions = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="pressable-icon size-11 rounded-full text-muted-foreground hover:text-foreground md:size-8 md:rounded-lg"
            aria-label="Check all credentials now"
            disabled={checkingAll || credentials.length === 0}
            onClick={() => void checkAll()}
          >
            {checkingAll ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <ActivityIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{checkingAll ? "Checking…" : "Check all now"}</TooltipContent>
      </Tooltip>
      <Button className="pressable h-11 gap-1.5 md:h-8" onClick={() => setDialog({ mode: "create" })}>
        <PlusIcon />
        <span className="hidden sm:inline">Add credential</span>
        <span className="sm:hidden">Add</span>
      </Button>
    </>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Credentials" subtitle={subtitle} actions={actions} />
      <main className="px-safe pb-safe flex-1">
        <div className="animate-page-in mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 md:py-8 lg:px-8">
          <CredentialsView
            list={list}
            focusId={focusId}
            onFocusHandled={clearFocus}
            onCreate={(providerId?: CredentialProviderId) => setDialog({ mode: "create", providerId })}
            onEdit={(credential) => setDialog({ mode: "edit", credential })}
          />
        </div>
      </main>
      <CredentialFormDialog state={dialog} onClose={() => setDialog(null)} onSaved={(saved) => void handleSaved(saved)} />
    </div>
  );
}
