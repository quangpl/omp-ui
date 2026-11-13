import { listArtifactProjects, parseArtifactPeriod } from "@/lib/artifacts";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** Every project with how many cards finished (and their final attachments) in `?from=&to=`. */
export const GET = withApi(async ({ repo, req }) =>
  json(await listArtifactProjects(repo, parseArtifactPeriod(new URL(req.url).searchParams))),
);
