"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { NewCardPageSkeleton, NewCardScreen } from "@/components/board/new-card-page";

export default function NewCardPage() {
  return (
    <Suspense fallback={<NewCardPageSkeleton />}>
      <NewCardRoute />
    </Suspense>
  );
}

function NewCardRoute() {
  const params = useParams<{ boardId: string }>();
  const boardId = String(params.boardId);
  // Keyed so switching project always starts a fresh screen, which picks up the carried-over draft.
  return <NewCardScreen key={boardId} boardId={boardId} />;
}
