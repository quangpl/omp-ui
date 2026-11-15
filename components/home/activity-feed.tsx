"use client";

import { useId, type ReactNode } from "react";
import Link from "next/link";
import { CircleCheckIcon, CircleStopIcon, CircleXIcon, HistoryIcon, PlusIcon, UploadIcon } from "lucide-react";
import { formatDateTime, formatDuration, formatRelative } from "@/components/board/format";
import type { DashboardActivity, DashboardActivityKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmptyState, FOCUS_RING, SectionTitle, cardHref, useEntrance } from "./shared";

const KIND: Record<DashboardActivityKind, { verb: string; icon: ReactNode; tone: string }> = {
  created: { verb: "Card created", icon: <PlusIcon />, tone: "text-muted-foreground" },
  succeeded: { verb: "Run finished", icon: <CircleCheckIcon />, tone: "text-success" },
  failed: { verb: "Run failed", icon: <CircleXIcon />, tone: "text-destructive" },
  stopped: { verb: "Run stopped", icon: <CircleStopIcon />, tone: "text-muted-foreground" },
  pushed: { verb: "Pushed", icon: <UploadIcon />, tone: "text-primary" },
};

const DAYS = ["Today", "Yesterday", "Earlier"] as const;

/**
 * Buckets items by local calendar day relative to `now`. Boundaries are local midnights built with
 * `Date` (so DST days stay correct), not rolling 24 h windows. Feed order is kept within each day.
 */
function groupByDay(items: DashboardActivity[], now: number) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups: DashboardActivity[][] = [[], [], []];
  for (const item of items) {
    const at = new Date(item.at).getTime();
    // Clock skew can put an item slightly in the future: it still belongs to today.
    groups[at >= today.getTime() ? 0 : at >= yesterday.getTime() ? 1 : 2].push(item);
  }
  return DAYS.map((label, i) => ({ label, items: groups[i] })).filter((g) => g.items.length > 0);
}

export function ActivityFeed({ items, now }: { items: DashboardActivity[]; now: number }) {
  const enter = useEntrance();
  const headingId = useId();
  // One cascade across all days: headers and rows share a single running stagger index.
  let order = 0;
  return (
    <section aria-labelledby="home-activity">
      <SectionTitle id="home-activity" title="Recent activity" />
      {/* A timeline reads on negative space alone: no card, just a rule above it. */}
      <div className="border-t pt-2">
        {items.length === 0 ? (
          <EmptyState icon={<HistoryIcon />} title="No activity yet" hint="Runs, cards and pushes land here." />
        ) : (
          groupByDay(items, now).map((group, g) => {
            const id = `${headingId}-${g}`;
            const header = enter(order++);
            return (
              <div key={group.label} role="group" aria-labelledby={id}>
                <h3
                  id={id}
                  style={header.style}
                  className={cn(
                    "flex items-center gap-2 pb-1 text-[11px] font-medium text-muted-foreground",
                    g === 0 ? "pt-1" : "pt-3",
                    header.className,
                  )}
                >
                  {group.label}
                  <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
                </h3>
                <ol className="flex flex-col">
                  {group.items.map((item, i) => {
                    const kind = KIND[item.kind];
                    const entrance = enter(order++);
                    const last = i === group.items.length - 1;
                    const detail = [
                      item.durationMs !== null && item.kind !== "created" && item.kind !== "pushed"
                        ? formatDuration(item.durationMs)
                        : null,
                      item.detail,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <li
                        key={`${item.kind}:${item.taskId}:${item.at}`}
                        style={entrance.style}
                        className={cn("relative", entrance.className)}
                      >
                        {/* Rail segment from this icon's bottom edge to the next icon's top edge, centred on the 24px icon. */}
                        {!last && (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute top-8 -bottom-2 left-[11.5px] w-px bg-border"
                          />
                        )}
                        <Link
                          href={cardHref({ boardId: item.boardId, id: item.taskId })}
                          className={cn(
                            "pressable -mx-1 flex min-h-11 items-start gap-2.5 rounded-lg px-1 py-1.5 hover:bg-muted/50 active:bg-muted/60 md:min-h-0",
                            FOCUS_RING,
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "relative mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background [&_svg]:size-3.5",
                              kind.tone,
                            )}
                          >
                            {kind.icon}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="shrink-0 text-xs font-medium text-foreground">{kind.verb}</span>
                              <span className="truncate text-[11px] text-muted-foreground" title={item.boardName}>
                                {item.boardName}
                              </span>
                              <time
                                dateTime={item.at}
                                title={formatDateTime(item.at)}
                                className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
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
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
