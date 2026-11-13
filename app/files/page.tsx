"use client";

import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { FilesPage } from "@/components/files/files-page";
import { useKeyboardViewport } from "@/hooks/use-keyboard-viewport";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { cn } from "@/lib/utils";

export default function FilesRoute() {
  useDocumentTitle("Files");
  const keyboard = useKeyboardViewport();
  return (
    <div
      className={cn(
        // Exactly the viewport minus the phone tab bar (BottomTabs renders an in-flow spacer of that
        // height below), so the page never scrolls; only the workspace inside does.
        "flex h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))] flex-col overflow-hidden bg-background md:h-dvh",
        // On-screen keyboard up: pin to the visible area, above the (now hidden) tab bar.
        keyboard && "fixed inset-x-0 top-0 z-50",
      )}
      style={keyboard ? { height: keyboard.height, transform: `translateY(${keyboard.top}px)` } : undefined}
    >
      <AppHeader title="Files" />
      <main className="px-safe flex min-h-0 flex-1 flex-col md:pb-safe">
        <div className="animate-page-in mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col px-2 py-2 sm:px-6 sm:py-4 lg:px-8">
          {/* `useSearchParams` (the source lives in the URL). */}
          <Suspense fallback={null}>
            <FilesPage />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
