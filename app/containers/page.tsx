"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BoxIcon,
  HardDriveIcon,
  ImageIcon,
  LayersIcon,
  LayoutGridIcon,
  Loader2Icon,
  NetworkIcon,
  RefreshCwIcon,
} from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { AppsCatalog } from "@/components/containers/apps-catalog";
import { ComposeDialog, type ComposeDraft } from "@/components/containers/compose-dialog";
import { ComposeList } from "@/components/containers/compose-list";
import { ContainersList } from "@/components/containers/containers-list";
import { ConfirmDialog, type ConfirmRequest, useJobDialog } from "@/components/containers/dialogs";
import { LogsSheet, type LogsTarget } from "@/components/containers/logs-sheet";
import { QuickLaunch } from "@/components/containers/quick-launch";
import { ImagesList, NetworksList, VolumesList } from "@/components/containers/resources";
import { RunDialog } from "@/components/containers/run-dialog";
import {
  envRows,
  errorMessage,
  formForImage,
  formFromTemplate,
  Notice,
  projectNameFrom,
  type RunForm,
} from "@/components/containers/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api-client";
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

const OVERVIEW_REFRESH_MS = 5000;
const STATS_REFRESH_MS = 10_000;

type Tab = "containers" | "compose" | "apps" | "images" | "volumes" | "networks";

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

export default function ContainersPage() {
  useDocumentTitle("Containers");
  const [overview, setOverview] = useState<DockerOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<Map<string, DockerContainerStats>>(new Map());
  const [tab, setTab] = useState<Tab>("containers");
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<TemplateCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [runForm, setRunForm] = useState<{ form: RunForm; title?: string } | null>(null);
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(null);
  const [logsTarget, setLogsTarget] = useState<LogsTarget | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await api.docker.overview());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load Docker state"));
    }
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
  usePolling(loadStats, STATS_REFRESH_MS, available && anyRunning && tab === "containers");

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
    if (tab === "apps" && !catalog && !catalogLoading && !catalogError) void loadCatalog(false);
  }, [tab, catalog, catalogLoading, catalogError, loadCatalog]);

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
          ? "The container is stopped and deleted. Named volumes are kept."
          : "The container is deleted. Named volumes are kept.",
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
      description: "Its containers and networks are removed. Volumes and the compose file are kept.",
      confirmLabel: "Down",
      destructive: true,
      onConfirm: run,
    });
  }

  function removeCompose(project: ComposeProject) {
    setConfirm({
      title: project.managed ? `Delete the ${project.name} stack?` : `Take ${project.name} down?`,
      description: project.managed
        ? "Its containers and networks are removed and its compose file is deleted from OMP UI's data folder."
        : "Its containers and networks are removed. The compose file on disk is not touched.",
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
  const counts: Record<Tab, number | null> = {
    containers: containers.length,
    compose: overview?.composeProjects.length ?? 0,
    apps: null,
    images: overview?.images.length ?? 0,
    volumes: overview?.volumes.length ?? 0,
    networks: overview?.networks.length ?? 0,
  };
  const tabs: [Tab, string, React.ReactNode][] = [
    ["containers", "Containers", <BoxIcon key="i" />],
    ["compose", "Compose", <LayersIcon key="i" />],
    ["apps", "App catalog", <LayoutGridIcon key="i" />],
    ["images", "Images", <ImageIcon key="i" />],
    ["volumes", "Volumes", <HardDriveIcon key="i" />],
    ["networks", "Networks", <NetworkIcon key="i" />],
  ];

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
      <main className="px-safe pb-safe mx-auto w-full max-w-6xl flex-1">
        <div className="space-y-5 px-4 py-5 sm:px-6 sm:py-8">
          {!overview ? (
            loadError ? (
              <Notice tone="error" title="Could not load Docker state">
                {loadError}
              </Notice>
            ) : (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-40 w-full rounded-2xl" />
                <Skeleton className="h-9 w-96 max-w-full rounded-lg" />
                <Skeleton className="h-64 w-full rounded-xl" />
              </div>
            )
          ) : !overview.available ? (
            <Notice tone="error" title="Docker is not available">
              <p>{overview.error}</p>
              <p className="mt-2">
                OMP UI drives the <code className="font-mono text-xs">docker</code> CLI of the server it runs on
                (set <code className="font-mono text-xs">DOCKER_BIN</code> to use another binary). This page retries every
                few seconds.
              </p>
            </Notice>
          ) : (
            <>
              {loadError && (
                <Notice tone="error" title="Lost contact with the server, showing the last state">
                  {loadError}
                </Notice>
              )}
              <QuickLaunch onRunImage={runImage} onPullImage={pullImage} onLaunch={(t) => void launch(t)} />

              <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-4">
                <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                  <TabsList className="h-10!">
                    {tabs.map(([value, label, icon]) => (
                      <TabsTrigger key={value} value={value} className="gap-1.5 px-3">
                        {icon}
                        {label}
                        {counts[value] !== null && (
                          <span className="text-xs text-muted-foreground tabular-nums">{counts[value]}</span>
                        )}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>

                <TabsContent value="containers">
                  <ContainersList
                    containers={containers}
                    stats={stats}
                    busyIds={busyIds}
                    onAction={(c, action) => void containerAction(c, action)}
                    onLogs={(c) => setLogsTarget({ kind: "container", id: c.id, name: c.name })}
                    onRemove={removeContainer}
                  />
                </TabsContent>
                <TabsContent value="compose">
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
                </TabsContent>
                <TabsContent value="apps">
                  <AppsCatalog
                    catalog={catalog}
                    loading={catalogLoading}
                    error={catalogError}
                    onRefresh={() => void loadCatalog(true)}
                    onLaunch={(t) => void launch(t)}
                  />
                </TabsContent>
                <TabsContent value="images">
                  <ImagesList
                    images={overview.images}
                    onRun={runImage}
                    onPull={pullImage}
                    onPrune={prune}
                    onRemove={(image) => {
                      const ref = image.repository === "<none>" ? image.id : `${image.repository}:${image.tag}`;
                      setConfirm({
                        title: `Remove ${ref}?`,
                        description:
                          image.containers > 0
                            ? "Containers still use this image; remove them first or force it."
                            : "The image is deleted from this host. It can be pulled again.",
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
                </TabsContent>
                <TabsContent value="volumes">
                  <VolumesList
                    volumes={overview.volumes}
                    onPrune={prune}
                    onRemove={(volume) =>
                      setConfirm({
                        title: "Remove this volume?",
                        description: (
                          <>
                            <span className="font-mono break-all">{volume.name}</span> and all data in it are deleted.
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
                </TabsContent>
                <TabsContent value="networks">
                  <NetworksList
                    networks={overview.networks}
                    onPrune={prune}
                    onRemove={(network) =>
                      setConfirm({
                        title: `Remove network ${network.name}?`,
                        description: "Containers still attached to it must be disconnected first.",
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
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </main>

      <RunDialog
        form={runForm?.form ?? null}
        title={runForm?.title}
        networks={overview?.networks ?? []}
        onClose={() => setRunForm(null)}
        onStarted={() => {
          setTab("containers");
          void refresh();
        }}
      />
      <ComposeDialog
        draft={composeDraft}
        onClose={() => setComposeDraft(null)}
        onDeployed={() => {
          setTab("compose");
          void refresh();
        }}
      />
      <LogsSheet target={logsTarget} onClose={() => setLogsTarget(null)} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      {job.dialog}
    </div>
  );
}
