// Model for a run: a model pinned on the board wins, then the provider priority's pick or the
// settings default model. With none of those, no `--model` is passed and omp chooses by its own
// config (its `default` role) and default behavior.
import { execFile } from "node:child_process";
import type { ProviderPick } from "@/lib/provider-priority";
import type { AppSettings, Board } from "@/lib/types";

/** `omp config get modelRoles`: role name → model selector (may carry a `:thinking` suffix). */
export type ModelRoles = Record<string, string>;

export interface ModelChoice {
  /** `--model` value (a model selector); null leaves the choice to omp. */
  model: string | null;
  /**
   * `board`: pinned on the board; `provider`: the provider priority's active entry
   * (lib/provider-priority.ts); `default`: the settings default (null model: omp decides);
   * `session`: a resumed session keeps the model it saved.
   */
  source: "board" | "provider" | "default" | "session";
}

/**
 * Model for a run. Precedence: the board's pinned model; then the provider priority's active
 * entry (lib/provider-priority.ts pickProvider); then the settings default model; otherwise null,
 * so omp picks its own model.
 *
 * A resumed run with no pinned model passes no `--model`: omp restores the session's saved model,
 * like continuing a direct omp chat. Switching models there would re-send the whole cached history
 * to another model, a full prompt-cache miss. A pinned board model stays an explicit choice and
 * still applies, and so does the provider's model when the retried run ran out of quota
 * (`quotaRetry`): its saved model is the one without quota.
 */
export function chooseModel(input: {
  board: Pick<Board, "model">;
  settings: Pick<AppSettings, "defaultModel">;
  isResume: boolean;
  provider?: ProviderPick | null;
  quotaRetry?: boolean;
}): ModelChoice {
  const pinned = input.board.model?.trim();
  if (pinned) return { model: pinned, source: "board" };
  const active = input.provider?.entry ?? null;
  if (input.isResume) {
    return active && input.quotaRetry
      ? { model: active.model, source: "provider" }
      : { model: null, source: "session" };
  }
  if (active) return { model: active.model, source: "provider" };
  return { model: input.settings.defaultModel.trim() || null, source: "default" };
}

const ROLES_TIMEOUT_MS = 5_000;
/** Reads in flight per omp + folder: cards launching together share one `omp config` process. */
const rolesInFlight = new Map<string, Promise<ModelRoles | null>>();

/**
 * Model roles omp resolves in `cwd` (global config plus the project's `.omp`), via
 * `omp config get modelRoles --json`. Null when omp cannot report them (old omp, bad path).
 * Concurrent calls for the same omp and folder share one read; later calls read again.
 */
export function readModelRoles(ompPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ModelRoles | null> {
  const key = JSON.stringify([ompPath, cwd]);
  const pending = rolesInFlight.get(key);
  if (pending) return pending;
  const { promise, resolve } = Promise.withResolvers<ModelRoles | null>();
  rolesInFlight.set(key, promise);
  execFile(
    ompPath,
    ["config", "get", "modelRoles", "--json"],
    { cwd, env, timeout: ROLES_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    (err, stdout) => {
      rolesInFlight.delete(key);
      resolve(err ? null : parseRoles(String(stdout)));
    },
  );
  return promise;
}

/** `{ "key": "modelRoles", "value": { role: selector } }`; a null value means no roles are set. */
function parseRoles(stdout: string): ModelRoles | null {
  let value: unknown;
  try {
    value = (JSON.parse(stdout) as { value?: unknown } | null)?.value;
  } catch {
    return null;
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const roles: ModelRoles = {};
  for (const [name, selector] of Object.entries(value)) {
    if (typeof selector === "string" && selector.trim()) roles[name] = selector.trim();
  }
  return roles;
}
