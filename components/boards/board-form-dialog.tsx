"use client";

import { useEffect, useId, useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  Loader2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { CloneRepoForm } from "@/components/boards/clone-repo-form";
import { FolderPicker } from "@/components/folder-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useIsMobile } from "@/hooks/use-mobile";
import { api } from "@/lib/api-client";
import type { Board } from "@/lib/types";
import { cn } from "@/lib/utils";

/** "source": pick folder vs clone (new projects only); "clone": clone form; "details": the project form. */
type View = "source" | "clone" | "details";
/** Which slot a picked or cloned folder fills. */
type Target = "primary" | "extra";

function basename(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
}

function parentDir(path: string): string | undefined {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return undefined;
  return cut === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, cut);
}

/**
 * Create / edit a project (board). Centered dialog on desktop, bottom sheet on mobile.
 * New projects start by choosing where the code is (server folder or Git clone).
 * Pass `board` to edit; omit it to create.
 */
export function BoardFormDialog({
  open,
  onOpenChange,
  board,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board?: Board | null;
  onSaved?: (board: Board, created: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const formId = useId();
  const editing = Boolean(board);

  const [view, setView] = useState<View>("source");
  const [cloneTarget, setCloneTarget] = useState<Target>("primary");
  const [picker, setPicker] = useState<{ open: boolean; target: Target }>({ open: false, target: "primary" });
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [workdir, setWorkdir] = useState("");
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [autoRun, setAutoRun] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setView(board ? "details" : "source");
    setPicker({ open: false, target: "primary" });
    setName(board?.name ?? "");
    setNameTouched(Boolean(board));
    setWorkdir(board?.workdir ?? "");
    setExtraFolders(board?.extraFolders ?? []);
    setModel(board?.model ?? "");
    setAutoRun(board?.autoRun ?? true);
    setShowMore(Boolean(board?.model) || board?.autoRun === false);
    setBusy(false);
    setSaving(false);
    setError(null);
  }, [open, board]);

  function applyFolder(path: string, target: Target) {
    setError(null);
    if (target === "primary") {
      setWorkdir(path);
      setExtraFolders((list) => list.filter((f) => f !== path));
      if (!nameTouched || !name.trim()) {
        setName(basename(path));
        setNameTouched(false);
      }
    } else if (path !== workdir) {
      setExtraFolders((list) => (list.includes(path) ? list : [...list, path]));
    }
    setView("details");
  }

  function startClone(target: Target) {
    setCloneTarget(target);
    setView("clone");
  }

  const close = (next: boolean) => {
    if (!saving && !busy) onOpenChange(next);
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    const input = {
      name: name.trim(),
      workdir: workdir.trim(),
      extraFolders,
      model: model.trim() || null,
      autoRun,
    };
    if (!input.workdir) {
      setError("Choose the project folder first.");
      return;
    }
    if (!input.name) {
      setError("Give the project a name.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const saved = board ? await api.boards.update(board.id, input) : await api.boards.create(input);
      toast.success(board ? "Project saved" : "Project created");
      onOpenChange(false);
      onSaved?.(saved, !board);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't save the project.");
      setSaving(false);
    }
  }

  const header =
    view === "source"
      ? { title: "New project", description: "Where is the code? Pick a folder on this server or clone a Git repository." }
      : view === "clone"
        ? {
            title: "Clone a Git repository",
            description:
              cloneTarget === "primary"
                ? "It's downloaded into the workspace folder on the server."
                : "It's downloaded next to your other projects and added to this one.",
          }
        : editing
          ? { title: "Edit project", description: "Change the name, folders, or how the agent runs." }
          : { title: "New project", description: "Check the details, then create the project." };

  const folderMenu = (target: Target, trigger: React.ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      {/* Don't pull focus back to the trigger: the picked action opens another dialog or view. */}
      <DropdownMenuContent align="end" className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem
          onSelect={() => setPicker({ open: true, target })}
          className="min-h-11 gap-2.5 px-2.5 md:min-h-9"
        >
          <FolderOpenIcon />
          Pick a folder on the server
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => startClone(target)} className="min-h-11 gap-2.5 px-2.5 md:min-h-9">
          <GitBranchIcon />
          Clone a Git repository
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const sourceView = (
    <div className="grid grid-cols-1 gap-3">
      {[
        {
          icon: <FolderOpenIcon />,
          title: "Use a folder on the server",
          body: "Pick a project that's already on this machine.",
          onClick: () => setPicker({ open: true, target: "primary" }),
        },
        {
          icon: <GitBranchIcon />,
          title: "Clone a Git repository",
          body: "Download a repo from GitHub, GitLab or any Git URL.",
          onClick: () => startClone("primary"),
        },
      ].map((option) => (
        <button
          key={option.title}
          type="button"
          onClick={option.onClick}
          className="flex min-h-20 w-full items-center gap-4 rounded-xl border bg-card p-4 text-left outline-none transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-accent/60"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary [&_svg]:size-5">
            {option.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[0.95rem] font-medium">{option.title}</span>
            <span className="block text-sm text-muted-foreground">{option.body}</span>
          </span>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );

  const cloneView = (
    <div className="space-y-4">
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => setView(workdir ? "details" : "source")}
        className="-ml-2 h-11 px-2 text-muted-foreground md:h-8"
      >
        <ChevronLeftIcon />
        Back
      </Button>
      <CloneRepoForm onCloned={(path) => applyFolder(path, cloneTarget)} onBusyChange={setBusy} />
    </div>
  );

  const detailsView = (
    <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor={`${formId}-name`}>Project name</Label>
        <Input
          id={`${formId}-name`}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
          placeholder="My app"
          autoComplete="off"
          maxLength={120}
          disabled={saving}
          className="h-11 md:h-9"
        />
      </div>

      <div className="space-y-2">
        <span id={`${formId}-folder-label`} className="text-sm font-medium">
          Project folder
        </span>
        <div
          aria-labelledby={`${formId}-folder-label`}
          className="flex min-h-12 items-center gap-2.5 rounded-lg border bg-muted/40 py-1 pr-1 pl-3"
        >
          <FolderIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm" title={workdir}>
            {workdir || <span className="font-sans text-muted-foreground">No folder chosen</span>}
          </span>
          {folderMenu(
            "primary",
            <Button type="button" variant="ghost" disabled={saving} className="h-10 shrink-0 px-3 md:h-8">
              Change
            </Button>,
          )}
        </div>
        <p className="text-xs text-muted-foreground">The agent works in this folder.</p>
      </div>

      <div className="space-y-2">
        {extraFolders.length > 0 && (
          <>
            <span className="text-sm font-medium">Other folders</span>
            <ul className="space-y-1.5">
              {extraFolders.map((folder) => (
                <li
                  key={folder}
                  className="flex min-h-11 items-center gap-2.5 rounded-lg border py-0.5 pr-0.5 pl-3"
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm" title={folder}>
                    {folder}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={saving}
                    onClick={() => setExtraFolders((list) => list.filter((f) => f !== folder))}
                    className="size-10 shrink-0 text-muted-foreground md:size-8"
                    aria-label={`Remove ${basename(folder)}`}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        {folderMenu(
          "extra",
          <Button
            type="button"
            variant="outline"
            disabled={saving || !workdir}
            className="h-11 w-full border-dashed text-muted-foreground md:h-9"
          >
            <PlusIcon />
            Add another folder
          </Button>,
        )}
        {extraFolders.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Optional. For projects split across folders, like a frontend and a backend.
          </p>
        )}
      </div>

      <div className="rounded-xl border">
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          aria-controls={`${formId}-more`}
          className="flex h-12 w-full items-center justify-between rounded-xl px-3.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          More options
          <ChevronDownIcon
            className={cn("size-4 text-muted-foreground transition-transform", showMore && "rotate-180")}
          />
        </button>
        {showMore && (
          <div id={`${formId}-more`} className="space-y-4 border-t p-3.5">
            <div className="space-y-2">
              <Label htmlFor={`${formId}-model`}>Model</Label>
              <Input
                id={`${formId}-model`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="omp default"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={saving}
                className="h-11 md:h-9"
              />
              <p className="text-xs text-muted-foreground">Leave empty to use the default from Settings.</p>
            </div>
            <label
              htmlFor={`${formId}-autorun`}
              className="flex min-h-12 cursor-pointer items-center gap-4"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Auto-run</span>
                <span className="block text-xs text-muted-foreground">
                  Start the agent when a card is added or moves to In progress
                </span>
              </span>
              <Switch
                id={`${formId}-autorun`}
                checked={autoRun}
                onCheckedChange={setAutoRun}
                disabled={saving}
              />
            </label>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm [overflow-wrap:anywhere] text-destructive">
          {error}
        </p>
      )}
    </form>
  );

  const content = view === "source" ? sourceView : view === "clone" ? cloneView : detailsView;

  const submitButton = (
    <Button
      type="submit"
      form={formId}
      disabled={saving || !workdir}
      className="h-11 text-base md:h-9 md:text-sm"
    >
      {saving && <Loader2Icon className="animate-spin" />}
      {editing ? "Save changes" : "Create project"}
    </Button>
  );

  const pickerDialog = (
    <FolderPicker
      open={picker.open}
      onOpenChange={(next) => setPicker((p) => ({ ...p, open: next }))}
      title={picker.target === "primary" ? "Choose the project folder" : "Add a folder"}
      initialPath={picker.target === "primary" ? workdir || undefined : parentDir(workdir)}
      onSelect={(path) => applyFolder(path, picker.target)}
    />
  );

  if (isMobile) {
    return (
      <>
        <Drawer open={open} onOpenChange={close}>
          <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[92dvh]">
            <DrawerHeader className="text-left">
              <DrawerTitle className="text-lg">{header.title}</DrawerTitle>
              <DrawerDescription>{header.description}</DrawerDescription>
            </DrawerHeader>
            <div
              className={cn(
                "overflow-y-auto overscroll-contain px-4",
                view === "details" ? "pb-2" : "pb-[calc(1rem+env(safe-area-inset-bottom))]",
              )}
            >
              {content}
            </div>
            {view === "details" && (
              <DrawerFooter className="pb-[calc(1rem+env(safe-area-inset-bottom))]">
                {submitButton}
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => close(false)}
                  className="h-11 text-base"
                >
                  Cancel
                </Button>
              </DrawerFooter>
            )}
          </DrawerContent>
        </Drawer>
        {pickerDialog}
      </>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-h-[90dvh] grid-cols-1 overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{header.title}</DialogTitle>
            <DialogDescription>{header.description}</DialogDescription>
          </DialogHeader>
          <div className="pt-1 pb-2">{content}</div>
          {view === "details" && (
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => close(false)}
                className="md:h-9"
              >
                Cancel
              </Button>
              {submitButton}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
      {pickerDialog}
    </>
  );
}
