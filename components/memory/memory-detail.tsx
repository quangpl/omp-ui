"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckIcon, CopyIcon, ExternalLinkIcon, FileIcon, Loader2Icon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, formatDateTime, formatRelative } from "@/components/board/format";
import { cardHref, isMemoryUnavailable, LAYER_LABELS, typeLabel } from "@/components/memory/format";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import type { MemoryDetail, MemoryItem } from "@/lib/memory-types";
import { copyText } from "@/lib/utils";

/** Section heading inside the detail panel. */
function Label({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>;
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm tabular-nums">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-5 p-5" aria-busy="true">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-6 w-4/5" />
      <div className="grid grid-cols-2 gap-4">
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </div>
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

/**
 * Full record behind a list row: content, metadata, linked sessions (with their AgentMan cards),
 * related memories, and Forget. Renders inside the wide layout's side column or a phone sheet.
 */
export function MemoryDetailPanel({
  item,
  onClose,
  onOpen,
  onForgotten,
  onUnavailable,
  showClose = true,
}: {
  item: MemoryItem;
  onClose: () => void;
  /** Open another record (a related memory). */
  onOpen: (item: MemoryItem) => void;
  onForgotten: (item: MemoryItem) => void;
  onUnavailable: () => void;
  showClose?: boolean;
}) {
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    const layer = item.layer === "memory" ? "memory" : "observation";
    api.memory
      .get(item.id, { layer, sessionId: item.sessionId })
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isMemoryUnavailable(err)) onUnavailable();
        setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.layer, item.sessionId, onUnavailable]);

  const shown = detail ?? item;
  const canForget = shown.layer === "memory" || (shown.layer === "observation" && Boolean(shown.sessionId));

  const forget = async () => {
    setForgetting(true);
    try {
      await api.memory.forget(item.id, {
        layer: item.layer === "memory" ? "memory" : "observation",
        sessionId: item.sessionId,
      });
      toast.success("Memory forgotten", { description: item.title });
      setConfirming(false);
      onForgotten(item);
    } catch (err) {
      if (isMemoryUnavailable(err)) onUnavailable();
      toast.error("Couldn't forget this memory", { description: errorMessage(err) });
    } finally {
      setForgetting(false);
    }
  };

  const copyId = () => {
    copyText(item.id).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      (err: unknown) => toast.error("Couldn't copy", { description: errorMessage(err) }),
    );
  };

  return (
    <article aria-label="Memory detail" className="flex min-h-0 flex-col">
      <header className="flex items-start gap-2 border-b px-5 pt-4 pb-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{typeLabel(shown.type)}</Badge>
            <Badge variant="outline" className="text-muted-foreground">
              {LAYER_LABELS[shown.layer] ?? shown.layer}
            </Badge>
            {detail?.isLatest === false && <Badge variant="outline">Superseded</Badge>}
          </div>
          <h2 className="text-lg leading-snug font-semibold tracking-tight text-pretty">{shown.title}</h2>
        </div>
        {showClose && (
          <Button
            variant="ghost"
            size="icon"
            className="-mr-2 size-11 shrink-0 text-muted-foreground md:size-8"
            aria-label="Close detail"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        )}
      </header>

      {error ? (
        <div className="space-y-3 p-5">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" className="h-11 md:h-8" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : !detail ? (
        <DetailSkeleton />
      ) : (
        <div className="animate-fade-in-soft space-y-6 px-5 py-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Meta label="Project">{detail.project ?? "None"}</Meta>
            <Meta label={detail.layer === "memory" ? "Updated" : "Captured"}>
              {detail.updatedAt ? (
                <time dateTime={detail.updatedAt} title={formatDateTime(detail.updatedAt)}>
                  {formatRelative(detail.updatedAt)}
                </time>
              ) : (
                "Unknown"
              )}
            </Meta>
            {detail.importance !== null && (
              <Meta label={detail.layer === "memory" ? "Strength" : "Importance"}>{detail.importance} / 10</Meta>
            )}
            {detail.confidence !== null && <Meta label="Confidence">{Math.round(detail.confidence * 100)}%</Meta>}
            {detail.version !== null && <Meta label="Version">v{detail.version}</Meta>}
            {detail.origin && <Meta label="Origin">{detail.origin}</Meta>}
            {detail.agentId && <Meta label="Agent">{detail.agentId}</Meta>}
            {detail.forgetAfter && (
              <Meta label="Expires">
                <time dateTime={detail.forgetAfter} title={formatDateTime(detail.forgetAfter)}>
                  {formatRelative(detail.forgetAfter)}
                </time>
              </Meta>
            )}
          </dl>

          {detail.content && (
            <section className="space-y-2">
              <Label>Content</Label>
              <p className="max-h-96 overflow-y-auto rounded-lg bg-muted/50 px-3.5 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap scrollbar-subtle">
                {detail.content}
              </p>
            </section>
          )}

          {detail.facts.length > 0 && (
            <section className="space-y-2">
              <Label>Facts</Label>
              <ul className="space-y-1.5 text-sm">
                {detail.facts.map((fact, i) => (
                  <li key={i} className="border-l-2 border-border pl-3 leading-relaxed break-words">
                    {fact}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.concepts.length > 0 && (
            <section className="space-y-2">
              <Label>Concepts</Label>
              <div className="flex flex-wrap gap-1.5">
                {detail.concepts.map((concept) => (
                  <Badge key={concept} variant="outline" className="font-normal">
                    {concept}
                  </Badge>
                ))}
              </div>
            </section>
          )}

          {detail.files.length > 0 && (
            <section className="space-y-2">
              <Label>Files</Label>
              <ul className="space-y-1">
                {detail.files.map((file) => (
                  <li key={file} className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
                    <FileIcon className="size-3.5 shrink-0" />
                    <span className="truncate" title={file}>
                      {file}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            <Label>Sessions</Label>
            {detail.sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {detail.sessionIds.length > 0 ? "The linked session is no longer stored." : "Saved outside a session."}
              </p>
            ) : (
              <ul className="divide-y rounded-lg ring-1 ring-foreground/10">
                {detail.sessions.map((session) => (
                  <li key={session.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {session.card?.title ?? session.title ?? session.firstPrompt ?? session.id}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[session.project, session.startedAt ? formatRelative(session.startedAt) : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    {session.card && (
                      <Button asChild variant="outline" size="sm" className="h-11 shrink-0 md:h-7">
                        <Link href={cardHref(session.card)}>
                          Open card
                          <ExternalLinkIcon data-icon="inline-end" />
                        </Link>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {detail.related.length > 0 && (
            <section className="space-y-2">
              <Label>{detail.layer === "memory" ? "Related memories" : "Memories from this session"}</Label>
              <ul className="space-y-1">
                {detail.related.map((related) => (
                  <li key={related.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(related)}
                      className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted md:min-h-0"
                    >
                      <span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
                        {typeLabel(related.type)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{related.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <footer className="flex flex-wrap items-center gap-2 border-t pt-4">
            <Button variant="ghost" size="sm" className="h-11 font-mono text-xs text-muted-foreground md:h-7" onClick={copyId}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span className="max-w-48 truncate">{item.id}</span>
            </Button>
            {canForget && (
              <Button
                variant="destructive"
                size="sm"
                className="ml-auto h-11 md:h-7"
                onClick={() => setConfirming(true)}
              >
                <Trash2Icon />
                Forget
              </Button>
            )}
          </footer>
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={(open) => !forgetting && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget this {item.layer === "memory" ? "memory" : "observation"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes it from agentmemory for every agent; future recalls won't see it. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forgetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={forgetting}
              onClick={(event) => {
                event.preventDefault();
                void forget();
              }}
            >
              {forgetting && <Loader2Icon className="animate-spin motion-reduce:animate-none" />}
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
