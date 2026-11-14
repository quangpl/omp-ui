"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  EllipsisIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  ShieldIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserCheckIcon,
  UserPlusIcon,
  UsersIcon,
  UserXIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PasswordInput } from "@/components/password-input";
import { SettingsField, SettingsPanel, SettingsSection } from "@/components/settings/settings-section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/hooks/use-current-user";
import { ApiRequestError, api } from "@/lib/api-client";
import { USER_ROLES, type User, type UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

// Mirrors the server's rules (lib/server/validate.ts) so most mistakes show before a round trip.
const MIN_PASSWORD = 8;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;

const FIELD = "h-11 md:h-9";
const SELECT_TRIGGER = "w-full data-[size=default]:h-11 md:data-[size=default]:h-9";

const ROLES: Record<UserRole, { label: string; hint: string }> = {
  admin: { label: "Admin", hint: "Manages users and the shared settings; sees every user's projects." },
  user: { label: "User", hint: "Sees only their own projects, cards and credentials." },
};

type FormField = "username" | "email" | "password" | "confirm";
/** A validation or server error; `field` places it under that input. */
type FormError = { field: FormField; message: string };

/** Which dialog is open, and for whom. */
type DialogTarget =
  | { kind: "form"; user: User | null }
  | { kind: "password"; user: User }
  | { kind: "delete"; user: User };
/** `seq` changes on every open so each dialog starts from fresh state. */
type DialogState = DialogTarget & { seq: number };

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Usernames and emails are stored trimmed and lowercase. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The field a failed request is about: the one the server names in `fields`, else the field its
 * message starts with or mentions (validation errors name the field; a 409 names the taken username
 * or email). Null when the error belongs to the whole form.
 */
function fieldError(err: unknown, fields: readonly FormField[]): FormError | null {
  if (!(err instanceof ApiRequestError)) return null;
  for (const field of fields) {
    const message = err.fields[field];
    if (message) return { field, message };
  }
  if (err.status !== 400 && err.status !== 409) return null;
  const lower = err.message.toLowerCase();
  const field = fields.find((name) => name !== "confirm" && lower.includes(name));
  return field ? { field, message: err.message } : null;
}

function validateIdentity(username: string, email: string): FormError | null {
  const name = normalize(username);
  if (!name) return { field: "username", message: "Enter a username." };
  if (!USERNAME_RE.test(name)) {
    return {
      field: "username",
      message: "Use 2–32 characters: a-z, 0-9, “.”, “_” or “-”, starting with a letter or digit.",
    };
  }
  const mail = normalize(email);
  if (mail && (mail.length > EMAIL_MAX || !EMAIL_RE.test(mail))) {
    return { field: "email", message: "Enter a valid email address, or leave it empty." };
  }
  return null;
}

function validatePasswords(password: string, confirm: string): FormError | null {
  if (password.length < MIN_PASSWORD) return { field: "password", message: `Use at least ${MIN_PASSWORD} characters.` };
  if (password !== confirm) return { field: "confirm", message: "Passwords don't match." };
  return null;
}

/** `aria-*` wiring for a control whose error `SettingsField` renders as `<id>-error`. */
function invalidProps(error: FormError | null, field: FormField, id: string) {
  return error?.field === field ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};
}

function RoleBadge({ role }: { role: UserRole }) {
  return role === "admin" ? (
    <Badge className="bg-primary/10 text-primary">
      <ShieldIcon />
      Admin
    </Badge>
  ) : (
    <Badge variant="secondary">User</Badge>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge className="bg-success/15 text-success">Active</Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      Inactive
    </Badge>
  );
}

