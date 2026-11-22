"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2Icon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { BoardFormDialog } from "@/components/boards/board-form-dialog";
import { AiProvidersSettingsSection } from "@/components/settings/ai-providers-settings";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api, type SystemInfo } from "@/lib/api-client";

const STEPS = ["Install omp", "AI provider", "Environment variables", "First project"];

function OmpStep() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState(0);
  useEffect(() => {
    setInfo(null);
    setError(null);
    api.system().then(setInfo, (err) => setError(err instanceof Error ? err.message : "Could not check omp."));
  }, [check]);
  const omp = info?.omp;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">OMP-UI runs your tasks with the omp coding agent.</p>
      {error ? (
        <p className="text-destructive">{error}</p>
      ) : !omp ? (
        <p className="text-muted-foreground">Checking…</p>
      ) : omp.installed ? (
        <p className="flex items-center gap-2">
          <CheckCircle2Icon className="size-4 text-emerald-500" />
          Found <code className="font-mono">{omp.path}</code>
          {omp.version && <span className="text-muted-foreground">({omp.version})</span>}
        </p>
      ) : (
        <p className="flex items-start gap-2">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            omp was not found at <code className="font-mono">{omp.path}</code>. Install it from{" "}
            <a className="underline" href="https://omp.sh" target="_blank" rel="noreferrer">
              omp.sh
            </a>
            , or set its path in <Link className="underline" href="/settings">Settings</Link>.
          </span>
        </p>
      )}
      <Button variant="outline" onClick={() => setCheck(check + 1)}>
        Check again
      </Button>
    </div>
  );
}

export default function OnboardingPage() {
  useDocumentTitle("Set up OMP-UI");
  const router = useRouter();
  const { isAdmin, loading } = useCurrentUser();
  const [step, setStep] = useState(0);
  const [projectOpen, setProjectOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Saving settings is what marks setup done (Dashboard.setup.settingsSaved), so the home page stops redirecting here.
  async function finish() {
    setSaving(true);
    try {
      await api.settings.update({});
      router.replace("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save settings.");
      setSaving(false);
    }
  }

  if (!loading && !isAdmin) {
    router.replace("/");
    return null;
  }
  const last = step === STEPS.length - 1;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Set up OMP-UI" />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8">
          <p className="text-sm text-muted-foreground">
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </p>
          {step === 0 && <OmpStep />}
          {step === 1 && <AiProvidersSettingsSection />}
          {step === 2 && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Variables such as API keys or tokens that every agent run receives. Optional.
              </p>
              <Button variant="outline" asChild>
                <Link href="/env" target="_blank">
                  Open Environment Variables
                </Link>
              </Button>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">A project points agents at a folder or Git repository.</p>
              <Button onClick={() => setProjectOpen(true)}>Create project</Button>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <Button variant="ghost" disabled={step === 0 || saving} onClick={() => setStep(step - 1)}>
              Back
            </Button>
            <div className="flex gap-2">
              {!last && (
                <Button variant="outline" onClick={() => setStep(step + 1)}>
                  Skip
                </Button>
              )}
              <Button disabled={saving} onClick={() => (last ? void finish() : setStep(step + 1))}>
                {last ? "Finish" : "Next"}
              </Button>
            </div>
          </div>
        </div>
      </main>
      <BoardFormDialog
        open={projectOpen}
        onOpenChange={setProjectOpen}
        onSaved={() => {
          setProjectOpen(false);
          void finish();
        }}
      />
    </div>
  );
}
