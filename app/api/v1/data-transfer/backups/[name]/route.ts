import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { backupFile } from "@/lib/server/data-transfer";
import { withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { name: string };

/** Download an automatic pre-import backup; importing it restores that state. */
export const GET = withApi<Params>(
  async ({ params }) => {
    const file = await backupFile(params.name);
    const { size } = await fs.stat(file);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "application/gzip",
        "content-length": String(size),
        "content-disposition": `attachment; filename="${params.name}"`,
        "cache-control": "no-store",
      },
    });
  },
  { admin: true },
);
