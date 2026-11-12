import { FolderPlusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const STEPS = [
  { title: "Create a project", body: "From a folder on the server or a Git repository." },
  { title: "Add cards", body: "One card per task. Write it like you'd brief a teammate." },
  {
    title: "Press Start on a card",
    body: "The agent does the work. You review the result and comment if anything needs changing.",
  },
];

export function BoardsEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="animate-fade-in-soft mx-auto flex max-w-md flex-col items-center px-2 py-10 text-center sm:py-16">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <FolderPlusIcon className="size-7" />
      </div>
      <h2 className="mt-5 text-xl font-semibold tracking-tight">Create your first project</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Hand tasks to an omp coding agent from a simple kanban board.
      </p>

      <ol className="mt-8 w-full space-y-2.5 text-left">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex items-start gap-3 rounded-xl border bg-card p-3.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold tabular-nums">
              {i + 1}
            </span>
            <span className="min-w-0 pt-0.5">
              <span className="block text-sm font-medium">{step.title}</span>
              <span className="block text-sm text-muted-foreground">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>

      <Button onClick={onCreate} className="mt-8 h-11 w-full px-5 text-base sm:w-auto md:h-10 md:text-sm">
        <PlusIcon />
        New project
      </Button>
    </section>
  );
}
