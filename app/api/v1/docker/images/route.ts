import { jobResponse, parseImageRef, pullImage, removeImage } from "@/lib/docker";
import { json, readJson, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Pull `{ image }`. Streams NDJSON `DockerJobEvent`s. */
export const POST = withApi(async ({ req }) => {
  const image = parseImageRef((await readJson(req)).image);
  return jobResponse((send) => pullImage(image, send));
});

/** Remove `?ref=<id or repo:tag>`; `force=1` untags images used by several tags / stopped containers. */
export const DELETE = withApi(async ({ req }) => {
  const query = new URL(req.url).searchParams;
  await removeImage(parseImageRef(query.get("ref")), query.get("force") === "1");
  return json({ ok: true });
});
