"use client";

import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, FolderOpen, RotateCw, TriangleAlert } from "lucide-react";
import { fileIcon } from "@/components/board/file-icon";
import { errorMessage } from "@/components/board/format";
import { Skeleton } from "@/components/ui/skeleton";
import { type FileSource, fileSourceFolders, fileSourceKey, listSourceFiles } from "@/lib/file-source";
import type { ProjectFileHit } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Most entries one directory listing asks for (the server's cap). */
const TREE_LIMIT = 1000;

type Listing =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ok"; hits: ProjectFileHit[] };

/** One folder of the source shown as a top-level node; `id` is also its listing query. */
interface Root {
  id: string;
  label: string;
  title: string;
}

/**
 * One visible line of the flattened tree: a file or directory node, or a status line
 * (loading, error, empty, truncated) under the directory whose listing `query` it describes.
 */
type Row =
  | {
      type: "node";
      id: string;
      label: string;
      title: string;
      dir: boolean;
      depth: number;
      parentId: string | null;
    }
  | {
      type: "status";
      id: string;
      status: "loading" | "error" | "empty" | "truncated";
      query: string;
      error?: string;
      depth: number;
      parentId: string | null;
    };

function trimSlashes(folder: string): string {
  return folder.replace(/\/+$/, "") || "/";
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

/** `folder` with exactly one trailing slash: the listing query (and node id) of an extra folder. */
function folderQuery(folder: string): string {
  const trimmed = trimSlashes(folder);
  return trimmed === "/" ? "/" : `${trimmed}/`;
}

/**
 * Directory ids to expand so `id` becomes visible: its folder root (when roots are shown)
 * and every directory between that root and the file.
 */
function ancestorIds(id: string, extraRoots: string[], showRoots: boolean): string[] {
  let root = "";
  let rest = id;
  if (id.startsWith("/")) {
    const match = extraRoots
      .filter((candidate) => id.startsWith(candidate))
      .sort((a, b) => b.length - a.length)[0];
    if (match === undefined) return [];
    root = match;
    rest = id.slice(match.length);
  }
  const ids = showRoots ? [root] : [];
  const parts = rest.replace(/\/+$/, "").split("/");
  parts.pop();
  let acc = root;
  for (const part of parts) {
    if (!part) continue;
    acc += `${part}/`;
    ids.push(acc);
  }
  return ids;
}

/** The tree's rows in document order; their indexes match the flattened `rows`. */
function treeItems(tree: HTMLElement | null): HTMLElement[] {
  return tree ? [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')] : [];
}

/**
 * Lazily loaded tree of the source's files. With extra folders each folder (workdir first) is a
 * top-level node; otherwise the workdir's (or the folder source's) entries are the top level.
 * Node ids are `ProjectFileHit.insert` path ids; a directory's id is also its listing query.
 */
export function FileTree({
  source,
  selectedPath,
  onOpenFile,
  className,
}: {
  source: FileSource;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  className?: string;
}) {
  // Callers may pass a fresh source object every render; effects follow its key instead.
  const sourceKey = fileSourceKey(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const { workdir, extraFolders } = fileSourceFolders(source);
  const extraKey = extraFolders.join("\n");
  const showRoots = extraFolders.length > 0;
  const extraRoots = useMemo(() => (extraKey ? extraKey.split("\n").map(folderQuery) : []), [extraKey]);
  const roots = useMemo<Root[] | null>(() => {
    if (extraRoots.length === 0) return null;
    return [
      { id: "", label: basename(trimSlashes(workdir)), title: workdir },
      ...extraRoots.map((id) => ({ id, label: basename(id), title: trimSlashes(id) })),
    ];
  }, [workdir, extraRoots]);

  const [listings, setListings] = useState<Record<string, Listing>>({});
  // The workdir root starts open; extra folders open on demand.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(showRoots ? [""] : []));
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const inflightRef = useRef(new Map<string, AbortController>());
  const treeRef = useRef<HTMLDivElement>(null);
  /** The selected path last scrolled into view, so the tree scrolls once per selection. */
  const scrolledRef = useRef<string | null>(null);

  // A different source starts over; unmounting stops pending listings.
  useEffect(() => {
    const inflight = inflightRef.current;
    setListings({});
    setExpanded(new Set(fileSourceFolders(sourceRef.current).extraFolders.length > 0 ? [""] : []));
    return () => {
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    };
  }, [sourceKey]);

  const load = useCallback(
    (query: string) => {
      const inflight = inflightRef.current;
      inflight.get(query)?.abort();
      const controller = new AbortController();
      inflight.set(query, controller);
      setListings((prev) => ({ ...prev, [query]: { status: "loading" } }));
      listSourceFiles(sourceRef.current, query, { limit: TREE_LIMIT, signal: controller.signal })
        .then(({ files }) => {
          if (!controller.signal.aborted) setListings((prev) => ({ ...prev, [query]: { status: "ok", hits: files } }));
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) {
            setListings((prev) => ({ ...prev, [query]: { status: "error", error: errorMessage(err) } }));
          }
        })
        .finally(() => {
          if (inflight.get(query) === controller) inflight.delete(query);
        });
    },
    [],
  );

  // Every open directory (and the implicit top level) gets listed once; results stay cached.
  useEffect(() => {
    const wanted = showRoots ? [...expanded] : ["", ...expanded];
    for (const query of wanted) {
      if (!(query in listings) && !inflightRef.current.has(query)) load(query);
    }
  }, [expanded, listings, load, showRoots]);

  // Reveal the selected file: open its ancestors and make it the tree's tab stop.
  useEffect(() => {
    if (!selectedPath) return;
    const ids = ancestorIds(selectedPath, extraRoots, showRoots);
    setExpanded((prev) => {
      if (ids.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setFocusedId(selectedPath);
  }, [selectedPath, extraRoots, showRoots]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const walk = (query: string, depth: number, parentId: string | null): void => {
      const listing = listings[query];
      const status = (kind: "loading" | "error" | "empty" | "truncated", error?: string) => {
        out.push({ type: "status", id: `\u0000${kind}:${query}`, status: kind, query, error, depth, parentId });
      };
      if (!listing || listing.status === "loading") return status("loading");
      if (listing.status === "error") return status("error", listing.error);
      if (listing.hits.length === 0) return status("empty");
      for (const hit of listing.hits) {
        const dir = hit.kind === "dir";
        out.push({ type: "node", id: hit.insert, label: basename(hit.path), title: hit.insert, dir, depth, parentId });
        if (dir && expanded.has(hit.insert)) walk(hit.insert, depth + 1, hit.insert);
      }
      if (listing.hits.length >= TREE_LIMIT) status("truncated");
    };
    if (roots) {
      for (const root of roots) {
        out.push({ type: "node", id: root.id, label: root.label, title: root.title, dir: true, depth: 0, parentId: null });
        if (expanded.has(root.id)) walk(root.id, 1, root.id);
      }
    } else {
      walk("", 0, null);
    }
    return out;
  }, [roots, listings, expanded]);

  // Scroll the selected file into view once it is rendered (its ancestors may still be loading).
  useEffect(() => {
    if (!selectedPath || scrolledRef.current === selectedPath) return;
    const index = rows.findIndex((row) => row.id === selectedPath);
    if (index < 0) return;
    scrolledRef.current = selectedPath;
    treeItems(treeRef.current)[index]?.scrollIntoView({ block: "nearest" });
  }, [selectedPath, rows]);

  const toggle = (id: string, open?: boolean) => {
    setExpanded((prev) => {
      const isOpen = prev.has(id);
      if (open === isOpen) return prev;
      const next = new Set(prev);
      if (isOpen) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activate = (row: Row) => {
    if (row.type === "status") {
      if (row.status === "error") load(row.query);
      return;
    }
    if (row.dir) toggle(row.id);
    else onOpenFile(row.id);
  };

  // The roving tab stop: the focused row, else the selected file, else the first row.
  const tabStop = (() => {
    if (focusedId !== null && rows.some((row) => row.id === focusedId)) return focusedId;
    if (selectedPath !== null && rows.some((row) => row.id === selectedPath)) return selectedPath;
    return rows[0]?.id ?? null;
  })();

  const focusRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setFocusedId(row.id);
    treeItems(treeRef.current)[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const index = target ? treeItems(treeRef.current).indexOf(target) : -1;
    const row = rows[index];
    if (!row) return;
    const open = row.type === "node" && row.dir && expanded.has(row.id);
    switch (event.key) {
      case "ArrowDown":
        focusRow(Math.min(index + 1, rows.length - 1));
        break;
      case "ArrowUp":
        focusRow(Math.max(index - 1, 0));
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.type !== "node" || !row.dir) return;
        if (!open) toggle(row.id, true);
        else if (rows[index + 1]?.parentId === row.id) focusRow(index + 1);
        break;
      case "ArrowLeft":
        if (open) toggle(row.id, false);
        else if (row.parentId !== null) focusRow(rows.findIndex((r) => r.id === row.parentId));
        break;
      case "Enter":
      case " ":
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Project files"
      className={cn("min-h-0 overflow-auto py-1", className)}
      onKeyDown={onKeyDown}
    >
      {rows.map((row) => {
        const indent = { paddingLeft: `${8 + row.depth * 12}px` };
        if (row.type === "status") {
          return (
            <div
              key={row.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={false}
              aria-disabled={row.status !== "error"}
              aria-busy={row.status === "loading" || undefined}
              tabIndex={row.id === tabStop ? 0 : -1}
              style={indent}
              className="flex h-11 items-center gap-1.5 rounded-md pr-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset md:h-7"
              onFocus={() => setFocusedId(row.id)}
            >
              <span className="w-3.5 shrink-0" />
              {row.status === "loading" && (
                <>
                  <Skeleton className="h-3 w-28 max-w-full" aria-hidden />
                  <span className="sr-only">Loading…</span>
                </>
              )}
              {row.status === "empty" && <span className="truncate italic">Empty folder</span>}
              {row.status === "truncated" && <span className="truncate">Showing first {TREE_LIMIT} entries</span>}
              {row.status === "error" && (
                <>
                  <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-destructive" title={row.error}>
                    Couldn't load: {row.error}
                  </span>
                  <button
                    type="button"
                    tabIndex={-1}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-foreground hover:bg-accent max-md:min-h-9"
                    onClick={() => load(row.query)}
                  >
                    <RotateCw className="size-3" aria-hidden />
                    Retry
                  </button>
                </>
              )}
            </div>
          );
        }
        const open = row.dir && expanded.has(row.id);
        const selected = !row.dir && row.id === selectedPath;
        const Icon = row.dir ? (open ? FolderOpen : Folder) : fileIcon(row.label);
        return (
          <div
            key={row.id}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.dir ? open : undefined}
            aria-selected={selected}
            tabIndex={row.id === tabStop ? 0 : -1}
            title={row.title}
            style={indent}
            className={cn(
              "flex h-11 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-sm outline-none select-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset md:h-7",
              selected && "bg-accent text-accent-foreground hover:bg-accent",
            )}
            onFocus={() => setFocusedId(row.id)}
            onClick={() => activate(row)}
          >
            {row.dir ? (
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                  open && "rotate-90",
                )}
                aria-hidden
              />
            ) : (
              <span className="w-3.5 shrink-0" />
            )}
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{row.label}</span>
          </div>
        );
      })}
    </div>
  );
}
