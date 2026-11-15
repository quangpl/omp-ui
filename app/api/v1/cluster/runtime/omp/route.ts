import { gzipFileResponse } from "@/lib/cluster/bootstrap";
import { primaryOmpBinary } from "@/lib/cluster/omp-runtime";
import { HttpError, withApi } from "@/lib/server/http";
import { getAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Public: gzip of the omp binary this server runs (nodes verify its sha256); 404 when there is none. */
export const GET = withApi(
  async ({ repo }) => {
    const omp = await primaryOmpBinary((await getAppSettings(repo)).ompPath);
    if (!omp) throw new HttpError(404, "omp is not installed on this server");
    return gzipFileResponse(omp.path, "omp.gz");
  },
  { auth: false },
);
