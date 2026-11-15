import { clusterRole, readNodeState } from "@/lib/cluster/node";
import { primaryOmpBinary } from "@/lib/cluster/omp-runtime";
import { replicaConnection } from "@/lib/cluster/replica";
import { CLUSTER_PROTOCOL_VERSION } from "@/lib/cluster/types";
import { json, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";
import type { ClusterInfo } from "@/lib/types";
import { APP_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

/** Public: what a joining machine needs before it authenticates (cluster port, platform, omp). */
export const GET = withApi(
  async ({ repo }) => {
    const omp = await primaryOmpBinary((await getAppSettings(repo)).ompPath);
    const info: ClusterInfo = {
      version: APP_VERSION,
      protocol: CLUSTER_PROTOCOL_VERSION,
      role: clusterRole(),
      connection: replicaConnection()?.state ?? null,
      port: readNodeState().port,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      omp: { available: omp !== null, version: omp?.version ?? null, sha256: omp?.sha256 ?? null },
    };
    return json(info);
  },
  { auth: false },
);
