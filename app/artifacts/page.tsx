"use client";

import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { ArtifactsBrowser } from "@/components/artifacts/artifacts-browser";
import { useDocumentTitle } from "@/hooks/use-document-title";

export default function ArtifactsPage() {
  useDocumentTitle("Artifacts");
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Artifacts" />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-[1400px] animate-page-in px-4 py-6 sm:px-6 md:py-8 lg:px-8 motion-reduce:animate-none">
          {/* `useSearchParams` (project, result and period live in the URL). */}
          <Suspense fallback={null}>
            <ArtifactsBrowser />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
