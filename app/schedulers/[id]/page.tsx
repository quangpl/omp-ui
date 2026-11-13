"use client";

import { useParams } from "next/navigation";
import { SchedulerDetail } from "@/components/schedulers/scheduler-detail";

export default function SchedulerPage() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  // Keyed so switching schedulers starts from a clean load instead of showing the previous one.
  return <SchedulerDetail key={id} id={id} />;
}
