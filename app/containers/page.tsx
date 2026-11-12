"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutGridIcon, Loader2Icon, RefreshCwIcon, ServerOffIcon, UnplugIcon } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { AppsCatalog } from "@/components/containers/apps-catalog";
import { ComposeDialog, type ComposeDraft } from "@/components/containers/compose-dialog";
import { ComposeImportDialog } from "@/components/containers/compose-import-dialog";
import { ComposeList } from "@/components/containers/compose-list";
import { ContainersList } from "@/components/containers/containers-list";
import { ConfirmDialog, type ConfirmRequest, useJobDialog } from "@/components/containers/dialogs";
import { LogsSheet, type LogsTarget } from "@/components/containers/logs-sheet";
import { QuickLaunch } from "@/components/containers/quick-launch";
import { DiskUsage, ImagesList, NetworksList, VolumesList } from "@/components/containers/resources";
import { publishOverview } from "@/components/containers/running-store";
import { RunDialog } from "@/components/containers/run-dialog";
import {
  envRows,
  errorMessage,
  formForImage,
  formFromTemplate,
  Notice,
  projectNameFrom,
  type RunForm,
  SectionHeader,
} from "@/components/containers/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { api } from "@/lib/api-client";
import { BUILTIN_TEMPLATES } from "@/lib/container-templates";
import type {
  ComposeAction,
  ComposeProject,
  ContainerAction,
  ContainerTemplate,
  DockerContainer,
  DockerContainerStats,
  DockerOverview,
  PruneKind,
  TemplateCatalog,
} from "@/lib/docker-types";
import { isModalOpen, isPlainKey } from "@/lib/hotkeys";

const OVERVIEW_REFRESH_MS = 5000;
const STATS_REFRESH_MS = 10_000;

const ACTION_DONE: Record<ContainerAction, string> = {
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
  pause: "Paused",
  unpause: "Resumed",
  kill: "Killed",
};

const PRUNE_TEXT: Record<PruneKind, { title: string; description: string }> = {
  containers: { title: "Remove stopped containers?", description: "Every stopped container is deleted." },
  images: { title: "Remove dangling images?", description: "Untagged images no container uses are deleted." },
  volumes: {
    title: "Remove unused volumes?",
    description: "Anonymous volumes no container uses are deleted, with their data.",
  },
  networks: { title: "Remove unused networks?", description: "Custom networks no container uses are deleted." },
  builder: { title: "Clear the build cache?", description: "Docker's build cache is deleted." },
};

const NEW_STACK_YAML = `services:
  web:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
`;

function usePolling(load: () => Promise<void>, intervalMs: number, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let inFlight = false;
    const tick = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        await load();
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), intervalMs);
    const onVisibility = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, intervalMs, enabled]);
}

/**
 * Running list beside the resources column once the content area (not the viewport: the sidebar
 * takes its share) is 64rem wide; between 42rem and 64rem the resources pair up under the list.
 */
const SPLIT = "grid gap-8 @5xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @5xl:gap-10";
const ASIDE = "grid min-w-0 content-start gap-8 @2xl:grid-cols-2 @5xl:grid-cols-1 @5xl:border-l @5xl:pl-10";

/** Docker missing or the server unreachable: the page's only content, so it gets room and a retry. */
function ProblemPanel({
  icon,
  title,
  detail,
  retrying,
  onRetry,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string | null;
  retrying: boolean;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      role="alert"
      className="animate-card-in mx-auto w-full max-w-2xl overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10 md:mt-8"
    >
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:gap-5 sm:p-8">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive [&_svg]:size-6">
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {detail && (
            <p className="rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {detail}
            </p>
          )}
          <p className="text-sm text-pretty text-muted-foreground">{children}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t bg-muted/30 px-5 py-3 sm:px-8">
        <span className="relative flex size-2 shrink-0" aria-hidden="true">
          <span className="absolute inset-0 animate-ping rounded-full bg-amber-500/60 motion-reduce:hidden" />
          <span className="relative size-2 rounded-full bg-amber-500" />
        </span>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">Retrying every few seconds</span>
        <Button
          variant="outline"
          className="h-11 gap-1.5 active:scale-[0.98] md:h-8"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? <Loader2Icon className="animate-spin motion-reduce:animate-none" /> : <RefreshCwIcon />}
          Retry now
        </Button>
      </div>
    </section>
  );
}

