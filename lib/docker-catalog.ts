// Server-only: where the Containers page finds things to run. Built-in templates, the Portainer
// app catalog (a widely used public list of one-click containers and compose stacks), and image
// search + tags on Docker Hub and Quay.io. Remote calls time out quickly and never break the page.
import { BUILTIN_TEMPLATES } from "@/lib/container-templates";
import type {
  ContainerTemplate,
  HubRepository,
  HubTag,
  RestartPolicy,
  TemplateCatalog,
  TemplateEnv,
  TemplateVolume,
} from "@/lib/docker-types";
import { HttpError } from "@/lib/server/http";

const FETCH_TIMEOUT_MS = 10_000;
const CATALOG_TTL_MS = 60 * 60_000;
const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/portainer/templates/v3/templates.json";

export type Registry = "dockerhub" | "quay";

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "omp-ui" },
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "is unreachable";
    throw new HttpError(502, `${new URL(url).host} ${reason}`);
  }
  if (res.status === 404) throw new HttpError(404, "Not found");
  if (!res.ok) throw new HttpError(502, `${new URL(url).host} answered HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------------------------
// Portainer app templates (v3 format)

interface PortainerTemplate {
  id?: number;
  type: number;
  title?: string;
  name?: string;
  description?: string;
  categories?: string[];
  logo?: string;
  note?: string;
  image?: string;
  ports?: string[];
  volumes?: { container: string; bind?: string; readonly?: boolean }[];
  env?: {
    name: string;
    label?: string;
    description?: string;
    default?: string;
    preset?: boolean;
    select?: { text: string; value: string; default?: boolean }[];
  }[];
  command?: string;
  interactive?: boolean;
  privileged?: boolean;
  restart_policy?: string;
  repository?: { url: string; stackfile: string };
}

interface CatalogCache {
  at: number;
  templates: ContainerTemplate[];
  /** Template id → raw URL of its compose file. */
  composeUrls: Map<string, string>;
  error: string | null;
}

let cache: CatalogCache | null = null;
let loading: Promise<CatalogCache> | null = null;

function catalogUrl(): string {
  return process.env.OMP_UI_TEMPLATES_URL?.trim() || DEFAULT_CATALOG_URL;
}

/** https://github.com/owner/repo + path → raw file URL on the default branch. */
export function rawGithubUrl(repoUrl: string, file: string): string | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  if (!match || file.includes("..")) return null;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/HEAD/${file.replace(/^\/+/, "")}`;
}

const RESTART: Record<string, RestartPolicy> = {
  no: "no",
  "unless-stopped": "unless-stopped",
  always: "always",
  "on-failure": "on-failure",
};

function toEnv(env: PortainerTemplate["env"]): TemplateEnv[] | undefined {
  if (!env?.length) return undefined;
  return env.map((e) => ({
    name: e.name,
    label: e.label,
    description: e.description,
    default: e.default ?? e.select?.find((option) => option.default)?.value,
    preset: e.preset || undefined,
    options: e.select?.map(({ text, value }) => ({ text, value })),
    secret: /pass(word)?|secret|token/i.test(e.name) && !e.default ? true : undefined,
  }));
}

/** Map Portainer's v3 template list; swarm stacks (type 2) are skipped. */
export function parsePortainerTemplates(data: unknown): { templates: ContainerTemplate[]; composeUrls: Map<string, string> } {
  const raw = data && typeof data === "object" && "templates" in data ? data.templates : undefined;
  if (!Array.isArray(raw)) throw new Error("The template catalog has an unexpected format");
  // Remote JSON: fields are read defensively below (titles, types and repository URLs checked).
  const list: PortainerTemplate[] = raw;
  const templates: ContainerTemplate[] = [];
  const composeUrls = new Map<string, string>();
  list.forEach((t, index) => {
    const title = t.title ?? t.name;
    if (!title) return;
    const id = `portainer-${t.id ?? index}`;
    const base = {
      id,
      source: "portainer" as const,
      title,
      description: t.description ?? "",
      categories: t.categories ?? [],
      logo: t.logo,
      note: t.note,
      env: toEnv(t.env),
    };
    if (t.type === 1 && t.image) {
      const volumes: TemplateVolume[] | undefined = t.volumes?.map((v) => ({
        container: v.container,
        bind: v.bind,
        readonly: v.readonly,
      }));
      templates.push({
        ...base,
        kind: "container",
        image: t.image,
        ports: t.ports,
        volumes,
        command: t.command ?? undefined,
        interactive: t.interactive ?? undefined,
        privileged: t.privileged ?? undefined,
        restart: t.restart_policy ? RESTART[t.restart_policy] : undefined,
      });
    } else if (t.type === 3 && t.repository) {
      const url = rawGithubUrl(t.repository.url, t.repository.stackfile);
      if (!url) return;
      composeUrls.set(id, url);
      templates.push({ ...base, kind: "compose" });
    }
  });
  return { templates, composeUrls };
}

