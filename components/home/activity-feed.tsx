"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { CircleCheckIcon, CircleStopIcon, CircleXIcon, PlusIcon, UploadIcon } from "lucide-react";
import { formatDateTime, formatDuration, formatRelative } from "@/components/board/format";
import type { DashboardActivity, DashboardActivityKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS_RING, Panel, SectionTitle, cardHref, useEntrance } from "./shared";

const KIND: Record<DashboardActivityKind, { verb: string; icon: ReactNode; tone: string }> = {
  created: { verb: "Card created", icon: <PlusIcon />, tone: "text-muted-foreground" },
  succeeded: { verb: "Run finished", icon: <CircleCheckIcon />, tone: "text-success" },
  failed: { verb: "Run failed", icon: <CircleXIcon />, tone: "text-destructive" },
  stopped: { verb: "Run stopped", icon: <CircleStopIcon />, tone: "text-muted-foreground" },
  pushed: { verb: "Pushed", icon: <UploadIcon />, tone: "text-primary" },
};

export function ActivityFeed({ items, now }: { items: DashboardActivity[]; now: number }) {
  const enter = useEntrance();
  return (
    <section aria-labelledby="home-activity">
      <SectionTitle id="home-activity" title="Recent activity" />
      <Panel className="px-3 py-2">
        {items.length === 0 ? (
          <p className="py-1.5 text-xs text-pretty text-muted-foreground">
            Cards you create, agent runs and pushes from the last 30 days appear here.
          </p>
        ) : (
          <ol className="relative flex flex-col">
            {/* Timeline rail behind the icons. */}
            <span aria-hidden="true" className="absolute top-3 bottom-3 left-[11px] w-px bg-border" />
            {items.map((item, i) => {
              const kind = KIND[item.kind];
              const entrance = enter(i);
              const detail = [
                item.durationMs !== null && item.kind !== "created" && item.kind !== "pushed"
                  ? formatDuration(item.durationMs)
                  : null,
                item.detail,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={`${item.kind}:${item.taskId}:${item.at}`} style={entrance.style} className={entrance.className}>
                  <Link
                    href={cardHref({ boardId: item.boardId, id: item.taskId })}
                    className={cn(
                      "-mx-1 flex min-h-11 items-start gap-2.5 rounded-lg px-1 py-1.5 hover:bg-muted/50 md:min-h-0",
                      FOCUS_RING,
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "relative mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full border bg-card [&_svg]:size-3",
                        kind.tone,
                      )}
                    >
                      {kind.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2 text-xs">
                        <span className="font-medium">{kind.verb}</span>
                        <span className="truncate text-muted-foreground">{item.boardName}</span>
                        <time
                          dateTime={item.at}
                          title={formatDateTime(item.at)}
                          className="ml-auto shrink-0 text-muted-foreground tabular-nums"
                        >
                          {formatRelative(item.at, now)}
                        </time>
                      </span>
                      <span className="block truncate text-sm" title={item.title}>
                        {item.title}
                      </span>
                      {detail && (
                        <span
                          className={cn(
                            "block truncate text-xs text-muted-foreground",
                            item.kind === "failed" && "text-destructive/90",
                          )}
                          title={detail}
                        >
                          {detail}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
    </section>
  );
}
