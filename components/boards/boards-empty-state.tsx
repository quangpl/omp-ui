import type { CSSProperties } from "react";
import { FolderPlusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const STEPS = [
  { title: "Create a project", body: "From a folder on the server or a Git repository." },
  { title: "Add tasks", body: "One card per task. Brief it like a teammate." },
  {
    title: "Press Start on a card",
    body: "The agent does the work. Review it and comment if anything needs changing.",
  },
];

/**
 * First-run state of the projects page. Phones stack the pitch, the action and the steps in one
 * column; wider containers split them, pitch on the left and the numbered steps on the right.
 */
export function BoardsEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section
      aria-labelledby="boards-empty-title"
      className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-8 py-6 sm:py-10 @3xl/home:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] @3xl/home:items-center @3xl/home:gap-14 @3xl/home:py-16"
    >
      <div className="animate-fade-in-soft flex flex-col items-start">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <FolderPlusIcon className="size-6" aria-hidden="true" />
        </span>
        <h2 id="boards-empty-title" className="mt-5 text-2xl font-semibold tracking-tight text-balance">
          Create your first project
        </h2>
        <p className="mt-2 max-w-[42ch] text-sm leading-relaxed text-pretty text-muted-foreground">
          Hand tasks to an omp coding agent from a kanban board.
        </p>
        <Button onClick={onCreate} className="pressable mt-6 h-11 w-full px-5 text-base sm:w-auto md:h-10 md:text-sm">
          <PlusIcon />
          New project
        </Button>
      </div>

      <ol className="shadow-diffuse divide-y overflow-hidden rounded-xl border bg-card text-left">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className="animate-card-in flex items-start gap-3.5 p-4"
            style={{ "--stagger": i + 1 } as CSSProperties}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-sm font-semibold tabular-nums">
              {i + 1}
            </span>
            <span className="min-w-0 pt-0.5">
              <span className="block text-sm font-medium">{step.title}</span>
              <span className="mt-0.5 block text-sm text-pretty text-muted-foreground">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
