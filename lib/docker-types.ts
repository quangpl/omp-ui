// Shapes of the `/api/v1/docker/**` endpoints (shared by the server and the Containers page).

export type ContainerState =
  | "running"
  | "paused"
  | "restarting"
  | "exited"
  | "created"
  | "removing"
  | "dead";

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  /** Human status from docker, e.g. "Up 3 days (healthy)". */
  status: string;
  /** "healthy" | "unhealthy" | "starting" | null when the image has no healthcheck. */
  health: string | null;
  command: string;
  createdAt: string;
  ports: DockerPort[];
  /** Compose project / service when the container belongs to a compose project. */
  composeProject: string | null;
  composeService: string | null;
  networks: string[];
  mounts: string[];
}

export interface DockerPort {
  /** Host IP ("0.0.0.0", "::"), or null when the port is only exposed. */
  hostIp: string | null;
  hostPort: number | null;
  containerPort: number;
  protocol: string;
}

export interface ComposeProject {
  name: string;
  /** Raw compose status, e.g. "running(2)" or "exited(1), running(1)". */
  status: string;
  configFiles: string[];
  /** Created from OMP UI (its compose file lives under DATA_DIR/compose/<name>/). */
  managed: boolean;
  running: number;
  total: number;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdSince: string;
  /** Containers using it (any state); 0 = unused. */
  containers: number;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  /** Containers mounting it (any state). */
  usedBy: string[];
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  /** bridge/host/none: cannot be removed. */
  builtin: boolean;
}

/** GET /docker — everything the Containers page shows; polled. */
export interface DockerOverview {
  available: boolean;
  /** Plain-language reason when `available` is false (docker missing, daemon down, no permission). */
  error: string | null;
  version: string | null;
  composeVersion: string | null;
  containers: DockerContainer[];
  composeProjects: ComposeProject[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
}

/** GET /docker/stats — live usage of running containers (`docker stats --no-stream`). */
export interface DockerContainerStats {
  id: string;
  name: string;
  cpuPercent: number;
  memPercent: number;
  memUsage: string;
  netIO: string;
  blockIO: string;
}

export type ContainerAction = "start" | "stop" | "restart" | "pause" | "unpause" | "kill";
export type ComposeAction = "up" | "down" | "stop" | "start" | "restart" | "pull";
export type PruneKind = "containers" | "images" | "volumes" | "networks" | "builder";

export interface PortMapping {
  /** Empty = same as the container port; "127.0.0.1:8080" binds one interface. */
  host: string;
  container: number;
  protocol: "tcp" | "udp";
}

export interface EnvVar {
  key: string;
  value: string;
}

export interface VolumeMapping {
  /** Named volume ("pgdata") or absolute host path; empty = anonymous volume. */
  source: string;
  target: string;
  readonly: boolean;
}

export type RestartPolicy = "no" | "unless-stopped" | "always" | "on-failure";

/** POST /docker/run body. */
export interface RunContainerSpec {
  image: string;
  name?: string;
  ports?: PortMapping[];
  env?: EnvVar[];
  volumes?: VolumeMapping[];
  restart?: RestartPolicy;
  /** Arguments after the image, split like a shell would (quotes respected). */
  command?: string;
  network?: string;
  /** Keep STDIN open with a TTY (`-it`), for shells like ubuntu. */
  interactive?: boolean;
  privileged?: boolean;
}

/** POST /docker/compose body: write DATA_DIR/compose/<name>/compose.yaml (+ .env) and `up -d`. */
export interface ComposeDeploySpec {
  name: string;
  yaml: string;
  env?: EnvVar[];
}

/** GET /docker/compose/:name */
export interface ComposeFile {
  name: string;
  managed: boolean;
  configFiles: string[];
  yaml: string;
  env: EnvVar[];
}

/**
 * POST /docker/quick-run body: `docker run -d` with smart defaults. The image is pulled first when
 * missing; busy host ports move to the next free one and a taken name gets a "-2" suffix.
 */
export interface QuickRunSpec extends Omit<RunContainerSpec, "ports"> {
  /** Publish every port the image EXPOSEs (ignored when `ports` is given). */
  autoPorts?: boolean;
  /** Container ports with a preferred host port (default: same port, 8000+port below 1024). */
  ports?: { container: number; host?: number; protocol?: "tcp" | "udp" }[];
}

/** POST /docker/quick-compose body: exactly one of `template`, `yaml` or `url`. */
export interface QuickComposeSpec {
  /** Preferred project name; a taken one gets a "-2" suffix. */
  name?: string;
  template?: string;
  yaml?: string;
  /** Raw compose file URL; GitHub/GitLab/Gist page links are turned into raw links. */
  url?: string;
  env?: EnvVar[];
}

/** GET /docker/running: running containers and compose projects (header badge and popover). */
export interface RunningSummary {
  available: boolean;
  error: string | null;
  containers: DockerContainer[];
  composeProjects: ComposeProject[];
}

/**
 * NDJSON events of long docker jobs (pull, run, compose up/down/pull): output lines while the
 * command works, then one `done`.
 */
export type DockerJobEvent =
  | { type: "log"; line: string }
  | { type: "done"; ok: boolean; message: string; id?: string };

/** GET /docker/registry/search */
export interface HubRepository {
  /** Pullable name: "postgres" for official images, else "owner/name". */
  name: string;
  description: string;
  stars: number;
  pulls: number;
  official: boolean;
  /** Docker Hub "Verified Publisher" image. */
  verified?: boolean;
}

/** GET /docker/hub/tags */
export interface HubTag {
  name: string;
  size: number | null;
  updatedAt: string | null;
}

export interface TemplateEnv {
  name: string;
  label?: string;
  description?: string;
  default?: string;
  /** Secrets get a generated value when no default is given. */
  secret?: boolean;
  /** Fixed value the template needs; shown but not prompted for. */
  preset?: boolean;
  options?: { text: string; value: string }[];
}

export interface TemplateVolume {
  container: string;
  /** Host path / named volume suggested by the template. */
  bind?: string;
  readonly?: boolean;
}

/** A one-click app: either a single container (`image`) or a compose stack (`compose`). */
export interface ContainerTemplate {
  id: string;
  /** "builtin" ships with OMP UI; "portainer" comes from the Portainer app catalog. */
  source: "builtin" | "portainer";
  kind: "container" | "compose";
  title: string;
  description: string;
  categories: string[];
  logo?: string;
  note?: string;
  // container templates
  image?: string;
  /** "5432/tcp" or "8080:80/tcp" (host:container). */
  ports?: string[];
  volumes?: TemplateVolume[];
  command?: string;
  interactive?: boolean;
  privileged?: boolean;
  restart?: RestartPolicy;
  env?: TemplateEnv[];
  // compose templates: inline YAML (builtin) or fetched on demand (portainer)
  compose?: string;
}

/** GET /docker/templates */
export interface TemplateCatalog {
  templates: ContainerTemplate[];
  /** Why the remote catalog could not be loaded (built-ins are still returned). */
  remoteError: string | null;
}
