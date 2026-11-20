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
import { DEFAULT_BRANCH } from "@/lib/default-branch";
import { DEFAULT_PUSH_BRANCH, isValidBranchName, PUSH_BRANCH_MAX } from "@/lib/push-branch";
import type { Board } from "@/lib/types";
import { cn } from "@/lib/utils";

/** "source": pick folder vs clone (new projects only); "clone": clone form; "details": the project form. */
type View = "source" | "clone" | "details";
/** Which slot a picked or cloned folder fills. */
type Target = "primary" | "extra";
/** A form error; `field` places it under that input instead of above the actions. */
type FormError = { message: string; field?: "name" | "workdir" | "pushBranch" };

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
  const [pushBranch, setPushBranch] = useState(DEFAULT_PUSH_BRANCH);
  // Per-repo default branch: folder → branch ("" or an absent folder = the repo's own default).
  const [defaultBranches, setDefaultBranches] = useState<Record<string, string>>({});
  // Branch names of a saved project's folders, for the branch suggestions; filled on first expand.
  const [repoBranches, setRepoBranches] = useState<Record<string, string[]>>({});
  const [worktrees, setWorktrees] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  // Git state of folders picked in this session ("checking" while the lookup runs); edit-mode
  // folders that came from the board are never checked.
  const [repoState, setRepoState] = useState<Record<string, boolean | "checking" | "error">>({});
  // Folders the user ticked to `git init` after saving.
  const [initGit, setInitGit] = useState<string[]>([]);

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
    setWorktrees(board?.worktrees ?? false);
    setPushBranch(board?.pushBranch ?? DEFAULT_PUSH_BRANCH);
    setShowMore(
      Boolean(board?.model) ||
        board?.autoRun === false ||
        Boolean(board?.worktrees) ||
        (board != null && board.pushBranch !== DEFAULT_PUSH_BRANCH) ||
        Object.keys(board?.defaultBranches ?? {}).length > 0,
    );
    setBusy(false);
    setSaving(false);
    setError(null);
    setRepoState({});
    setInitGit([]);
    setDefaultBranches(board?.defaultBranches ?? {});
    setRepoBranches({});
  }, [open, board]);

  // Branch suggestions for a saved project's folders, once the section holding them is open.
  useEffect(() => {
    if (!open || !showMore || !board) return;
    for (const folder of [board.workdir, ...board.extraFolders]) {
      if (repoBranches[folder]) continue;
      setRepoBranches((map) => ({ ...map, [folder]: [] }));
      api.git.branches(board.id, folder).then(
        (res) => setRepoBranches((map) => ({ ...map, [folder]: res.branches.map((b) => b.name) })),
        () => {},
      );
    }
  }, [open, showMore, board, repoBranches]);

  /** Drop a folder's git state, init choice and default branch (removed or replaced). */
  function forgetFolder(path: string) {
    setRepoState((s) => Object.fromEntries(Object.entries(s).filter(([f]) => f !== path)));
    setInitGit((list) => list.filter((f) => f !== path));
    setDefaultBranches((map) => Object.fromEntries(Object.entries(map).filter(([f]) => f !== path)));
  }

  /** Look up whether a freshly picked folder is a git repo; `known` skips the request (e.g. clones). */
  function checkRepo(path: string, known?: boolean) {
    if (known !== undefined) {
      setRepoState((s) => ({ ...s, [path]: known }));
      return;
    }
    setRepoState((s) => ({ ...s, [path]: "checking" }));
    // Only apply the answer while the folder is still waiting on it (not removed or reset meanwhile).
    const settle = (value: boolean | "error") =>
      setRepoState((s) => (s[path] === "checking" ? { ...s, [path]: value } : s));
    api.git.isRepo(path).then(
      (res) => settle(res.isGitRepo),
      () => settle("error"),
    );
  }

  function applyFolder(path: string, target: Target, isRepo?: boolean) {
    setError(null);
    if (target === "primary") {
      if (workdir && workdir !== path) forgetFolder(workdir);
      setWorkdir(path);
      setExtraFolders((list) => list.filter((f) => f !== path));
      checkRepo(path, isRepo);
      if (!nameTouched || !name.trim()) {
        setName(basename(path));
        setNameTouched(false);
      }
    } else if (path !== workdir) {
      setExtraFolders((list) => (list.includes(path) ? list : [...list, path]));
      checkRepo(path, isRepo);
    }
    setView("details");
  }

  /** Run `git init` in each ticked folder; failures only toast (the project is already saved). */
  async function initFolders(folders: string[]) {
    const results = await Promise.allSettled(folders.map((folder) => api.git.init(folder)));
    results.forEach((result, i) => {
      const label = basename(folders[i]);
      if (result.status === "fulfilled") {
        toast.success(`Initialized git in ${label}/`);
      } else {
        const reason = result.reason;
        toast.error(`Couldn't initialize git in ${label}/`, {
          description: reason instanceof Error && reason.message ? reason.message : undefined,
        });
      }
    });
  }

  function startClone(target: Target) {
    setCloneTarget(target);
    setView("clone");
  }

  /** Leave the clone form: back to the project form once a folder is set, else to the source choice. */
  function leaveClone() {
    setView(workdir ? "details" : "source");
  }

  const close = (next: boolean) => {
    if (!saving && !busy) onOpenChange(next);
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    const branch = pushBranch.trim();
    const projectFolders = [workdir.trim(), ...extraFolders].filter(Boolean);
    const branches: Record<string, string> = {};
    for (const folder of projectFolders) {
      const name = (defaultBranches[folder] ?? "").trim();
      if (name) branches[folder] = name;
    }
    const input = {
      name: name.trim(),
      workdir: workdir.trim(),
      extraFolders,
      model: model.trim() || null,
      worktrees,
      autoRun,
      pushBranch: branch,
      defaultBranches: branches,
    };
    if (!input.workdir) {
      setError({ message: "Choose the project folder first.", field: "workdir" });
      return;
    }
    if (!input.name) {
      setError({ message: "Give the project a name.", field: "name" });
      return;
    }
    if (!isValidBranchName(branch)) {
      setShowMore(true);
      setError({
        message: branch
          ? `“${branch}” isn't a valid git branch name. Try something like main or release/1.x.`
          : "Enter the branch Push to main should land on, e.g. main.",
        field: "pushBranch",
      });
      return;
    }
    const badBranch = Object.entries(branches).find(([, name]) => !isValidBranchName(name));
    if (badBranch) {
      setShowMore(true);
      setError({
        message: `“${badBranch[1]}” isn't a valid git branch name (default branch of ${basename(badBranch[0])}/).`,
      });
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const saved = board ? await api.boards.update(board.id, input) : await api.boards.create(input);
      toast.success(board ? "Project saved" : "Project created");
      const toInit = initGit.filter((f) => f === saved.workdir || saved.extraFolders.includes(f));
      if (toInit.length > 0) await initFolders(toInit);
      onOpenChange(false);
      onSaved?.(saved, !board);
    } catch (err) {
      setError({ message: err instanceof Error && err.message ? err.message : "Couldn't save the project." });
      setSaving(false);
    }
  }

  const header =
    view === "source"
      ? { title: "New project", description: "Pick a folder on this server or clone a Git repository." }
      : view === "clone"
        ? {
            title: "Clone a Git repository",
            description:
              cloneTarget === "primary"
                ? "Clones into the workspace folder on the server."
                : "Clones next to your other projects and adds it to this one.",
          }
        : editing
          ? { title: "Edit project", description: "Change the name, folders, or how the agent runs." }
          : { title: "New project", description: "Check the details, then create the project." };

  const folderMenu = (target: Target, trigger: React.ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      {/* Don't pull focus back to the trigger: the picked action opens another dialog or view. */}
      <DropdownMenuContent align="end" className="w-60 max-md:w-72" onCloseAutoFocus={(e) => e.preventDefault()}>
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
          body: "A project already on this machine.",
          onClick: () => setPicker({ open: true, target: "primary" }),
        },
        {
          icon: <GitBranchIcon />,
          title: "Clone a Git repository",
          body: "From GitHub, GitLab or any Git URL.",
          onClick: () => startClone("primary"),
        },
      ].map((option) => (
        <button
          key={option.title}
          type="button"
          onClick={option.onClick}
          className="pressable flex min-h-20 w-full items-center gap-4 rounded-xl border bg-card p-4 text-left outline-none hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-accent/60"
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

  const cloneForm = (
    <CloneRepoForm onCloned={(path) => applyFolder(path, cloneTarget, true)} onBusyChange={setBusy} />
  );

  // Phones get Back in the sheet header (see below); the dialog keeps it above the form.
  const cloneView = isMobile ? (
    cloneForm
  ) : (
    <div className="space-y-4">
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={leaveClone}
        className="-ml-2 h-8 px-2 text-muted-foreground"
      >
        <ChevronLeftIcon />
        Back
      </Button>
      {cloneForm}
    </div>
  );

  /** Opt-in "git init" toggle shown under a picked folder that isn't a git repository. */
  const initGitToggle = (folder: string, id: string) =>
    repoState[folder] === false && (
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-2.5 py-1.5 pl-3 md:min-h-9">
        <input
          id={id}
          type="checkbox"
          checked={initGit.includes(folder)}
          onChange={(e) => {
            const rest = initGit.filter((f) => f !== folder);
            setInitGit(e.target.checked ? [...rest, folder] : rest);
          }}
          disabled={saving}
          className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Initialize as git repository</span>
          <span className="block text-xs text-muted-foreground">
            This folder isn&apos;t a git repository yet. Runs <code className="font-mono">git init</code> after
            saving.
          </span>
        </span>
      </label>
    );

  const nameError = error?.field === "name" ? error.message : null;
  const folderError = error?.field === "workdir" ? error.message : null;
  const pushBranchError = error?.field === "pushBranch" ? error.message : null;
  const formError = error && !error.field ? error.message : null;
  // The project's repos in display order; a brand-new dialog may not have picked its first one yet.
  const folderList = [workdir.trim(), ...extraFolders].filter(Boolean);

  const detailsView = (
    <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${formId}-name`}>Project name</Label>
        <Input
          id={`${formId}-name`}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
            if (nameError) setError(null);
          }}
          placeholder="My app"
          autoComplete="off"
          maxLength={120}
          disabled={saving}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${formId}-name-error` : undefined}
          className="h-11 md:h-9"
        />
        {nameError && (
          <p id={`${formId}-name-error`} role="alert" className="text-xs font-medium text-destructive">
            {nameError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span id={`${formId}-folder-label`} className="text-sm font-medium">
          Project folder
        </span>
        <div
          aria-labelledby={`${formId}-folder-label`}
          aria-describedby={folderError ? `${formId}-folder-error` : undefined}
          className={cn(
            "flex min-h-12 items-center gap-2.5 rounded-lg border bg-muted/40 py-1 pr-1 pl-3",
            folderError && "border-destructive",
          )}
        >
          <FolderIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm" title={workdir}>
            {workdir || <span className="font-sans text-muted-foreground">No folder chosen</span>}
          </span>
          {folderMenu(
            "primary",
            <Button type="button" variant="ghost" disabled={saving} className="h-11 shrink-0 px-3 md:h-8">
              Change
            </Button>,
          )}
        </div>
        {folderError && (
          <p id={`${formId}-folder-error`} role="alert" className="text-xs font-medium text-destructive">
            {folderError}
          </p>
        )}
        {initGitToggle(workdir, `${formId}-init-primary`)}
        <p className="text-xs text-muted-foreground">The agent works in this folder.</p>
      </div>

      <div className="space-y-2">
        {extraFolders.length > 0 && (
          <>
            <span className="text-sm font-medium">Other folders</span>
            <ul className="space-y-1.5">
              {extraFolders.map((folder, i) => (
                <li key={folder}>
                  <div className="flex min-h-11 items-center gap-2.5 rounded-lg border py-0.5 pr-0.5 pl-3">
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-mono text-sm" title={folder}>
                      {folder}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={saving}
                      onClick={() => {
                        setExtraFolders((list) => list.filter((f) => f !== folder));
                        forgetFolder(folder);
                      }}
                      className="size-11 shrink-0 text-muted-foreground md:size-8"
                      aria-label={`Remove ${basename(folder)}`}
                    >
                      <XIcon />
                    </Button>
                  </div>
                  {initGitToggle(folder, `${formId}-init-extra-${i}`)}
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
            Optional. For projects split across folders, e.g. frontend and backend.
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
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${formId}-model`}>Model</Label>
              <Input
                id={`${formId}-model`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Auto"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={saving}
                className="h-11 md:h-9"
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to auto-select per card (Settings → Auto-select model) or use the Settings
                default.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${formId}-push-branch`}>Push branch</Label>
              <Input
                id={`${formId}-push-branch`}
                value={pushBranch}
                onChange={(e) => {
                  setPushBranch(e.target.value);
                  if (pushBranchError) setError(null);
                }}
                placeholder={DEFAULT_PUSH_BRANCH}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={PUSH_BRANCH_MAX}
                disabled={saving}
                aria-invalid={pushBranchError ? true : undefined}
                aria-describedby={pushBranchError ? `${formId}-push-branch-error` : undefined}
                className="h-11 md:h-9"
              />
              {pushBranchError && (
                <p id={`${formId}-push-branch-error`} role="alert" className="text-xs font-medium text-destructive">
                  {pushBranchError}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Push to main lands on this branch in every repo of the project (created on the remote if
                missing). Create PR still targets each repo&apos;s default branch.
              </p>
            </div>
            {folderList.length > 0 && (
              <div className="space-y-2">
                <span className="text-sm font-medium">Default branches</span>
                <ul className="space-y-2.5">
                  {folderList.map((folder, i) => (
                    <li key={folder} className="space-y-1.5">
                      <label
                        htmlFor={`${formId}-default-branch-${i}`}
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                      >
                        <GitBranchIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 truncate font-mono" title={folder}>
                          {basename(folder) || folder}
                        </span>
                      </label>
                      <Input
                        id={`${formId}-default-branch-${i}`}
                        value={defaultBranches[folder] ?? ""}
                        onChange={(e) => setDefaultBranches((map) => ({ ...map, [folder]: e.target.value }))}
                        placeholder={DEFAULT_BRANCH}
                        list={repoBranches[folder]?.length ? `${formId}-branch-list-${i}` : undefined}
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        maxLength={PUSH_BRANCH_MAX}
                        disabled={saving}
                        className="h-11 md:h-9"
                      />
                      {repoBranches[folder]?.length ? (
                        <datalist id={`${formId}-branch-list-${i}`}>
                          {repoBranches[folder].map((name) => (
                            <option key={name} value={name} />
                          ))}
                        </datalist>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  The branch each repo starts a card&apos;s dedicated workspace from, and the base Create PR
                  targets. Empty uses the repo&apos;s own default branch (origin/HEAD), else{" "}
                  <code className="font-mono">{DEFAULT_BRANCH}</code>.
                </p>
              </div>
            )}
            <label
              htmlFor={`${formId}-autorun`}
              className="flex min-h-12 cursor-pointer items-center gap-4"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Auto-run</span>
                <span className="block text-xs text-muted-foreground">
                  Start the agent when a card is added
                </span>
              </span>
              <Switch
                id={`${formId}-autorun`}
                checked={autoRun}
                onCheckedChange={setAutoRun}
                disabled={saving}
              />
            </label>
            <label
              htmlFor={`${formId}-worktrees`}
              className="flex min-h-12 cursor-pointer items-center gap-4"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Dedicated workspace per card</span>
                <span className="block text-xs text-muted-foreground">
                  Each card gets its own git worktree on branch omp/&lt;card&gt;, so agents can work
                  on one repo in parallel. Ship from the card.
                </span>
              </span>
              <Switch
                id={`${formId}-worktrees`}
                checked={worktrees}
                onCheckedChange={setWorktrees}
                disabled={saving}
              />
            </label>
          </div>
        )}
      </div>

      {formError && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm [overflow-wrap:anywhere] text-destructive">
          {formError}
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
            <DrawerHeader className={cn(view === "clone" && "flex-row items-start gap-1 pl-2")}>
              {view === "clone" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  onClick={leaveClone}
                  aria-label="Back"
                  className="-mt-2 size-11 shrink-0 text-muted-foreground"
                >
                  <ChevronLeftIcon className="size-5" />
                </Button>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <DrawerTitle className="text-lg">{header.title}</DrawerTitle>
                <DrawerDescription>{header.description}</DrawerDescription>
              </div>
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
