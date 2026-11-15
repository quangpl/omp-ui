import { gzipFileResponse } from "@/lib/cluster/bootstrap";
import { HttpError, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Public: gzip of the Node.js binary running this server, for a joining machine of the same
 * `?platform=&arch=` (Node's names, e.g. linux/x64); 404 otherwise (it downloads from nodejs.org).
 */
export const GET = withApi(
  ({ req }) => {
    const query = new URL(req.url).searchParams;
    if (query.get("platform") !== process.platform || query.get("arch") !== process.arch) {
      throw new HttpError(404, `This server runs Node.js on ${process.platform}-${process.arch}`);
    }
    return gzipFileResponse(process.execPath, "node.gz");
  },
  { auth: false },
);
