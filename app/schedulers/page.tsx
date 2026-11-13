"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { SchedulerList } from "@/components/schedulers/scheduler-list";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";

export default function SchedulersPage() {
  useDocumentTitle("Schedulers");
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="Schedulers" />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tighter md:text-3xl">Schedulers</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Recurring cards: each run creates a regular card on its project and the agent starts.
              </p>
            </div>
            <Button asChild className="h-11 shrink-0 md:h-9">
              <Link href="/schedulers/new">
                <Plus aria-hidden />
                New scheduler
              </Link>
            </Button>
          </div>
          <SchedulerList />
        </div>
      </main>
    </div>
  );
}
