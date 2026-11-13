"use client";

import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  ClipboardCopy,
  ClipboardList,
  ClipboardPaste,
  Copy,
  CopyPlus,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  type LucideIcon,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  RotateCw,
  Scissors,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { fileIcon } from "@/components/board/file-icon";
import {
  DeleteFileDialog,
  type FileAction,
  type FileActionGroups,
  FileActionsDrawer,
  FileMenuItems,
  InlineNameInput,
} from "@/components/board/file-tree-menu";
import { errorMessage } from "@/components/board/format";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { ApiRequestError } from "@/lib/api-client";
import {
  absoluteSourcePath,
  applySourceFileOp,
  type FileSource,
  fileSourceFolders,
  fileSourceKey,
  listSourceFiles,
} from "@/lib/file-source";
import { isMacPlatform } from "@/lib/hotkeys";
import type { FileOp, FileOpResult, ProjectFileHit } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Most entries one directory listing asks for (the server's cap). */
const TREE_LIMIT = 1000;

/** Touch hold that opens a row's actions on phones. */
const LONG_PRESS_MS = 500;

/** Id of the inline "new file/folder" row. */
const EDIT_ROW_ID = "\u0000edit";

/** Dense on desktop; thumb-sized items on touch-first devices with a keyboard or stylus. */
const MENU_CONTENT = "w-60 pointer-coarse:**:data-[slot=context-menu-item]:min-h-11";

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
 * One visible line of the flattened tree: a file or directory node, the inline row naming a new
 * item, or a status line (loading, error, empty, truncated) under the directory whose listing
 * `query` it describes.
 */
type Row =
  | {
      type: "node";
      id: string;
      label: string;
      title: string;
      dir: boolean;
      /** A project folder shown as a top-level node (no rename/delete/cut). */
      root: boolean;
      depth: number;
      parentId: string | null;
    }
  | { type: "edit"; id: string; dir: boolean; depth: number; parentId: string | null }
  | {
      type: "status";
      id: string;
      status: "loading" | "error" | "empty" | "truncated";
      query: string;
      error?: string;
      depth: number;
      parentId: string | null;
    };

type NodeRow = Extract<Row, { type: "node" }>;

/** What a menu acts on: a file, a folder, or a project folder root (also the empty tree area). */
interface Target {
  id: string;
  name: string;
  kind: "root" | "dir" | "file";
}

/** The inline name field: naming a new item inside folder `parent`, or renaming `id`. */
type Editing = { mode: "new"; dir: boolean; parent: string } | { mode: "rename"; id: string };

/** Cut/copied item waiting for a paste. */
interface Clip {
  mode: "cut" | "copy";
  path: string;
  kind: "file" | "dir";
}

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

/** Folder id holding `id` ("src/a.ts" → "src/", "a.ts" → "", "/x/y/" → "/x/"). */
function parentOf(id: string): string {
  const trimmed = id.replace(/\/+$/, "");
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

/** Directory id form of `id` (one trailing slash). */
function dirId(id: string): string {
  return id.endsWith("/") ? id : `${id}/`;
}

/** Name of the n-th copy, like VSCode: "a.ts", "a copy.ts", "a copy 2.ts". */
function copyName(name: string, dir: boolean, n: number): string {
  if (n === 0) return name;
  const dot = dir ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`;
}

function isConflict(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 409;
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
  } catch {
    toast.error(`Couldn't copy ${what}`);
  }
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

function HeaderButton({ label, icon: Icon, onClick }: { label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="size-11 shrink-0 text-muted-foreground pressable-icon hover:text-foreground md:size-7"
          onClick={onClick}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Lazily loaded tree of the source's files with VSCode-style file management: right-click (or, on
 * phones, a row's "…" button / long-press) for new file/folder, rename (F2), delete, duplicate,
 * cut/copy/paste and copy path. With extra folders each folder (workdir first) is a top-level node;
 * otherwise the workdir's (or the folder source's) entries are the top level. Node ids are
 * `ProjectFileHit.insert` path ids; a directory's id is also its listing query.
 */
export function FileTree({
  source,
  selectedPath,
  onOpenFile,
  onFileOp,
  className,
}: {
  source: FileSource;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  /** After a create/rename/copy/delete succeeded (the tree has already started reloading). */
  onFileOp?: (op: FileOp, result: FileOpResult) => void;
  className?: string;
}) {
  // Callers may pass a fresh source object every render; effects follow its key instead.
  const sourceKey = fileSourceKey(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const isMobile = useIsMobile();
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
  const [clipboard, setClipboard] = useState<Clip | null>(null);
  const [editing, setEditingState] = useState<Editing | null>(null);
  /** Target of the open right-click menu. */
  const [menuTarget, setMenuTarget] = useState<Target | null>(null);
  /** Phones: the actions sheet (kept while it animates closed). */
  const [sheet, setSheet] = useState<{ target: Target; open: boolean } | null>(null);
  /** Item waiting on the delete confirmation (kept while it animates closed). */
  const [doomed, setDoomed] = useState<{ target: Target; open: boolean } | null>(null);
  // Shortcut hints follow the platform; read after mount (navigator isn't there on the server).
  const [keys, setKeys] = useState({ mod: "Ctrl+", del: "Del" });
  useEffect(() => setKeys(isMacPlatform() ? { mod: "⌘", del: "⌘⌫" } : { mod: "Ctrl+", del: "Del" }), []);

  const inflightRef = useRef(new Map<string, AbortController>());
  const listingsRef = useRef(listings);
  listingsRef.current = listings;
  /** Mirrors `editing` synchronously, for menus deciding whether to hand focus back on close. */
  const editingRef = useRef<Editing | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  /** The selected path last scrolled into view, so the tree scrolls once per selection. */
  const scrolledRef = useRef<string | null>(null);
  /** Row to scroll to (and maybe focus) once it is rendered: an op's result, or after an inline edit. */
  const revealRef = useRef<{ id: string; focus: boolean } | null>(null);
  const longPressRef = useRef<{ timer: number; x: number; y: number } | null>(null);
  /** A long-press just opened the actions sheet: the click that follows the release is not a tap. */
  const suppressClickRef = useRef(false);

  const setEditing = (next: Editing | null) => {
    editingRef.current = next;
    setEditingState(next);
  };

  // A different source starts over; unmounting stops pending listings.
  useEffect(() => {
    const inflight = inflightRef.current;
    setListings({});
    setExpanded(new Set(fileSourceFolders(sourceRef.current).extraFolders.length > 0 ? [""] : []));
    setClipboard(null);
    editingRef.current = null;
    setEditingState(null);
    setSheet(null);
    setDoomed(null);
    return () => {
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    };
  }, [sourceKey]);

  useEffect(
    () => () => {
      if (longPressRef.current) clearTimeout(longPressRef.current.timer);
    },
    [],
  );

  /** Lists `query`; `quiet` keeps the current entries on screen until the fresh ones arrive. */
  const load = useCallback(
    (query: string, quiet = false) => {
      const inflight = inflightRef.current;
      inflight.get(query)?.abort();
      const controller = new AbortController();
      inflight.set(query, controller);
      if (!quiet) setListings((prev) => ({ ...prev, [query]: { status: "loading" } }));
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

  /** Reloads every directory listed so far, in place. */
  const refresh = useCallback(() => {
    for (const query of Object.keys(listingsRef.current)) load(query, true);
  }, [load]);

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
      const naming = editing?.mode === "new" && editing.parent === query ? editing : null;
      if (naming) out.push({ type: "edit", id: EDIT_ROW_ID, dir: naming.dir, depth, parentId });
      const listing = listings[query];
      const status = (kind: "loading" | "error" | "empty" | "truncated", error?: string) => {
        out.push({ type: "status", id: `\u0000${kind}:${query}`, status: kind, query, error, depth, parentId });
      };
      if (!listing || listing.status === "loading") return status("loading");
      if (listing.status === "error") return status("error", listing.error);
      if (listing.hits.length === 0) return naming ? undefined : status("empty");
      for (const hit of listing.hits) {
        const dir = hit.kind === "dir";
        out.push({
          type: "node",
          id: hit.insert,
          label: basename(hit.path),
          title: hit.insert,
          dir,
          root: false,
          depth,
          parentId,
        });
        if (dir && expanded.has(hit.insert)) walk(hit.insert, depth + 1, hit.insert);
      }
      if (listing.hits.length >= TREE_LIMIT) status("truncated");
    };
    if (roots) {
      for (const root of roots) {
        out.push({
          type: "node",
          id: root.id,
          label: root.label,
          title: root.title,
          dir: true,
          root: true,
          depth: 0,
          parentId: null,
        });
        if (expanded.has(root.id)) walk(root.id, 1, root.id);
      }
    } else {
      walk("", 0, null);
    }
    return out;
  }, [roots, listings, expanded, editing]);

  // Scroll the selected file into view once it is rendered (its ancestors may still be loading).
  useEffect(() => {
    if (!selectedPath || scrolledRef.current === selectedPath) return;
    const index = rows.findIndex((row) => row.id === selectedPath);
    if (index < 0) return;
    scrolledRef.current = selectedPath;
    treeItems(treeRef.current)[index]?.scrollIntoView({ block: "nearest" });
  }, [selectedPath, rows]);

  // Scroll to (and, unless focus moved elsewhere, focus) a revealed row once it is rendered.
  useEffect(() => {
    const reveal = revealRef.current;
    if (reveal === null) return;
    const item = treeItems(treeRef.current).find((el) => el.dataset.nodeId === reveal.id);
    if (!item) return;
    revealRef.current = null;
    item.scrollIntoView({ block: "nearest" });
    const active = document.activeElement;
    const free = !active || active === document.body || treeRef.current?.contains(active);
    if (reveal.focus && free) item.focus({ preventScroll: true });
  }, [rows, editing]);

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
    if (row.type === "edit") return;
    if (row.type === "status") {
      if (row.status === "error") load(row.query);
      return;
    }
    setFocusedId(row.id);
    if (row.dir) toggle(row.id);
    else onOpenFile(row.id);
  };

  // ---- File operations ----

  const rootTarget: Target = { id: "", name: roots?.[0]?.label ?? basename(trimSlashes(workdir)), kind: "root" };
  const targetOf = (row: NodeRow): Target => ({
    id: row.id,
    name: row.label,
    kind: row.root ? "root" : row.dir ? "dir" : "file",
  });
  /** Where new items and pastes for a target go: the folder itself, or a file's folder. */
  const folderOf = (target: Target) => (target.kind === "file" ? parentOf(target.id) : target.id);
  /** The focused row's folder (VSCode's selection), else the top level. */
  const currentFolder = (): string => {
    const row = rows.find((r) => r.type === "node" && r.id === focusedId);
    return row?.type === "node" ? (row.dir ? row.id : parentOf(row.id)) : "";
  };
  const folderName = (folder: string) => (folder === "" ? rootTarget.name : basename(folder));
  /** `id` relative to its project folder (extra-folder ids are absolute). */
  const relativePath = (id: string): string => {
    const root = id.startsWith("/")
      ? extraRoots.filter((candidate) => id.startsWith(candidate)).sort((a, b) => b.length - a.length)[0]
      : undefined;
    return (root ? id.slice(root.length) : id).replace(/\/+$/, "");
  };

  /** Opens `id`'s ancestors, then scrolls to it (and focuses it when `focus`) once it's rendered. */
  const reveal = (id: string, focus: boolean) => {
    const ids = ancestorIds(id, extraRoots, showRoots);
    setExpanded((prev) => {
      if (ids.every((ancestor) => prev.has(ancestor))) return prev;
      const next = new Set(prev);
      for (const ancestor of ids) next.add(ancestor);
      return next;
    });
    setFocusedId(id);
    revealRef.current = { id, focus };
  };

  /** Forgets cached listings and open folders under the removed folder `from`, or moves them to `to`. */
  const rehome = (from: string, to: string | null) => {
    const keep = (key: string) => !key.startsWith(from);
    for (const [key, controller] of inflightRef.current) {
      if (!keep(key)) {
        controller.abort();
        inflightRef.current.delete(key);
      }
    }
    listingsRef.current = Object.fromEntries(Object.entries(listingsRef.current).filter(([key]) => keep(key)));
    setListings((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => keep(key))));
    setExpanded((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (keep(id)) next.add(id);
        else if (to !== null) next.add(to + id.slice(from.length));
      }
      return next;
    });
  };

  /**
   * Runs `op`, then updates the tree (reload, reveal the result) and tells the caller. `focus`
   * false leaves keyboard focus where it is (the op was committed by focus moving away).
   */
  const runOp = async (op: FileOp, focus = true): Promise<FileOpResult> => {
    const opSource = fileSourceKey(sourceRef.current);
    const result = await applySourceFileOp(sourceRef.current, op);
    if (fileSourceKey(sourceRef.current) !== opSource) return result;
    const gone = op.op === "delete" ? op.path : op.op === "rename" ? op.from : null;
    if (gone !== null) {
      if (result.kind === "dir") rehome(dirId(gone), op.op === "rename" ? dirId(result.path) : null);
      setClipboard((clip) =>
        clip && (clip.path === gone || (result.kind === "dir" && clip.path.startsWith(dirId(gone)))) ? null : clip,
      );
    }
    refresh();
    if (op.op === "delete") {
      const parent = parentOf(op.path);
      if (rows.some((row) => row.type === "node" && row.id === parent)) reveal(parent, focus);
    } else {
      reveal(result.path, focus);
    }
    onFileOp?.(op, result);
    if (op.op === "create-file") onOpenFile(result.path);
    return result;
  };

  /** Copies `from` into `folder`, picking a free name ("a copy.ts", "a copy 2.ts", …) when taken. */
  const copyInto = async (folder: string, from: string, dir: boolean): Promise<FileOpResult> => {
    const base = basename(from);
    const listing = listingsRef.current[folder];
    const taken = new Set(listing?.status === "ok" ? listing.hits.map((hit) => basename(hit.path)) : []);
    for (let n = 0; n < 100; n++) {
      const name = copyName(base, dir, n);
      if (taken.has(name)) continue;
      try {
        return await runOp({ op: "copy", from, to: folder + name });
      } catch (err) {
        if (!isConflict(err)) throw err;
        taken.add(name);
      }
    }
    throw new Error(`No free name for a copy of ${base}`);
  };

  const startNew = (dir: boolean, folder: string) => {
    if (folder !== "" || showRoots) toggle(folder, true);
    setEditing({ mode: "new", dir, parent: folder });
  };

  const startRename = (target: Target) => {
    if (target.kind !== "root") setEditing({ mode: "rename", id: target.id });
  };

  /** Closes the inline field; `refocus` hands focus back to `focusId`'s row. */
  const endEdit = (focusId: string, refocus: boolean) => {
    setEditing(null);
    if (refocus) revealRef.current = { id: focusId, focus: true };
  };

  const submitNew = async (name: string, fromBlur: boolean): Promise<string | null> => {
    const current = editingRef.current;
    if (current?.mode !== "new") return null;
    const path = current.parent + name;
    // A trailing "/" names a folder, like in VSCode.
    const op: FileOp = current.dir || name.endsWith("/") ? { op: "create-dir", path } : { op: "create-file", path };
    try {
      await runOp(op, !fromBlur);
      setEditing(null);
      return null;
    } catch (err) {
      return isConflict(err) ? `${name} already exists here.` : errorMessage(err);
    }
  };

  const submitRename = async (row: NodeRow, name: string, fromBlur: boolean): Promise<string | null> => {
    if (name === row.label) {
      endEdit(row.id, !fromBlur);
      return null;
    }
    try {
      await runOp({ op: "rename", from: row.id, to: parentOf(row.id) + name }, !fromBlur);
      setEditing(null);
      return null;
    } catch (err) {
      return isConflict(err) ? `${name} already exists here.` : errorMessage(err);
    }
  };

  const clip = (target: Target, mode: Clip["mode"]) => {
    if (target.kind === "root") return;
    setClipboard({ mode, path: target.id, kind: target.kind === "dir" ? "dir" : "file" });
  };

  const paste = async (folder: string) => {
    if (!clipboard) return;
    const { mode, path } = clipboard;
    const dir = clipboard.kind === "dir";
    const name = basename(path);
    if (dir && folder.startsWith(path)) {
      toast.error(`Can't paste ${name} into itself`);
      return;
    }
    try {
      if (mode === "copy") {
        await copyInto(folder, path, dir);
      } else if (parentOf(path) === folder) {
        setClipboard(null);
      } else {
        await runOp({ op: "rename", from: path, to: folder + name });
        setClipboard(null);
      }
    } catch (err) {
      if (isConflict(err)) toast.error(`${name} already exists in ${folderName(folder)}`);
      else toast.error(`Couldn't paste ${name}`, { description: errorMessage(err) });
    }
  };

  const duplicate = (target: Target) => {
    copyInto(parentOf(target.id), target.id, target.kind === "dir").catch((err: unknown) => {
      toast.error(`Couldn't duplicate ${target.name}`, { description: errorMessage(err) });
    });
  };

  const requestDelete = (target: Target) => {
    if (target.kind !== "root") setDoomed({ target, open: true });
  };

  const confirmDelete = () => {
    if (!doomed) return;
    const { target } = doomed;
    setDoomed({ target, open: false });
    runOp({ op: "delete", path: target.id }).catch((err: unknown) => {
      toast.error(`Couldn't delete ${target.name}`, { description: errorMessage(err) });
    });
  };

  const collapseAll = () => setExpanded(new Set());

  const openSheet = (target: Target) => setSheet({ target, open: true });

  const actionsFor = (target: Target): FileActionGroups => {
    const folder = folderOf(target);
    const create: FileAction[] = [
      { id: "new-file", label: "New File…", icon: FilePlus, run: () => startNew(false, folder) },
      { id: "new-folder", label: "New Folder…", icon: FolderPlus, run: () => startNew(true, folder) },
    ];
    const pasteAction: FileAction = {
      id: "paste",
      label: "Paste",
      icon: ClipboardPaste,
      shortcut: `${keys.mod}V`,
      disabled: !clipboard,
      run: () => void paste(folder),
    };
    const copyPath: FileAction = {
      id: "copy-path",
      label: "Copy Path",
      icon: ClipboardCopy,
      run: () => void copyText(trimSlashes(absoluteSourcePath(sourceRef.current, target.id)), "path"),
    };
    if (target.kind === "root") {
      return [
        create,
        [pasteAction],
        [copyPath],
        [
          { id: "refresh", label: "Refresh", icon: RefreshCw, run: refresh },
          { id: "collapse", label: "Collapse All", icon: ChevronsDownUp, run: collapseAll },
        ],
      ];
    }
    const clipboardActions: FileAction[] = [
      { id: "cut", label: "Cut", icon: Scissors, shortcut: `${keys.mod}X`, run: () => clip(target, "cut") },
      { id: "copy", label: "Copy", icon: Copy, shortcut: `${keys.mod}C`, run: () => clip(target, "copy") },
      pasteAction,
    ];
    const paths: FileAction[] = [
      copyPath,
      {
        id: "copy-relative-path",
        label: "Copy Relative Path",
        icon: ClipboardList,
        run: () => void copyText(relativePath(target.id), "relative path"),
      },
    ];
    const manage: FileAction[] = [
      { id: "rename", label: "Rename…", icon: PencilLine, shortcut: "F2", run: () => startRename(target) },
      { id: "duplicate", label: "Duplicate", icon: CopyPlus, run: () => duplicate(target) },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        shortcut: keys.del,
        destructive: true,
        run: () => requestDelete(target),
      },
    ];
    const first: FileAction[] =
      target.kind === "dir"
        ? create
        : [{ id: "open", label: "Open", icon: FileText, shortcut: "↵", run: () => onOpenFile(target.id) }];
    return [first, clipboardActions, paths, manage];
  };

  /** The target under a pointer/touch: its row, or the top level for empty space and status lines. */
  const targetAt = (element: EventTarget): Target => {
    const id = (element as HTMLElement).closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
    const row = rows.find((r) => r.type === "node" && r.id === id);
    return row?.type === "node" ? targetOf(row) : rootTarget;
  };

  const onTreeContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = targetAt(event.target);
    if ((event.target as HTMLElement).closest("[data-node-id]")) setFocusedId(target.id);
    if (isMobile) {
      // Android fires contextmenu on long-press: show the actions sheet instead.
      event.preventDefault();
      suppressClickRef.current = true;
      openSheet(target);
      return;
    }
    setMenuTarget(target);
  };

  const clearLongPress = () => {
    if (!longPressRef.current) return;
    clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  };

  // Phones: touch-and-hold a row (or empty space) for its actions; a moved finger is a scroll.
  const onTreePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClickRef.current = false;
    clearLongPress();
    if (!isMobile || event.pointerType === "mouse") return;
    const element = event.target as HTMLElement;
    if (element.closest("button, input")) return;
    const target = targetAt(element);
    const timer = window.setTimeout(() => {
      longPressRef.current = null;
      suppressClickRef.current = true;
      openSheet(target);
    }, LONG_PRESS_MS);
    longPressRef.current = { timer, x: event.clientX, y: event.clientY };
  };

  const onTreePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = longPressRef.current;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) clearLongPress();
  };

  // ---- Keyboard ----

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
    // Inline name fields handle their own keys.
    if (event.target instanceof HTMLInputElement) return;
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const index = item ? treeItems(treeRef.current).indexOf(item) : -1;
    const row = rows[index];
    if (!row) return;

    const mod = event.metaKey || event.ctrlKey;
    if (!event.altKey && !event.shiftKey) {
      const target = row.type === "node" ? targetOf(row) : null;
      const key = event.key.toLowerCase();
      let command: (() => void) | null = null;
      if (target && !mod && event.key === "F2") command = () => startRename(target);
      else if (target && ((!mod && event.key === "Delete") || (mod && event.key === "Backspace"))) {
        command = () => requestDelete(target);
      } else if (target && mod && key === "c") command = () => clip(target, "copy");
      else if (target && mod && key === "x") command = () => clip(target, "cut");
      else if (mod && key === "v") command = () => void paste(target ? folderOf(target) : currentFolder());
      if (command) {
        event.preventDefault();
        command();
        return;
      }
    }

    if (event.altKey || mod) return;
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

  // ---- Render ----

  const sheetTarget = sheet?.target;
  const sheetDescription = sheetTarget
    ? sheetTarget.kind === "root"
      ? trimSlashes(absoluteSourcePath(source, sheetTarget.id))
      : relativePath(sheetTarget.id)
    : "";

  return (
    <div className={cn("flex min-h-full flex-col", className)}>
      <div className="sticky top-0 z-10 shrink-0 bg-background/95 backdrop-blur-sm">
        <div className="flex h-11 items-center gap-0.5 pr-1 pl-3 md:h-8">
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            Explorer
          </span>
          <HeaderButton label="New File" icon={FilePlus} onClick={() => startNew(false, currentFolder())} />
          <HeaderButton label="New Folder" icon={FolderPlus} onClick={() => startNew(true, currentFolder())} />
          <HeaderButton label="Refresh" icon={RefreshCw} onClick={refresh} />
          <HeaderButton label="Collapse All" icon={ChevronsDownUp} onClick={collapseAll} />
          {isMobile && <HeaderButton label="More actions" icon={MoreHorizontal} onClick={() => openSheet(rootTarget)} />}
        </div>
        {clipboard && (
          <div className="flex items-center gap-1 border-y bg-muted/60 py-1 pr-1 pl-3 text-sm md:text-xs">
            {clipboard.mode === "cut" ? (
              <Scissors className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <Copy className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate" title={clipboard.path}>
              <span className="font-medium">{basename(clipboard.path)}</span>
              <span className="text-muted-foreground"> · {clipboard.mode === "cut" ? "Cut" : "Copied"}</span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              className="h-11 shrink-0 pressable md:h-7"
              title={`Paste into ${folderName(currentFolder())}`}
              onClick={() => void paste(currentFolder())}
            >
              <ClipboardPaste />
              Paste here
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-11 shrink-0 pressable md:h-7"
              onClick={() => setClipboard(null)}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild disabled={isMobile}>
          <div
            ref={treeRef}
            onContextMenu={onTreeContextMenu}
            role="tree"
            aria-label="Project files"
            className="flex-1 py-1"
            onKeyDown={onKeyDown}
            onPointerDown={onTreePointerDown}
            onPointerMove={onTreePointerMove}
            onPointerUp={clearLongPress}
            onPointerCancel={clearLongPress}
          >
            {rows.map((row) => {
              const indent = { paddingLeft: `${8 + row.depth * 12}px` };
              if (row.type === "edit") {
                const NewIcon = row.dir ? Folder : fileIcon("");
                return (
                  <div
                    key={row.id}
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-selected={false}
                    tabIndex={-1}
                    style={indent}
                    className="flex min-h-11 items-center gap-1.5 rounded-md pr-2 text-sm md:min-h-7"
                  >
                    {row.dir ? (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    <NewIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <InlineNameInput
                      label={row.dir ? "New folder name" : "New file name"}
                      isMobile={isMobile}
                      onSubmit={submitNew}
                      onCancel={(fromBlur) => endEdit(row.parentId ?? "", !fromBlur)}
                    />
                  </div>
                );
              }
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
                    {row.status === "truncated" && (
                      <span className="truncate">Showing first {TREE_LIMIT} entries</span>
                    )}
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
              const renaming = editing?.mode === "rename" && editing.id === row.id;
              const cut = clipboard?.mode === "cut" && clipboard.path === row.id;
              const Icon = row.dir ? (open ? FolderOpen : Folder) : fileIcon(row.label);
              const dot = row.dir ? -1 : row.label.lastIndexOf(".");
              return (
                <div
                  key={row.id}
                  data-node-id={row.id}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={row.dir ? open : undefined}
                  aria-selected={selected}
                  tabIndex={row.id === tabStop ? 0 : -1}
                  title={row.title}
                  style={indent}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-md pr-2 text-sm outline-none select-none [-webkit-touch-callout:none] hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
                    renaming ? "min-h-11 md:min-h-7" : "h-11 md:h-7",
                    isMobile && !renaming && "pr-0",
                    row.id === focusedId && !selected && "bg-accent/40",
                    selected && "bg-accent text-accent-foreground hover:bg-accent",
                    cut && "opacity-50",
                  )}
                  onFocus={(event) => {
                    if (event.target === event.currentTarget) setFocusedId(row.id);
                  }}
                  onClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    if (!renaming) activate(row);
                  }}
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
                  {renaming ? (
                    <InlineNameInput
                      initial={row.label}
                      selectEnd={dot > 0 ? dot : undefined}
                      label={`Rename ${row.label}`}
                      isMobile={isMobile}
                      onSubmit={(name, fromBlur) => submitRename(row, name, fromBlur)}
                      onCancel={(fromBlur) => endEdit(row.id, !fromBlur)}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  )}
                  {isMobile && !renaming && (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Actions for ${row.label}`}
                      className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent active:bg-accent"
                      onClick={(event) => {
                        event.stopPropagation();
                        setFocusedId(row.id);
                        openSheet(targetOf(row));
                      }}
                    >
                      <MoreHorizontal className="size-5" aria-hidden />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          data-vaul-no-drag
          className={MENU_CONTENT}
          // An action that opened an inline name field keeps the focus there.
          onCloseAutoFocus={(event) => {
            if (editingRef.current) event.preventDefault();
          }}
        >
          {menuTarget && <FileMenuItems groups={actionsFor(menuTarget)} />}
        </ContextMenuContent>
      </ContextMenu>

      {sheet && sheetTarget && (
        <FileActionsDrawer
          open={sheet.open}
          onOpenChange={(next) => setSheet((current) => current && { ...current, open: next })}
          title={sheetTarget.name}
          description={sheetDescription}
          groups={actionsFor(sheetTarget)}
        />
      )}
      {doomed && (
        <DeleteFileDialog
          open={doomed.open}
          onOpenChange={(next) => setDoomed((current) => current && { ...current, open: next })}
          name={doomed.target.name}
          dir={doomed.target.kind === "dir"}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