function UserRow({
  user,
  self,
  toggling,
  onEdit,
  onSetPassword,
  onToggleActive,
  onDelete,
}: {
  user: User;
  /** The signed-in account: it can't be deactivated or deleted from here. */
  self: boolean;
  toggling: boolean;
  onEdit: () => void;
  onSetPassword: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted font-semibold text-muted-foreground uppercase",
            !user.isActive && "opacity-60",
          )}
        >
          {user.username.charAt(0)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate font-medium", !user.isActive && "text-muted-foreground")}>
              {user.username}
            </span>
            {self && <Badge variant="outline">You</Badge>}
          </p>
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {user.email ? (
              <span className="min-w-0 truncate">{user.email}</span>
            ) : (
              <span>
                <span aria-hidden="true">—</span>
                <span className="sr-only">No email</span>
              </span>
            )}
            <span aria-hidden="true">·</span>
            <span className="whitespace-nowrap">
              Created{" "}
              <time dateTime={user.createdAt}>
                {new Date(user.createdAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </time>
            </span>
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 max-sm:justify-between max-sm:pl-13">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <RoleBadge role={user.role} />
          <StatusBadge active={user.isActive} />
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="pressable-icon size-11 md:size-8"
                aria-label={`Edit ${user.username}`}
                onClick={onEdit}
              >
                <PencilIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="pressable-icon size-11 md:size-8"
                aria-label={`More actions for ${user.username}`}
                disabled={toggling}
              >
                {toggling ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <EllipsisIcon />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem className="max-md:min-h-11" onSelect={onSetPassword}>
                <KeyRoundIcon />
                {self ? "Change password" : "Set password"}
              </DropdownMenuItem>
              <DropdownMenuItem className="max-md:min-h-11" disabled={self} onSelect={onToggleActive}>
                {user.isActive ? <UserXIcon /> : <UserCheckIcon />}
                {user.isActive ? "Deactivate" : "Activate"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="max-md:min-h-11" variant="destructive" disabled={self} onSelect={onDelete}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
              {self && (
                <DropdownMenuLabel className="max-w-56 text-xs font-normal text-pretty text-muted-foreground">
                  You can't deactivate or delete your own account.
                </DropdownMenuLabel>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  );
}

/** Mirrors `UserRow`: stacked on phones (identity, then badges + actions), one line from `sm`. */
function ListSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading users" className="divide-y">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Skeleton className="size-10 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-32 max-w-full" />
              <Skeleton className="h-3 w-52 max-w-full" />
            </div>
          </div>
          <div className="flex items-center gap-2 max-sm:justify-between max-sm:pl-13">
            <div className="flex gap-1.5">
              <Skeleton className="h-5 w-14 rounded-full" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
            <div className="flex gap-0.5">
              <Skeleton className="size-11 rounded-lg md:size-8" />
              <Skeleton className="size-11 rounded-lg md:size-8" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Add a user (`user` null) or edit one. Your own role and active state are locked. */
function UserFormDialog({
  user,
  self,
  open,
  onOpenChange,
  onSaved,
}: {
  user: User | null;
  self: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (user: User) => void;
}) {
  const id = useId();
  const [username, setUsername] = useState(user?.username ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<UserRole>(user?.role ?? "user");
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<FormError | null>(null);
  const [saving, setSaving] = useState(false);

  const ids = {
    username: `${id}-username`,
    email: `${id}-email`,
    role: `${id}-role`,
    active: `${id}-active`,
    password: `${id}-password`,
    confirm: `${id}-confirm`,
  };
  const errorFor = (field: FormField) => (error?.field === field ? error.message : null);

  /** Only the fields that differ from the saved account. */
  function changes(target: User) {
    const patch: { username?: string; email?: string | null; role?: UserRole; isActive?: boolean } = {};
    const nextEmail = normalize(email) || null;
    if (normalize(username) !== target.username) patch.username = normalize(username);
    if (nextEmail !== target.email) patch.email = nextEmail;
    if (!self && role !== target.role) patch.role = role;
    if (!self && isActive !== target.isActive) patch.isActive = isActive;
    return patch;
  }

  const dirty = user ? Object.keys(changes(user)).length > 0 : true;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    const invalid = validateIdentity(username, email) ?? (user ? null : validatePasswords(password, confirm));
    if (invalid) return setError(invalid);

    setError(null);
    setSaving(true);
    try {
      const saved = user
        ? await api.users.update(user.id, changes(user))
        : await api.users.create({ username: normalize(username), email: normalize(email) || null, password, role });
      toast.success(user ? `Saved ${saved.username}` : `Added ${saved.username}`, {
        description:
          user && user.isActive && !saved.isActive
            ? "They were signed out and can't sign in until you activate them again."
            : undefined,
      });
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      const message = errorText(err, user ? "Could not save the user." : "Could not add the user.");
      setError(fieldError(err, user ? ["username", "email"] : ["username", "email", "password"]));
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <DialogHeader className="pr-8">
            <DialogTitle className="[overflow-wrap:anywhere]">
              {user ? `Edit ${user.username}` : "Add user"}
            </DialogTitle>
            <DialogDescription>
              {user
                ? "Role or status changes sign them out on every device."
                : "They sign in with their username (or email) and this password."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <SettingsField label="Username" htmlFor={ids.username} error={errorFor("username")}>
                <Input
                  id={ids.username}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={saving}
                  className={FIELD}
                  {...invalidProps(error, "username", ids.username)}
                />
              </SettingsField>
              <SettingsField
                label="Email"
                htmlFor={ids.email}
                hint="Optional. Also works as a login."
                error={errorFor("email")}
              >
                <Input
                  id={ids.email}
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={saving}
                  className={FIELD}
                  {...invalidProps(error, "email", ids.email)}
                />
              </SettingsField>
            </div>

            <SettingsField
              label="Role"
              htmlFor={ids.role}
              hint={self ? "You can't change your own role." : ROLES[role].hint}
            >
              <Select value={role} onValueChange={(value) => setRole(value as UserRole)} disabled={saving || self}>
                <SelectTrigger id={ids.role} className={SELECT_TRIGGER}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {USER_ROLES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {ROLES[value].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsField>

            {user ? (
              <label
                htmlFor={ids.active}
                className="flex min-h-12 cursor-pointer items-center gap-4 rounded-lg px-3 py-2.5 ring-1 ring-foreground/10 transition-colors hover:bg-muted/40 has-disabled:cursor-not-allowed has-disabled:hover:bg-transparent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Active</span>
                  <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
                    {self
                      ? "You can't deactivate your own account."
                      : "Inactive users can't sign in; their sessions stop at once."}
                  </span>
                </span>
                <Switch id={ids.active} checked={isActive} onCheckedChange={setIsActive} disabled={saving || self} />
              </label>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <SettingsField
                  label="Password"
                  htmlFor={ids.password}
                  hint={`At least ${MIN_PASSWORD} characters.`}
                  error={errorFor("password")}
                >
                  <PasswordInput
                    id={ids.password}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={saving}
                    {...invalidProps(error, "password", ids.password)}
                  />
                </SettingsField>
                <SettingsField label="Confirm password" htmlFor={ids.confirm} error={errorFor("confirm")}>
                  <PasswordInput
                    id={ids.confirm}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    disabled={saving}
                    {...invalidProps(error, "confirm", ids.confirm)}
                  />
                </SettingsField>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !username.trim() || !dirty || (!user && (!password || !confirm))}
              className="pressable"
            >
              {saving && <Loader2Icon className="animate-spin" />}
              {user ? "Save changes" : "Add user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Set a user's password; that signs them out everywhere (the server keeps you signed in when it's yours). */
function SetPasswordDialog({
  user,
  self,
  open,
  onOpenChange,
}: {
  user: User;
  self: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<FormError | null>(null);
  const [saving, setSaving] = useState(false);

  const ids = { password: `${id}-password`, confirm: `${id}-confirm` };
  const errorFor = (field: FormField) => (error?.field === field ? error.message : null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    const invalid = validatePasswords(password, confirm);
    if (invalid) return setError(invalid);

    setError(null);
    setSaving(true);
    try {
      await api.users.setPassword(user.id, password);
      if (self) toast.success("Password changed — your other devices were signed out");
      else toast.success(`Password set for ${user.username}`, { description: "They were signed out on every device." });
      onOpenChange(false);
    } catch (err) {
      setError(fieldError(err, ["password"]));
      toast.error(errorText(err, "Could not set the password."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <DialogHeader className="pr-8">
            <DialogTitle className="[overflow-wrap:anywhere]">
              {self ? "Change your password" : `Set password for ${user.username}`}
            </DialogTitle>
            <DialogDescription>
              {self
                ? "Your other devices are signed out; this one stays signed in."
                : "They are signed out on every device and sign in again with the new password."}
            </DialogDescription>
          </DialogHeader>

          <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
          <div className="grid gap-4 sm:grid-cols-2">
            <SettingsField
              label="New password"
              htmlFor={ids.password}
              hint={`At least ${MIN_PASSWORD} characters.`}
              error={errorFor("password")}
            >
              <PasswordInput
                id={ids.password}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={saving}
                {...invalidProps(error, "password", ids.password)}
              />
            </SettingsField>
            <SettingsField label="Confirm password" htmlFor={ids.confirm} error={errorFor("confirm")}>
              <PasswordInput
                id={ids.confirm}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                disabled={saving}
                {...invalidProps(error, "confirm", ids.confirm)}
              />
            </SettingsField>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !password || !confirm} className="pressable">
              {saving && <Loader2Icon className="animate-spin" />}
              {self ? "Change password" : "Set password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete a user, choosing what happens to their projects (with cards, comments, runs, schedules)
 * and credentials: transfer them to another active user (default: you) or delete them too.
 */
function DeleteUserDialog({
  user,
  users,
  currentUserId,
  open,
  onOpenChange,
  onDeleted,
}: {
  user: User;
  users: User[];
  currentUserId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (userId: string) => void;
}) {
  const id = useId();
  const candidates = users.filter((other) => other.isActive && other.id !== user.id);
  const [reassignTo, setReassignTo] = useState(
    () => (candidates.find((other) => other.id === currentUserId) ?? candidates[0])?.id ?? "",
  );
  const [mode, setMode] = useState<"transfer" | "delete">(candidates.length > 0 ? "transfer" : "delete");
  const [deleting, setDeleting] = useState(false);
  const target = candidates.find((other) => other.id === reassignTo) ?? null;

  async function onConfirm(e: React.MouseEvent) {
    // Keep the dialog open until the request settles.
    e.preventDefault();
    if (deleting || (mode === "transfer" && !target)) return;
    setDeleting(true);
    try {
      const result = await api.users.remove(user.id, mode === "transfer" && target ? { reassignTo: target.id } : {});
      const projects = `${result.boards} project${result.boards === 1 ? "" : "s"}`;
      const data = `${projects} and ${result.credentials} credential${result.credentials === 1 ? "" : "s"}`;
      toast.success(`Deleted ${user.username}`, {
        description: target && result.reassignedTo ? `${data} moved to ${target.username}.` : `${data} deleted.`,
      });
      onDeleted(user.id);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorText(err, "Could not delete the user."));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !deleting && onOpenChange(next)}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">Delete {user.username}?</AlertDialogTitle>
          <AlertDialogDescription>
            They can no longer sign in. Choose what happens to their projects (with cards, comments, runs and
            schedules) and credentials.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <fieldset disabled={deleting} className="grid min-w-0 gap-2">
          <legend className="sr-only">Their projects and credentials</legend>
          <div
            className={cn(
              "rounded-lg ring-1 ring-foreground/10 transition-colors has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50",
              mode === "transfer" && "bg-primary/5 ring-primary/60",
            )}
          >
            <label className="flex min-h-11 cursor-pointer items-start gap-3 p-3 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-60">
              <input
                type="radio"
                name={`${id}-mode`}
                value="transfer"
                checked={mode === "transfer"}
                onChange={() => setMode("transfer")}
                disabled={candidates.length === 0}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Transfer their projects and credentials to</span>
                {candidates.length === 0 && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">There is no other active user.</span>
                )}
              </span>
            </label>
            {mode === "transfer" && candidates.length > 0 && (
              <div className="-mt-1 pr-3 pb-3 pl-10">
                <Select value={reassignTo} onValueChange={setReassignTo}>
                  <SelectTrigger aria-label="Transfer to" className={SELECT_TRIGGER}>
                    <SelectValue placeholder="Choose a user" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((other) => (
                      <SelectItem key={other.id} value={other.id}>
                        {other.username}
                        {other.id === currentUserId ? " (you)" : ""}
                        {other.role === "admin" ? " · Admin" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <label
            className={cn(
              "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg p-3 text-sm ring-1 ring-foreground/10 transition-colors hover:bg-muted/50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
              mode === "delete" && "bg-destructive/5 ring-destructive/60 hover:bg-destructive/5",
            )}
          >
            <input
              type="radio"
              name={`${id}-mode`}
              value="delete"
              checked={mode === "delete"}
              onChange={() => setMode("delete")}
              className="mt-0.5 size-4 shrink-0 accent-destructive"
            />
            <span className="min-w-0 flex-1">
              <span className={cn("block font-medium", mode === "delete" && "text-destructive")}>
                Delete all their projects, cards and credentials
              </span>
              <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
                Running agents are stopped. Files in project folders are not touched. This can't be undone.
              </span>
            </span>
          </label>
        </fieldset>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting} className="max-md:h-11">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting || (mode === "transfer" && !target)}
            onClick={onConfirm}
            className="max-md:h-11"
          >
            {deleting && <Loader2Icon className="animate-spin" />}
            {mode === "transfer" ? "Transfer and delete" : "Delete everything"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Settings → Users (admins only): who can sign in, their roles, passwords, and removing accounts. */
export function UsersSettingsSection() {
  const { user: currentUser } = useCurrentUser();
  const currentUserId = currentUser?.id ?? null;
  const [users, setUsers] = useState<User[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  /** `manual`: a refresh click, whose failure is toasted (the list stays as it was). */
  const load = useCallback(async (manual = false) => {
    setLoading(true);
    try {
      setUsers(await api.users.list());
      setLoadError(null);
    } catch (err) {
      const message = errorText(err, "Could not load users.");
      setLoadError(message);
      if (manual) toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openDialog(next: DialogTarget) {
    setDialog({ ...next, seq: (dialog?.seq ?? 0) + 1 });
    setDialogOpen(true);
  }

  function upsert(saved: User) {
    setUsers((list) => {
      if (!list) return [saved];
      return list.some((u) => u.id === saved.id) ? list.map((u) => (u.id === saved.id ? saved : u)) : [...list, saved];
    });
  }

  async function toggleActive(user: User) {
    if (togglingId) return;
    setTogglingId(user.id);
    try {
      const saved = await api.users.update(user.id, { isActive: !user.isActive });
      upsert(saved);
      if (saved.isActive) toast.success(`Activated ${saved.username}`, { description: "They can sign in again." });
      else toast.success(`Deactivated ${saved.username}`, { description: "They were signed out on every device." });
    } catch (err) {
      toast.error(errorText(err, user.isActive ? "Could not deactivate the user." : "Could not activate the user."));
    } finally {
      setTogglingId(null);
    }
  }

  const headerAction = (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => void load(true)}
        disabled={loading}
        aria-label="Refresh users"
        title="Refresh"
        className="pressable-icon size-11 md:size-8"
      >
        <RefreshCwIcon className={cn(loading && "animate-spin")} />
      </Button>
      <Button
        type="button"
        onClick={() => openDialog({ kind: "form", user: null })}
        disabled={!users}
        className="pressable h-11 max-sm:w-11 max-sm:px-0 md:h-8"
      >
        <UserPlusIcon />
        <span className="max-sm:sr-only">Add user</span>
      </Button>
    </div>
  );

  return (
    <SettingsSection
      id="users"
      icon={<UsersIcon />}
      title="Users"
      description="Who can sign in. Admins manage users and the shared settings and see every project; users see only their own projects, cards and credentials."
      action={headerAction}
    >
      {loadError && !users ? (
        <SettingsPanel className="flex gap-3 p-4 sm:p-5">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="min-w-0 text-destructive">{loadError}</p>
        </SettingsPanel>
      ) : (
        <SettingsPanel>
          {!users ? (
            <ListSkeleton />
          ) : (
            <ul aria-label="Users" className="divide-y">
              {users.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  self={user.id === currentUserId}
                  toggling={togglingId === user.id}
                  onEdit={() => openDialog({ kind: "form", user })}
                  onSetPassword={() => openDialog({ kind: "password", user })}
                  onToggleActive={() => void toggleActive(user)}
                  onDelete={() => openDialog({ kind: "delete", user })}
                />
              ))}
            </ul>
          )}
        </SettingsPanel>
      )}

      {dialog?.kind === "form" && (
        <UserFormDialog
          key={dialog.seq}
          user={dialog.user}
          self={dialog.user !== null && dialog.user.id === currentUserId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSaved={upsert}
        />
      )}
      {dialog?.kind === "password" && (
        <SetPasswordDialog
          key={dialog.seq}
          user={dialog.user}
          self={dialog.user.id === currentUserId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}
      {dialog?.kind === "delete" && users && (
        <DeleteUserDialog
          key={dialog.seq}
          user={dialog.user}
          users={users}
          currentUserId={currentUserId}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onDeleted={(userId) => setUsers((list) => list?.filter((u) => u.id !== userId) ?? list)}
        />
      )}
    </SettingsSection>
  );
}
