"use client";

import { ArrowDownUpIcon, CoinsIcon } from "lucide-react";
import { compactNumber, usd, wholeNumber } from "@/components/stats/shared";
import type { TaskUsage } from "@/lib/types";

const usdPrecise = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

const ITEM_CLASS = "inline-flex items-center gap-1 font-mono tabular-nums";

/** "$1.23"; spend under a cent reads "<$0.01" so it is not mistaken for none. */
function formatCost(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.01 ? `<${usd.format(0.01)}` : usd.format(costUsd);
}

/** Tooltip lines shared by the card and the detail panel. */
function describe(usage: TaskUsage): { cost: string; tokens: string } {
  return {
    cost: `Estimated cost: ${usdPrecise.format(usage.costUsd)} at the models' list prices, for ${wholeNumber.format(usage.requests)} model requests (agent and subagents, all runs)`,
    tokens: `Tokens: ${wholeNumber.format(usage.totalTokens)} total: ${wholeNumber.format(usage.inputTokens)} input, ${wholeNumber.format(usage.outputTokens)} output, ${wholeNumber.format(usage.cacheReadTokens)} cache read, ${wholeNumber.format(usage.cacheWriteTokens)} cache write`,
  };
}

/** Usage worth showing: none until the card's session made a model request. */
export function hasUsage(usage: TaskUsage | null): usage is TaskUsage {
  return usage !== null && usage.requests > 0;
}

/** Card meta row items: estimated cost and total tokens of the card's agent so far. */
export function CardUsage({ usage }: { usage: TaskUsage | null }) {
  if (!hasUsage(usage)) return null;
  const cost = formatCost(usage.costUsd);
  const tokens = compactNumber.format(usage.totalTokens);
  const titles = describe(usage);
  return (
    <span
      role="group"
      aria-label={`Estimated cost ${cost}, ${tokens} tokens`}
      className="inline-flex items-center gap-2.5"
    >
      <span className={ITEM_CLASS} title={titles.cost}>
        <CoinsIcon className="size-3.5" aria-hidden />
        {cost}
      </span>
      <span className={ITEM_CLASS} title={titles.tokens}>
        <ArrowDownUpIcon className="size-3.5" aria-hidden />
        {tokens}
        <span className="sr-only">tokens</span>
      </span>
    </span>
  );
}

/**
 * Value of the task detail's "Cost & tokens" row (callers omit the row unless `hasUsage`). Same
 * two-line layout as the Resources row.
 */
export function DetailUsage({ usage }: { usage: TaskUsage }) {
  const primary = `${formatCost(usage.costUsd)} · ${compactNumber.format(usage.totalTokens)} tokens`;
  const secondary = [
    `${compactNumber.format(usage.inputTokens)} in`,
    `${compactNumber.format(usage.outputTokens)} out`,
    `${compactNumber.format(usage.cacheReadTokens + usage.cacheWriteTokens)} cache`,
    `${wholeNumber.format(usage.requests)} requests`,
  ].join(" · ");
  const titles = describe(usage);
  return (
    <span className="block min-w-0" title={`${titles.cost}\n${titles.tokens}`}>
      <span className="block truncate font-mono tabular-nums">{primary}</span>
      <span className="block truncate text-xs font-normal text-muted-foreground">{secondary}</span>
    </span>
  );
}
