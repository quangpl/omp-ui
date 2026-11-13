import { artifactProjectResults, parseArtifactPeriod } from "@/lib/artifacts";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** One project's cards that finished in `?from=&to=`: final summary and final attachments only. */
export const GET = withApi<{ boardId: string }>(async ({ repo, req, params }) =>
  json(await artifactProjectResults(repo, params.boardId, parseArtifactPeriod(new URL(req.url).searchParams))),
);
