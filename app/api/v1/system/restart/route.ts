import { json, withApi } from "@/lib/server/http";
import { restartStatus, startRestart } from "@/lib/server/restart";

export const dynamic = "force-dynamic";

/** Can the "Restart server" button restart this server, and how did the last restart go. */
export const GET = withApi(({ manager }) =>
  json({ ...restartStatus(), running: manager.stats().running.length }),
);

/** Stop this server, rebuild from the current sources and start it again (detached omp-ui CLI). */
export const POST = withApi(({ manager }) => {
  const interrupted = manager.stats().running.length;
  const mode = startRestart();
  return json({ ok: true, mode, interrupted }, { status: 202 });
}, { admin: true });
