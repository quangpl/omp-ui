import { checkCredential } from "@/lib/server/credentials";
import { json, withApi } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type Params = { id: string };

/** Health-check a saved credential now and store the outcome: `{ credential, result }`. */
export const POST = withApi<Params>(async ({ repo, params }) => json(await checkCredential(repo, params.id)));
