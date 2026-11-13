"use client";

import Link from "next/link";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BoardWithCounts } from "@/lib/types";

/**
 * "Project" picker of the "New task" form: a loading line while `boards` is `null`, a pointer to
 * create one when there are none, else a select. `onLeave` runs when its link navigates away.
 */
export function ProjectField({
  boards,
  value,
  onValueChange,
  onLeave,
}: {
  boards: BoardWithCounts[] | null;
  value: string;
  onValueChange: (boardId: string) => void;
  onLeave?: () => void;
}) {
  if (boards === null) return <p className="text-sm text-muted-foreground">Loading projects…</p>;
  if (boards.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No projects yet.{" "}
        <Link href="/" className="font-medium text-foreground underline underline-offset-4" onClick={onLeave}>
          Create a project
        </Link>{" "}
        first.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="new-card-project">Project</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id="new-card-project" className="w-full data-[size=default]:h-11 md:data-[size=default]:h-9">
          <SelectValue placeholder="Pick a project" />
        </SelectTrigger>
        <SelectContent>
          {boards.map((board) => (
            <SelectItem key={board.id} value={board.id} className="max-md:min-h-11">
              {board.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