/** Mirrors the loaded page: launcher hero, chip row, then the running list beside the resources. */
function PageSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading Docker state">
      <div className="space-y-4 rounded-2xl p-4 ring-1 ring-foreground/10 sm:p-6">
        <div className="flex gap-3">
          <Skeleton className="size-10 rounded-xl max-sm:hidden" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-3/4 max-w-lg" />
          </div>
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="flex gap-1.5 overflow-hidden">
          {[20, 16, 18, 20, 16, 22, 18, 16].map((w, i) => (
            <Skeleton key={i} className="h-11 shrink-0 rounded-full md:h-8" style={{ width: `${w * 0.25}rem` }} />
          ))}
        </div>
      </div>
      <div className="@container">
        <div className={SPLIT}>
          <div className="min-w-0 space-y-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-11 w-full md:h-9" />
            <div className="divide-y rounded-xl ring-1 ring-foreground/10">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="size-2.5 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                  <Skeleton className="h-8 w-24 max-sm:hidden" />
                </div>
              ))}
            </div>
          </div>
          <div className={ASIDE}>
            {[0, 1].map((i) => (
              <div key={i} className="space-y-3">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-44 w-full rounded-xl" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ContainersPage() {
  useDocumentTitle("Containers");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [overview, setOverview] = useState<DockerOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<Map<string, DockerContainerStats>>(new Map());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog, setCatalog] = useState<TemplateCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [runForm, setRunForm] = useState<{ form: RunForm; title?: string } | null>(null);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [logsTarget, setLogsTarget] = useState<LogsTarget | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [focusLauncher, setFocusLauncher] = useState(false);
  const launcherRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.docker.overview();
      setOverview(next);
      publishOverview(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load Docker state"));
    }
  }, []);

  // Deep links from the header's "Running containers" popover: ?logs=<id>&name=…,
  // ?logs=compose:<project>, ?launch=1.
  const logsParam = searchParams.get("logs");
  const nameParam = searchParams.get("name");
  const launchParam = searchParams.get("launch");
  useEffect(() => {
    if (!logsParam && !launchParam) return;
    if (logsParam?.startsWith("compose:")) {
      const project = logsParam.slice("compose:".length);
      setLogsTarget({ kind: "compose", id: project, name: project });
    } else if (logsParam) {
      setLogsTarget({ kind: "container", id: logsParam, name: nameParam || logsParam });
    }
    if (launchParam) setFocusLauncher(true);
    router.replace("/containers", { scroll: false });
  }, [logsParam, nameParam, launchParam, router]);

  // The launcher exists once Docker answered; focus it as soon as it does.
  useEffect(() => {
    if (!focusLauncher || !launcherRef.current) return;
    launcherRef.current.focus();
    launcherRef.current.select();
    setFocusLauncher(false);
  }, [focusLauncher, overview?.available]);

  // L = focus the launcher ("/" belongs to the command palette).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainKey(event, "l") && !isPlainKey(event, "L")) return;
      if (isModalOpen() || !launcherRef.current) return;
      event.preventDefault();
      launcherRef.current.focus();
      launcherRef.current.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const list = await api.docker.stats();
      setStats(new Map(list.map((s) => [s.id, s])));
    } catch {
      // Stats are a nice-to-have; the list still works without them.
    }
  }, []);

  const available = overview?.available ?? false;
  const anyRunning = (overview?.containers ?? []).some((c) => c.state === "running");
  usePolling(refresh, OVERVIEW_REFRESH_MS, true);
  usePolling(loadStats, STATS_REFRESH_MS, available && anyRunning);

  const job = useJobDialog(() => void refresh());

  const loadCatalog = useCallback(async (reload: boolean) => {
    setCatalogLoading(true);
    try {
      setCatalog(await api.docker.templates(reload));
      setCatalogError(null);
    } catch (err) {
      setCatalogError(errorMessage(err, "Could not load the app catalog"));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (catalogOpen && !catalog && !catalogLoading && !catalogError) void loadCatalog(false);
  }, [catalogOpen, catalog, catalogLoading, catalogError, loadCatalog]);

  async function manualRefresh() {
    setRefreshing(true);
    await Promise.all([refresh(), anyRunning ? loadStats() : undefined]);
    setRefreshing(false);
  }

  // ------------------------------------------------------------------------------------------
  // Containers

  async function containerAction(c: DockerContainer, action: ContainerAction) {
    setBusyIds((s) => new Set(s).add(c.id));
    try {
      await api.docker.containerAction(c.id, action);
      toast.success(`${ACTION_DONE[action]} ${c.name}`);
    } catch (err) {
      toast.error(errorMessage(err, `Could not ${action} ${c.name}`));
    } finally {
      await refresh();
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(c.id);
        return next;
      });
    }
  }

  function removeContainer(c: DockerContainer) {
    setConfirm({
      title: `Remove ${c.name}?`,
      description:
        c.state === "running"
          ? "Stops and deletes the container. Named volumes are kept."
          : "Deletes the container. Named volumes are kept.",
      confirmLabel: "Remove",
      destructive: true,
      option: "Also remove its anonymous volumes",
      onConfirm: async (volumes) => {
        await api.docker.removeContainer(c.id, volumes);
        toast.success(`Removed ${c.name}`);
        await refresh();
      },
    });
  }

  // ------------------------------------------------------------------------------------------
  // Launching

  const composeNames = useMemo(
    () => new Set((overview?.composeProjects ?? []).map((p) => p.name)),
    [overview?.composeProjects],
  );

  async function launch(template: ContainerTemplate) {
    if (template.kind === "container") {
      setRunForm({ form: formFromTemplate(template, overview), title: `Run ${template.title}` });
      return;
    }
    let yaml = template.compose;
    if (!yaml) {
      const pending = toast.loading(`Fetching ${template.title}…`);
      try {
        yaml = (await api.docker.templateCompose(template.id)).yaml;
        toast.dismiss(pending);
      } catch (err) {
        toast.error(errorMessage(err, "Could not fetch the compose file"), { id: pending });
        return;
      }
    }
    setComposeDraft({
      title: `Deploy ${template.title}`,
      name: projectNameFrom(template.source === "builtin" ? template.id : template.title, composeNames),
      yaml,
      env: envRows(template),
      editing: false,
      note: template.note,
    });
  }

  function runImage(image: string) {
    setRunForm({ form: formForImage(image, overview) });
  }

  function pullImage(image: string) {
    job.start({ title: `Pull ${image}`, run: (onLine) => api.docker.pull(image, onLine) });
  }

  // ------------------------------------------------------------------------------------------
  // Compose

  function composeAction(project: ComposeProject, action: ComposeAction) {
    const run = () =>
      job.start({
        title: `${project.name}: compose ${action}`,
        run: (onLine) => api.docker.composeAction(project.name, action, onLine),
      });
    if (action !== "down") return run();
    setConfirm({
      title: `Take ${project.name} down?`,
      description: "Removes its containers and networks. Volumes and the compose file are kept.",
      confirmLabel: "Down",
      destructive: true,
      onConfirm: run,
    });
  }

  function removeCompose(project: ComposeProject) {
    setConfirm({
      title: project.managed ? `Delete the ${project.name} stack?` : `Take ${project.name} down?`,
      description: project.managed
        ? "Removes its containers and networks and deletes its compose file from AgentMan's data folder."
        : "Removes its containers and networks. The compose file on disk is untouched.",
      confirmLabel: project.managed ? "Delete stack" : "Down",
      destructive: true,
      option: "Also delete its volumes (data is lost)",
      onConfirm: (volumes) =>
        job.start({
          title: `Remove ${project.name}`,
          run: (onLine) => api.docker.removeCompose(project.name, volumes, onLine),
        }),
    });
  }

  async function openComposeFile(project: ComposeProject) {
    try {
      const file = await api.docker.composeFile(project.name);
      setComposeDraft({
        title: project.managed ? `Edit ${project.name}` : project.name,
        name: project.name,
        yaml: file.yaml,
        env: file.env,
        editing: true,
        readOnly: !file.managed,
        configFile: file.configFiles[0],
      });
    } catch (err) {
      toast.error(errorMessage(err, "Could not read the compose file"));
    }
  }

  // ------------------------------------------------------------------------------------------
  // Images, volumes, networks

  function prune(kind: PruneKind) {
    setConfirm({
      ...PRUNE_TEXT[kind],
      confirmLabel: "Remove",
      destructive: true,
      onConfirm: async () => {
        const { message } = await api.docker.prune(kind);
        toast.success(message);
        await refresh();
      },
    });
  }

  const containers = overview?.containers ?? [];
  const runningCount = containers.filter((c) => c.state === "running").length;
  const subtitle = overview?.available
    ? `Docker ${overview.version}${overview.composeVersion ? ` · Compose ${overview.composeVersion}` : ""} · ${runningCount} running`
    : "Docker containers and compose stacks";

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader
        title="Containers"
        subtitle={subtitle}
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 rounded-full md:size-9"
            onClick={() => void manualRefresh()}
            aria-label="Refresh"
            title="Refresh"
          >
            {refreshing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon className="size-4.5 md:size-4" />}
          </Button>
        }
      />
      <main className="px-safe pb-safe flex-1">
        <div className="mx-auto w-full max-w-[1400px] space-y-8 px-4 py-6 sm:px-6 md:py-8 lg:px-8">
          {!overview ? (
            loadError ? (
              <ProblemPanel
                icon={<UnplugIcon />}
                title="Could not load Docker state"
                detail={loadError}
                retrying={refreshing}
                onRetry={() => void manualRefresh()}
              >
                The AgentMan server did not respond.
              </ProblemPanel>
            ) : (
              <PageSkeleton />
            )
          ) : !overview.available ? (
            <ProblemPanel
              icon={<ServerOffIcon />}
              title="Docker is not available"
              detail={overview.error}
              retrying={refreshing}
              onRetry={() => void manualRefresh()}
            >
              AgentMan uses the server's <code className="font-mono text-xs">docker</code> CLI. Set{" "}
              <code className="font-mono text-xs">DOCKER_BIN</code> to use another binary.
            </ProblemPanel>
          ) : (
            <>
              {loadError && (
                <Notice tone="error" title="Lost contact with the server; showing last known state">
                  {loadError}
                </Notice>
              )}
              <QuickLaunch
                overview={overview}
                templates={catalog?.templates ?? BUILTIN_TEMPLATES}
                inputRef={launcherRef}
                onWantCatalog={() => {
                  if (!catalog && !catalogLoading && !catalogError) void loadCatalog(false);
                }}
                onCustomizeTemplate={(t) => void launch(t)}
                onCustomizeImage={runImage}
                onPullImage={pullImage}
                onLaunched={() => void refresh()}
                onLogs={setLogsTarget}
                onImportCompose={() => setImportOpen(true)}
              />

              <div className="@container">
                <div className={SPLIT}>
                  <div className="min-w-0 space-y-8">
                    <ContainersList
                      containers={containers}
                      stats={stats}
                      busyIds={busyIds}
                      onAction={(c, action) => void containerAction(c, action)}
                      onLogs={(c) => setLogsTarget({ kind: "container", id: c.id, name: c.name })}
                      onRemove={removeContainer}
                    />
                    <ComposeList
                      projects={overview.composeProjects}
                      onAction={composeAction}
                      onLogs={(p) => setLogsTarget({ kind: "compose", id: p.name, name: p.name })}
                      onOpenFile={(p) => void openComposeFile(p)}
                      onRemove={removeCompose}
                      onNew={() =>
                        setComposeDraft({
                          title: "New compose stack",
                          name: projectNameFrom("stack", composeNames),
                          yaml: NEW_STACK_YAML,
                          env: [],
                          editing: false,
                        })
                      }
                    />
                  </div>

                  <aside aria-label="Resources" className={ASIDE}>
                    <DiskUsage
                      containers={containers}
                      images={overview.images}
                      volumes={overview.volumes}
                      networks={overview.networks}
                      onPrune={prune}
                    />
                    <ImagesList
                      images={overview.images}
                      onRun={runImage}
                      onPull={pullImage}
                      onRemove={(image) => {
                        const ref = image.repository === "<none>" ? image.id : `${image.repository}:${image.tag}`;
                        setConfirm({
                          title: `Remove ${ref}?`,
                          description:
                            image.containers > 0
                              ? "Containers still use this image. Remove them first, or force."
                              : "Deletes the image from this host. You can pull it again.",
                          confirmLabel: "Remove",
                          destructive: true,
                          option: "Force (also untag images used by stopped containers)",
                          onConfirm: async (force) => {
                            await api.docker.removeImage(ref, force);
                            toast.success(`Removed ${ref}`);
                            await refresh();
                          },
                        });
                      }}
                    />
                    <VolumesList
                      volumes={overview.volumes}
                      onRemove={(volume) =>
                        setConfirm({
                          title: "Remove this volume?",
                          description: (
                            <>
                              <span className="font-mono break-all">{volume.name}</span> and all data in it are
                              deleted.
                            </>
                          ),
                          confirmLabel: "Remove",
                          destructive: true,
                          onConfirm: async () => {
                            await api.docker.removeVolume(volume.name);
                            toast.success("Volume removed");
                            await refresh();
                          },
                        })
                      }
                    />
                    <NetworksList
                      networks={overview.networks}
                      onRemove={(network) =>
                        setConfirm({
                          title: `Remove network ${network.name}?`,
                          description: "Disconnect attached containers first.",
                          confirmLabel: "Remove",
                          destructive: true,
                          onConfirm: async () => {
                            await api.docker.removeNetwork(network.id);
                            toast.success(`Removed ${network.name}`);
                            await refresh();
                          },
                        })
                      }
                    />
                  </aside>
                </div>
              </div>

              <section aria-labelledby="catalog-heading" className="space-y-4 border-t pt-6 md:pt-8">
                <SectionHeader
                  id="catalog-heading"
                  title="App catalog"
                  description="Built-in templates plus the Portainer community catalog: containers and compose stacks."
                  actions={
                    <Button
                      variant="outline"
                      className="h-11 gap-1.5 active:scale-[0.98] md:h-8"
                      onClick={() => setCatalogOpen((open) => !open)}
                      aria-expanded={catalogOpen}
                      aria-controls="app-catalog"
                    >
                      <LayoutGridIcon />
                      {catalogOpen ? "Hide catalog" : "Browse catalog"}
                    </Button>
                  }
                />
                {catalogOpen && (
                  <div id="app-catalog" className="animate-fade-in-soft">
                    <AppsCatalog
                      catalog={catalog}
                      loading={catalogLoading}
                      error={catalogError}
                      onRefresh={() => void loadCatalog(true)}
                      onLaunch={(t) => void launch(t)}
                    />
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>

      <RunDialog
        form={runForm?.form ?? null}
        title={runForm?.title}
        networks={overview?.networks ?? []}
        onClose={() => setRunForm(null)}
        onStarted={() => void refresh()}
      />
      <ComposeDialog
        draft={composeDraft}
        onClose={() => setComposeDraft(null)}
        onDeployed={() => void refresh()}
      />
      <ComposeImportDialog
        open={importOpen}
        composeNames={composeNames}
        onClose={() => setImportOpen(false)}
        onEdit={({ name, yaml }) => {
          setImportOpen(false);
          setComposeDraft({ title: "New compose stack", name, yaml, env: [], editing: false });
        }}
        onDeployed={() => void refresh()}
      />
      <LogsSheet target={logsTarget} onClose={() => setLogsTarget(null)} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      {job.dialog}
    </div>
  );
}