async function loadCatalog(): Promise<CatalogCache> {
  try {
    const parsed = parsePortainerTemplates(await fetchJson(catalogUrl()));
    return { at: Date.now(), ...parsed, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep the last good catalog; retry sooner than the TTL.
    return {
      at: Date.now() - CATALOG_TTL_MS + 60_000,
      templates: cache?.templates ?? [],
      composeUrls: cache?.composeUrls ?? new Map(),
      error: `Could not load the app catalog: ${message}`,
    };
  }
}

async function catalog(refresh: boolean): Promise<CatalogCache> {
  if (!refresh && cache && Date.now() - cache.at < CATALOG_TTL_MS) return cache;
  loading ??= loadCatalog().finally(() => {
    loading = null;
  });
  cache = await loading;
  return cache;
}

export async function getTemplateCatalog(refresh = false): Promise<TemplateCatalog> {
  const remote = await catalog(refresh);
  return { templates: [...BUILTIN_TEMPLATES, ...remote.templates], remoteError: remote.error };
}

/** Compose YAML of a compose template: inline for built-ins, fetched for catalog ones. */
export async function getTemplateCompose(id: string): Promise<string> {
  const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (builtin?.compose) return builtin.compose;
  const url = (await catalog(false)).composeUrls.get(id);
  if (!url) throw new HttpError(404, "Template not found");
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new HttpError(502, "Could not download the compose file of this template");
  }
  if (!res.ok) throw new HttpError(502, `Could not download the compose file (HTTP ${res.status})`);
  return res.text();
}

// ---------------------------------------------------------------------------------------------
// Registry search

interface DockerHubSearch {
  results?: {
    repo_name: string;
    short_description?: string;
    star_count?: number;
    pull_count?: number;
    is_official?: boolean;
  }[];
}

interface QuaySearch {
  results?: {
    kind: string;
    name: string;
    description?: string | null;
    namespace?: { name: string };
    popularity?: number;
    stars?: number;
  }[];
}

export function parseRegistry(value: string | null): Registry {
  if (!value || value === "dockerhub") return "dockerhub";
  if (value === "quay") return "quay";
  throw new HttpError(400, "registry must be dockerhub or quay");
}

export async function searchImages(registry: Registry, query: string): Promise<HubRepository[]> {
  const q = encodeURIComponent(query);
  if (registry === "quay") {
    const data = (await fetchJson(`https://quay.io/api/v1/find/repositories?query=${q}`)) as QuaySearch;
    return (data.results ?? [])
      .filter((r) => r.kind === "repository" && r.namespace?.name)
      .slice(0, 30)
      .map((r) => ({
        name: `quay.io/${r.namespace?.name}/${r.name}`,
        // Quay descriptions are full READMEs; keep the first prose line.
        description:
          (r.description ?? "")
            .split("\n")
            .map((line) => line.replace(/^[#>*\s`-]+/, "").trim())
            .find(Boolean) ?? "",
        stars: r.stars ?? 0,
        pulls: 0,
        official: false,
      }));
  }
  const data = (await fetchJson(
    `https://hub.docker.com/v2/search/repositories/?query=${q}&page_size=30`,
  )) as DockerHubSearch;
  const results: HubRepository[] = (data.results ?? []).map((r) => ({
    name: r.repo_name,
    description: r.short_description ?? "",
    stars: r.star_count ?? 0,
    pulls: r.pull_count ?? 0,
    official: Boolean(r.is_official),
  }));
  // Hub's relevance order can put a namespaced fork above the official image: an exact name
  // match, then official images go first (stable sort keeps Hub's order otherwise).
  const term = query.trim().toLowerCase();
  const rank = (r: HubRepository) => (r.name === term ? 0 : r.official ? 1 : 2);
  return results.sort((a, b) => rank(a) - rank(b));
}

const REPO_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/;

export async function imageTags(repository: string): Promise<HubTag[]> {
  if (repository.startsWith("quay.io/")) {
    const repo = repository.slice("quay.io/".length);
    if (!REPO_RE.test(repo)) throw new HttpError(400, "Invalid repository");
    const data = (await fetchJson(
      `https://quay.io/api/v1/repository/${repo}/tag/?limit=50&onlyActiveTags=true`,
    )) as { tags?: { name: string; size?: number | null; last_modified?: string }[] };
    return (data.tags ?? []).map((t) => ({
      name: t.name,
      size: t.size ?? null,
      updatedAt: t.last_modified ? new Date(t.last_modified).toISOString() : null,
    }));
  }
  if (!REPO_RE.test(repository)) throw new HttpError(400, "Invalid repository");
  const path = repository.includes("/") ? repository : `library/${repository}`;
  const data = (await fetchJson(
    `https://hub.docker.com/v2/repositories/${path}/tags?page_size=50&ordering=last_updated`,
  )) as { results?: { name: string; full_size?: number | null; last_updated?: string | null }[] };
  return (data.results ?? []).map((t) => ({
    name: t.name,
    size: t.full_size ?? null,
    updatedAt: t.last_updated ?? null,
  }));
}
