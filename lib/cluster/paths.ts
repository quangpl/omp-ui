// Where cluster mode keeps its files: everything lives under DATA_DIR/cluster/.
import path from "node:path";
import { dataDir } from "@/lib/files";

export function clusterDir(): string {
  return path.join(dataDir(), "cluster");
}

export interface ClusterPaths {
  root: string;
  /** Node-local state (NodeState), mode 0600. */
  nodeFile: string;
  /** Replicas: copies of the primary's project folders, at `<mirror><primary absolute path>`. */
  mirror: string;
  /** Replicas: copy of the primary's omp agent dir (config, credentials, skills, extensions, mcp.json). */
  ompAgent: string;
  /** Replicas: omp binaries downloaded from the primary, `omp-<sha256 prefix>`. */
  bin: string;
  /** Per-card omp session dirs of runs in cluster mode (`--session-dir`); replicated like card files. */
  sessions: string;
  /** Primary: staging copies (omp agent dir pack, database snapshot) that are synced to nodes. */
  staging: string;
  /** Replicas: where the primary's database snapshot lands before it replaces the local one. */
  replicaDb: string;
  /** Database backups taken before a node's own data is replaced (join, demotion). */
  backups: string;
}

export function clusterPaths(): ClusterPaths {
  const root = clusterDir();
  return {
    root,
    nodeFile: path.join(root, "node.json"),
    mirror: path.join(root, "mirror"),
    ompAgent: path.join(root, "omp-agent"),
    bin: path.join(root, "bin"),
    sessions: path.join(root, "sessions"),
    staging: path.join(root, "staging"),
    replicaDb: path.join(root, "replica-db"),
    backups: path.join(root, "backups"),
  };
}

/** omp `--session-dir` of a card's runs in cluster mode. */
export function sessionDirFor(taskId: string): string {
  return path.join(clusterPaths().sessions, taskId);
}

/** Where a replica keeps its copy of an absolute primary path. */
export function mirrorPath(primaryPath: string, mirrorRoot: string = clusterPaths().mirror): string {
  return path.join(mirrorRoot, path.resolve(primaryPath));
}

/**
 * The original path behind a mirrored one: a primary promoted from a replica serves its projects
 * from `<its mirror root><original path>`; stripping that root gives the path on the machine the
 * project came from (unchanged when `p` is not under `mirrorRoot`). Folders are mirrored and
 * mapped by their canonical path, so a project keeps one copy per machine across promotions and a
 * returning home primary finds its own folders again.
 */
export function canonicalPath(p: string, mirrorRoot: string = clusterPaths().mirror): string {
  const resolved = path.resolve(p);
  const root = path.resolve(mirrorRoot);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved.slice(root.length) : resolved;
}
