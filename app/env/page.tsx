"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { errorText } from "@/components/credentials/utils";
import { EnvVarsEditor } from "@/components/env/env-vars-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api-client";
import type { EnvVar } from "@/lib/env-vars";

export default function EnvPage() {
  useDocumentTitle("Environment");
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.env.list().then((res) => setVars(res.vars), (err) => setError(errorText(err, "Could not load variables")));
  }, []);

  /** Runs a mutation and swaps in the list it answers; the error is toasted and rethrown for the caller. */
  async function run(request: Promise<{ vars: EnvVar[] }>) {
    try {
      setVars((await request).vars);
    } catch (err) {
      toast.error(errorText(err, "Could not save"));
      throw err;
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Environment" subtitle={vars ? `${vars.length} variable${vars.length === 1 ? "" : "s"}` : undefined} />
      <main className="px-safe pb-safe flex-1">
        <div className="animate-page-in mx-auto w-full max-w-[900px] space-y-4 px-4 py-6 sm:px-6 md:py-8">
          <p className="text-sm text-pretty text-muted-foreground">
            Variables every agent can read, in addition to the server&apos;s own environment (these win on a clash).
            Values are stored encrypted; changes apply to the next agent run.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : vars ? (
            <EnvVarsEditor
              vars={vars}
              onSet={(values) => run(api.env.set(values))}
              onRemove={(key) => run(api.env.remove(key))}
            />
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </div>
      </main>
    </div>
  );
}
