"use client";

import { Suspense, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FolderX, RotateCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { errorMessage } from "@/components/board/format";
import { NewTaskForm } from "@/components/board/new-task-form";
import { ProjectField } from "@/components/board/project-field";
import {
  ScheduleFields,
  STICKY_FORM_ACTIONS,
  defaultScheduleValue,
  scheduleError,
  type ScheduleValue,
} from "@/components/schedulers/schedule-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api-client";
import { LAST_BOARD_KEY } from "@/lib/new-card-route";
import type { BoardWithCounts } from "@/lib/types";

/** `/schedulers/new` (`?boardId=` preselects the project): the "New task" composer plus a schedule. */
export default function NewSchedulerPage() {
  useDocumentTitle("New scheduler");
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader title="New scheduler" backHref="/schedulers" />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-2xl animate-page-in px-4 py-6 sm:px-6 md:py-8 motion-reduce:animate-none">
          <p className="mb-6 text-sm text-muted-foreground">
            Creates a card from the same text on a schedule, in the project&apos;s normal agent flow.
          </p>
          <Suspense fallback={<NewSchedulerSkeleton />}>
            <NewSchedulerLoader />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

/** Loads the projects, then picks the preselected one: `?boardId=`, else the last used, else the first. */
function NewSchedulerLoader() {
  const searchParams = useSearchParams();
  const wanted = searchParams.get("boardId");
  const [boards, setBoards] = useState<BoardWithCounts[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.boards
      .list()
      .then((list) => {
        if (!cancelled) setBoards(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (boards === null) {
    if (error) {
      return (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-10 text-center">
          <TriangleAlert className="mx-auto size-6 text-destructive" aria-hidden />
          <p className="mt-2 text-sm font-medium">Couldn&apos;t load projects</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" className="mt-4 h-11 md:h-9" onClick={() => setAttempt((n) => n + 1)}>
            <RotateCw aria-hidden />
            Retry
          </Button>
        </div>
      );
    }
    return <NewSchedulerSkeleton />;
  }

  if (boards.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-12 text-center">
        <FolderX className="mx-auto size-7 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-base font-medium">No projects yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          A scheduler creates its cards on a project.{" "}
          <Link href="/" className="font-medium text-foreground underline underline-offset-4">
            Create a project
          </Link>{" "}
          first.
        </p>
      </div>
    );
  }

  let lastBoard: string | null = null;
  try {
    lastBoard = localStorage.getItem(LAST_BOARD_KEY);
  } catch {
    // Storage unavailable: fall back to the first project.
  }
  const initialBoardId =
    boards.find((b) => b.id === wanted)?.id ?? boards.find((b) => b.id === lastBoard)?.id ?? boards[0].id;
  return <NewSchedulerForm boards={boards} initialBoardId={initialBoardId} />;
}

/**
 * The form proper, mounted once the projects are known (so the browser's time zone default and
 * the preselected project never go through server rendering).
 */
function NewSchedulerForm({ boards, initialBoardId }: { boards: BoardWithCounts[]; initialBoardId: string }) {
  const router = useRouter();
  const id = useId();
  const [boardId, setBoardId] = useState(initialBoardId);
  const [name, setName] = useState("");
  const [firstLine, setFirstLine] = useState("");
  const [schedule, setSchedule] = useState<ScheduleValue>(defaultScheduleValue);

  const create = async (text: string): Promise<boolean> => {
    try {
      const scheduler = await api.schedulers.create({
        boardId,
        prompt: text,
        name: name.trim() || undefined,
        ...schedule,
        cron: schedule.cron.trim(),
        timezone: schedule.timezone.trim(),
      });
      toast.success("Scheduler created", { description: scheduler.name });
      router.push(`/schedulers/${encodeURIComponent(scheduler.id)}`);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };

  return (
    <NewTaskForm
      layout="dialog"
      className={STICKY_FORM_ACTIONS}
      boardId={boardId}
      projectField={
        <div className="grid gap-4 sm:grid-cols-2">
          <ProjectField boards={boards} value={boardId} onValueChange={setBoardId} />
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-name`}>
              Name <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={200}
              autoComplete="off"
              placeholder={firstLine || "Defaults to the first line"}
              className="h-11 md:h-9"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </div>
      }
      label="What should the agent do each time?"
      hint={
        <>
          Every run creates a regular card from this text: it goes to In progress and its agent starts with the
          text as its brief. Type <Kbd>/</Kbd> for OMP skills, <Kbd>@</Kbd> to mention project files.
        </>
      }
      submitLabel="Create scheduler"
      busyLabel="Creating…"
      canSubmit={!scheduleError(schedule) && !!boardId}
      resetOnSubmit={false}
      parallelizeToggle={false}
      memoryToggle={false}
      onTextChange={(text) => setFirstLine(text.trim().split("\n", 1)[0]?.trim().slice(0, 200) ?? "")}
      onSubmit={create}
      onCancel={() => router.push("/schedulers")}
    >
      <ScheduleFields value={schedule} onChange={setSchedule} />
    </NewTaskForm>
  );
}

/** Placeholder matching the form's layout, so nothing jumps when it mounts. */
function NewSchedulerSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-11 w-full md:h-9" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-56 max-w-full" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 sm:flex sm:justify-between">
        <Skeleton className="h-11 w-24 md:h-9" />
        <Skeleton className="h-11 sm:w-40 md:h-9" />
      </div>
    </div>
  );
}
