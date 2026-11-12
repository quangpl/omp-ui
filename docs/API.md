# AgentMan REST API (v1)

Base path: `/api/v1`. JSON in/out. Errors: HTTP 4xx/5xx with `{ "error": "message" }`.
Designed for the web UI and future mobile clients: a client only needs the **server URL** and the **admin password**.

## Authentication

| Method | Path | Body | Response | Auth |
| --- | --- | --- | --- | --- |
| GET | `/auth/status` | – | `{ configured: boolean, authenticated: boolean }` | none |
| POST | `/auth/setup` | `{ password }` (min 8 chars) | `{ token, expiresAt }` + cookie | none; only while no password is configured (409 otherwise) |
| POST | `/auth/login` | `{ password }` | `{ token, expiresAt }` + cookie | none; 401 on bad password; rate limited (429) |
| POST | `/auth/logout` | – | `{ ok: true }`, clears cookie | any |
| POST | `/auth/password` | `{ current, next }` | `{ token, expiresAt }`; invalidates all older tokens | required |

Authenticated requests send **either** the `omp_ui_token` httpOnly cookie (web) **or** `Authorization: Bearer <token>` (mobile/CLI).
Tokens are HMAC-SHA256 signed, valid 30 days. Changing the password (or `omp-ui passwd`) rotates the signing epoch and revokes every issued token.
The `ADMIN_PASSWORD` env var, when set, is applied at server boot (overwrites the stored hash).

## System

| Method | Path | Response |
| --- | --- | --- |
| GET | `/health` | `{ ok: true, version, db: "sqlite"\|"mongodb"\|"postgres", agents: { running: string[], queued: string[] } }` (no auth). Reads the database, so a database or agent manager that does not answer makes it fail (500); `bin/supervisor.mjs` force-restarts the server after repeated failures. The first call after boot resumes interrupted and failed cards (see Agent rules) |
| GET | `/system` | `{ version, db, omp: { path, installed: boolean, version: string\|null } }` |
| GET | `/system/restart` | `RestartStatus`: `{ available, mode: "cli"\|"pm2"\|null, reason: string\|null, running, log: string\|null, buildFailed, restarting }`. `available` is true when the omp-ui CLI started this server (`DATA_DIR/omp-ui.pid` names its supervisor) and it is not attached to a terminal; otherwise `reason` says why (Docker, dev mode, `start -f`). `running`: agents a restart would interrupt. `log`: last 60 lines of the last restart's output (`DATA_DIR/restart.log`, colors stripped); `buildFailed`: that build failed and the previous build was started instead. `restarting`: a restart's CLI process is still running |
| POST | `/system/restart` | Stop, rebuild and start the server: runs `omp-ui restart --rebuild` (`omp-ui pm2 restart --rebuild` under pm2) in a detached process, output to `DATA_DIR/restart.log`. `202 { ok: true, mode, interrupted }`; the server goes down within seconds. `409` with the reason when unavailable or a restart is already running |
| GET | `/settings` | `AppSettings`: `{ maxConcurrentAgents, ompPath, approvalMode, defaultModel, autoModel, smartQueue, browser, autoRetry, maxAutoRetries }`. `maxConcurrentAgents` is `"auto"` (default; the limit follows the machine, see [Agent queue](#agent-queue)) or an integer 1–16 |
| PATCH | `/settings` | `Partial<AppSettings>` → `AppSettings`. `maxConcurrentAgents`: `"auto"` or an integer 1–16, else 400 `maxConcurrentAgents must be "auto" or an integer between 1 and 16`. `autoModel` (boolean, default `true`): on boards without a model, pick a model role per run from the card (see README). `smartQueue` (boolean, default `true`): a read-only planner agent orders each project's queued cards and links dependent ones through `blockedBy` (see Agent queue). `autoRetry` (boolean, default `true`) and `maxAutoRetries` (integer 0–20, default `5`): automatic retries of failed runs (see Agent rules) |

## Stats

| Method | Path | Response |
| --- | --- | --- |
| GET | `/stats/system` | `SystemStats`: host (hostname, OS, uptime, Node), CPU (model, cores, load average, usage % sampled over ~200 ms), memory, disk of the `DATA_DIR` filesystem (`null` if unavailable), server process (pid, uptime, RSS, heap) and app counts (boards, tasks per status, agents running/queued). Bytes are bytes, durations seconds |
| GET | `/stats/ai?refresh=1` | `AiStats`: provider quota from `omp usage --json` and token/cost usage from `omp stats --json`. Cached 60 s server-side; `refresh=1` bypasses the cache |
| GET | `/stats/maintenance` | `MaintenanceReport` (~1 s): top CPU/memory processes plus every agent-related one, each tagged (`server`, `card-agent`, `helper`, `orphan-agent` for untracked omp agents of this `DATA_DIR` whose parent died, `agent-spawned`, `omp`, `user`, `system`) with `killable`; memory (available, swap, server heap, idle helper agents); storage cleanup items with estimated bytes and `risk` (`safe`/`review`), other large folders (read-only) and recommendations |
| POST | `/stats/maintenance` | `{ kind: "cleanup", ids }` (ids from `CLEANUP_IDS`: leftovers of deleted cards/projects, worktrees of shipped cards, old run configs, drafts and change summaries, rotated logs, SQLite compaction, Docker prunes) · `{ kind: "kill", pids }` (SIGTERM, SIGKILL after 3 s, with killable children; never the server or its ancestors, never a running card's agent) · `{ kind: "release-memory" }` (close idle helper agents, full GC) · `{ kind: "stop-card", taskId }` → `MaintenanceResult { results: { id, ok, message, freedBytes }[], freedBytes }` |

`AiStats.quota` and `AiStats.usage` each carry `available: boolean` and a plain-language `error` (e.g. `"omp is not installed"`, `"omp usage took too long to respond"`); a failing `omp` command never fails the request. Each quota limit has `usedFraction` (0–1), `windowLabel` (e.g. `"5 Hour"`) and `resetsAt` (ISO). Timestamps are ISO strings.

## OMP config

omp's own user config file: `config.yml` in the agent folder that `omp config path` reports (the **Settings → OMP** page). Saves are checked with the omp CLI on a temporary copy, the previous file is kept at `backupPath` (`config.yml.bak`), and the file is replaced atomically (temp file + rename). AgentMan's `approvalMode`, board/default model and `autoModel` override the matching omp keys for its own runs.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/omp-config` | – | `OmpConfigSnapshot`: `{ path, backupPath, format: "yaml", exists, version, raw, values, defaults, schema }`. `version`: content hash of `raw`. `values`: schema key → value set in the file (`null` = unset); `defaults`: what omp uses when unset. `schema`: `OmpConfigField[]` (`{ key, label, type: "model"\|"enum"\|"boolean"\|"number"\|"string", group: "models"\|"behavior"\|"tools", help, options?, min?, max?, placeholder? }`; model roles are `modelRoles.<role>`). 503 when omp is missing or not executable; 500 when the file is not valid YAML |
| PUT | `/omp-config` | `{ values, version? }` (schema key → value; `null` unsets it) or `{ raw, version? }` (the whole file, at most 1 MB) | `OmpConfigSnapshot` after saving. 400 when both or neither of `values`/`raw` are sent, for an unknown key or invalid value, or when omp rejects the config; 409 when `version` no longer matches the file on disk |
| GET | `/omp-config/models?refresh=1` | – | `{ models: OmpModel[] }`, each `{ selector: "provider/model-id", name, provider, thinking: string[] }` (chat models from `omp models --json`; `thinking` is empty for models that do not reason). Cached 5 min; `refresh=1` bypasses the cache |

## Dashboard

| Method | Path | Response |
| --- | --- | --- |
| GET | `/dashboard` | `Dashboard`: everything the home page shows in one request (fields below) |

- `generatedAt`; `totals` (cards per column across all projects).
- `boards`: each `BoardWithCounts` plus `lastActivityAt`, `attentionCount`, `needsYouCount`, `runs30d: { succeeded, failed }` (runs that ended in the last 30 days; stopped runs are not counted) and `git` (`GitStatus[]`, one per project folder, cached a few seconds); most recently active first.
- `attention`: cards that need you (`reason: "failed"` when the agent errored, `"stalled"` when a card sits In progress with no agent working on it; failed first, at most 12). `finished`: Done cards an agent worked on, newest first, at most 6.
- `needsYou`: `NeedsYouCard[]`, most urgent first, at most 50 (`needsYouTotal` is the full count). Each is a dashboard card plus `reasons` (every one that applies, most urgent first: `"question"`, `"failed"`, `"retrying"`, `"feedback"`, `"stalled"`, `"unpushed"`), `question` (the agent's question, truncated; `null` unless `reasons` has `"question"`), `retryAt` and `pushedAt`.
- `queue` (`QueueSnapshot`) and `live`: one `{ taskId, startedAt, model, activity, activityAt }` per running or queued entry (`startedAt` is `null` while queued; `activity` is the agent's latest tool call, status or first line of text).
- `stats`: `day` (last 24 h) and `week` (last 7 days), each `{ runs, succeeded, failed, avgDurationMs, shipped, created }`; `daily`: the same 7 days as rolling 24-hour buckets `{ runs, succeeded, failed, shipped }`, oldest first.
- `activity`: newest first, at most 12, each `{ kind: "created"|"succeeded"|"failed"|"stopped"|"pushed", at, taskId, boardId, boardName, title, durationMs, detail }`.
- `setup: { hasCard, hasRun, hasDone, hasPush, settingsSaved, dockerAvailable }` for the getting-started checklist (`dockerAvailable`: the docker CLI reaches a daemon, cached a few minutes).

## Boards (projects)

A board is one project. `workdir` is the main folder (omp runs there); `extraFolders` are additional folders that belong to the same project (e.g. separate frontend/backend repos), passed to omp as `--add-dir`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/boards` | – | `BoardWithCounts[]` |
| POST | `/boards` | `{ name, workdir, extraFolders?, model?, autoRun?, worktrees? }` | `Board` (201) |
| GET | `/boards/:id` | – | `Board` |
| PATCH | `/boards/:id` | `Partial<{ name, workdir, extraFolders, model, autoRun, worktrees }>` | `Board` |
| DELETE | `/boards/:id` | – | `{ ok: true }` (stops its agents, cascades, removes its shared files and every card's files and workspace) |
| GET | `/boards/:id/tasks` | – | `Task[]` |
| POST | `/boards/:id/tasks` | `{ title, description?, status?, position?, blockedBy? }` or `{ text, position? }` | `Task` (201). Creating directly in `in_progress` with autoRun starts the agent. `text`: a card from free text, see [Card writer](#card-writer) |
| GET | `/boards/:id/files` | – | `SharedFiles` of the board (shared with every card's agent) |
| POST | `/boards/:id/files?name=<file>` | raw file bytes | `SharedFiles` (201); replaces a file of the same name; max 100 MB |
| GET | `/boards/:id/files/<name>` | – | the file (`?download=1` forces a download) |
| DELETE | `/boards/:id/files/<name>` | – | `SharedFiles` |
| GET | `/boards/:id/git` | – | `GitStatus[]`, one per project folder (`workdir` first, then `extraFolders`) |
| GET | `/boards/:id/git/branches?folder=<abs>` | – | `GitBranches`: `current` (null when detached) and `branches` – local ones newest first, then `origin` branches without a local copy (`remoteOnly: true`). No fetch; reflects the last fetch. 400 if `folder` is not a project folder or not a git repository |
| POST | `/boards/:id/git/branches` | `{ folder, branch }` | `GitStatus` of `folder` after checking out `branch` (a `remoteOnly` branch becomes a local branch tracking `origin`). Uncommitted changes carry over; if they would be overwritten git refuses and the 400 says so. 400 if the branch doesn't exist; 409 while any agent on the board is queued or running |
| POST | `/boards/:id/git/push` | – | `{ results: GitRepoActionResult[] }`, one per project git repo – the header's quick push (tap the “N changes” chip). Commits each repo's changes as “Update from AgentMan (N files)” and pushes to its default branch, like “Push to main” but not tied to a card (no comment, no `pushedAt`). 400 if no project folder is a git repository; 409 while any agent on the board is queued or running (boards without dedicated workspaces) |

Folder rules: `workdir` and every `extraFolders` entry must be an absolute path to an existing directory (400 names the bad folder). `extraFolders` holds at most 20 entries; entries are trimmed and de-duplicated, and any entry equal to `workdir` is dropped. Changing `workdir` to a folder that is listed in `extraFolders` removes it from `extraFolders`.

## Folders & cloning

`WORKSPACE_DIR` (env, default `~/omp-workspace`, created if missing) is where the folder picker starts and where repositories are cloned.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/fs/browse?path=<abs>` | – | `FsBrowseResult`: sub-folders of `path` (default `WORKSPACE_DIR`); hidden and unreadable folders skipped, sorted by name, max 500. 400 if `path` is not absolute or not an existing folder |
| POST | `/git/clone` | `{ url, name?, branch? }` | `{ path, output }` (201). `url`: `https://…`, `ssh://…`, `git@host:owner/repo.git`, or an absolute path ending in `.git`. Clones into `WORKSPACE_DIR/<name>` (default: repo name; characters outside `A-Za-z0-9._-` replaced). 409 if that folder exists; 400 with a plain-language reason if the clone fails (10 min timeout) |

Git never prompts: commands run without a terminal (`GIT_TERMINAL_PROMPT=0`, SSH in batch mode), so the server user needs working SSH keys or saved credentials for private remotes.

## Tasks (cards)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/tasks/:id` | – | `{ task: Task, comments: Comment[], runs: Run[] }` |
| PATCH | `/tasks/:id` | `Partial<{ title, description, status, position, blockedBy, question }>` | `Task`. Status change triggers agent rules below. `blockedBy`: ids of other cards on the same board; 400 for the card itself, unknown cards, or a cycle. `question` accepts only `null` (dismiss the agent's question; the agent sets it) |
| DELETE | `/tasks/:id` | – | `{ ok: true }` (also removes the card's files and workspace) |
| POST | `/tasks/:id/run` | – | `Task` (starts/queues agent, moves to In progress) |
| POST | `/tasks/:id/stop` | – | `Task` |
| GET | `/tasks/:id/comments` | – | `Comment[]` |
| POST | `/tasks/:id/comments` | `{ body }` | `Comment` (201, author `user`) – feedback for the agent |
| PATCH | `/comments/:id` | `{ resolved: boolean }` | `Comment` |
| DELETE | `/comments/:id` | – | `{ ok: true }` |
| GET | `/tasks/:id/runs` | – | `Run[]` |
| GET | `/runs/:id/events?after=<seq>&limit=<n>` | – | `RunEvent[]` |
| POST | `/tasks/:id/git/push` | `{ message?, folders? }` | `GitActionResult` – “Push to main” |
| POST | `/tasks/:id/git/pr` | `{ title?, body?, folders? }` | `GitActionResult` – “Create PR/MR” |
| GET | `/tasks/:id/git` | – | `GitStatus[]` of the folders the card ships from: its worktrees, else the project folders |
| GET | `/tasks/:id/workspace` | – | `TaskWorkspace`: one `WorkspaceFolder` per project folder |
| DELETE | `/tasks/:id/workspace` | – | `TaskWorkspace` after removing the card's worktrees and their local branch; 409 while its agent is queued or running |
| GET | `/tasks/:id/files` | – | `SharedFiles` of the card |
| POST | `/tasks/:id/files?name=<file>` | raw file bytes | `SharedFiles` (201); replaces a file of the same name; max 100 MB |
| GET | `/tasks/:id/files/<name>` | – | the file. Images, video (`.mp4`, `.webm`, `.mov`), audio (`.mp3`, `.wav`, `.ogg`), PDF and plain text open inline; anything else (HTML, SVG, …) is always a download. `?download=1` forces a download |
| DELETE | `/tasks/:id/files/<name>` | – | `SharedFiles` |
| GET | `/tasks/:id/diff` | – | `TaskDiff`: the card's code changes. See [Code changes](#code-changes) |
| GET | `/tasks/:id/diff/summary` | – | `DiffSummary`: a one- or two-sentence summary of the changes. See [Code changes](#code-changes) |
| POST | `/tasks/:id/diff/summary` | – | `DiffSummary`, written again (drops the cached one) |

### Card writer

Cards from free text are written by a read-only `omp --mode rpc` agent (steered to answer after 8 lookups, 16 for long requests) in the background; nobody waits for it.

- `POST /boards/:id/tasks` with `{ text, position? }` (`text`: 1–2,000,000 characters) → `Task` (201) at once: in `in_progress` with its run queued (whatever the board's `autoRun`), titled from the text's first line with the text as its description. Text of 2,000+ characters is also saved as the card file `brief.md`, and the description gets a line pointing the agent to it.
- A short single line (up to 100 characters) is the title as typed: its run starts without the card writer.
- Otherwise the run is held (`QueueEntry.drafting`, `queue.updated.drafting`) while the card writer works; its progress lines are sent live as `task.activity` events. When it is done, the card gets the written title and Markdown brief (plus the orchestration line that makes omp split the work across parallel subagents, when the work calls for it) and `blockedBy` gains the open cards it must wait for; a title or description changed meanwhile is kept. Then the run starts.
- If the card writer fails, the card keeps the text as typed, gets an agent comment saying so, and runs. Stopping or deleting the card stops its card writer. Up to half the server's logical cores (at least 4, at most 16) cards are written at once; more wait their turn. After a server restart a card still being written runs as it is.

### Code changes

`GET /tasks/:id/diff` → `TaskDiff`: `{ taskId, repos, stats: { files, additions, deletions }, truncated, hash, generatedAt }`. One `RepoDiff` per folder the card works in (its worktree, else the project folder): `{ folder, name, isRepo, branch, baseRef, commitsAhead, files, truncated, command, error }`. `baseRef` is the ref committed changes are compared against (e.g. `origin/main`; `null` = uncommitted changes only), `commitsAhead` the commits on HEAD not on it, `command` a shell command that shows the full diff, `error` a plain-language git failure (`null` when fine). Each `DiffFile` is `{ path, oldPath, status: "A"|"M"|"D"|"R", additions, deletions, binary, untracked, patch, truncated }`; `patch` holds the unified diff hunks without the file header. Caps: 400 KB of patch text in total and 160 KB per file; untracked files over 256 KB and binary files are listed without content (`patch: null`, `truncated` or `binary` set). `hash` is a content hash of the changes.

`GET /tasks/:id/diff/summary` → `DiffSummary`: `{ text, source: "model"|"fallback", pending, error, hash }`. A helper agent writes the summary; it is cached by `hash` (`DATA_DIR/runtime/diff-summaries/<hash>.json`). The request waits up to 15 s for it; until then (or when the agent fails, with the reason in `error`) `text` is the deterministic file-count line (`source: "fallback"`). While `pending` is true, ask again for the agent's text. `POST` the same path to write it again.

## Agent queue

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/queue` | – | `QueueSnapshot`: `limit` (the effective limit, `concurrency.limit`), `concurrency` (see below), `running` and `queued` (start order) `QueueEntry`s, each with the blocking cards that are not Done yet (`waitingFor`), `planning` (held until the planner has ordered its project's queued cards), `drafting` (held while the card writer writes the card) and `planNote` (the planner's one-line reason, or `null`); `planning` lists the projects being planned right now (`{ boardId, boardName }[]`) |
| POST | `/queue` | `{ taskId, position }` | `QueueSnapshot` after moving a queued card (`position` 0 starts next); 409 if the card is not queued |

Queued cards start in queue order as slots free up, skipping cards whose `blockedBy` cards are not all Done; a card reaching Done re-checks the queue.

With `smartQueue` on, newly queued cards are held for ~1.5 s so cards added together are planned in one batch: a read-only planner agent reorders the project's queued cards (prerequisites and quick unblockers first) and adds the inferred prerequisites to each card's `blockedBy`, so independent cards run in parallel and dependent ones wait. If the planner fails, the cards run in plain FIFO order.

`concurrency` = `{ mode: "auto"|"manual", limit, boundBy: "cpu"|"memory"|"max"|null, cpus, freeMemoryBytes, totalMemoryBytes, reason }`. With `maxConcurrentAgents: "auto"` (the default; `MAX_AGENTS=auto`), `limit` = min(logical cores, running agents + free memory ÷ ~600 MB after keeping 10% of RAM free (at most 2 GB), 32), re-checked every 30 s; `boundBy` names the bound that applied. With a number, `mode` is `manual` and `boundBy` is `null`. `reason` is one line for the UI, e.g. `"Auto: 12 parallel (16 cores, 28 GB free)"`.

### Git buttons (Push to main / Create PR)

Both act on every project folder (`workdir` + `extraFolders`), or only on `folders` (each must be one of the project folders), one folder at a time. On a board with `worktrees`, the card's existing worktrees stand in for the project folders. A failure in one folder doesn't stop the others; each folder gets a `GitRepoActionResult`.

- 409 while the task's agent is queued or running (“Wait for the agent to finish first.”). 400 if none of the folders is a git repository.
- Folders that are not git repositories, or have nothing to commit or push, are returned with `skipped: true`.
- **Push to main**: if there are uncommitted changes, `git add -A` + commit (message = `message` or the task title), then `git push origin HEAD:<default branch>`. The default branch comes from `origin/HEAD` (falling back to `main`/`master`). `url` links to the pushed commit on GitHub/GitLab, otherwise to the repository page. If the remote has newer commits or the branch is protected, that folder's `error` explains it and suggests Create PR. When at least one folder was pushed and none failed, the task's `pushedAt` is set to now (the UI strikes through the card's title).
- **Create PR**: creates branch `omp/<task-slug>-<random>` from the current HEAD (the folder stays on that branch), commits uncommitted changes (message = PR title), `git push -u origin <branch>`, then opens a PR with `gh` (GitHub) or an MR with `glab` (GitLab) against the default branch. PR title defaults to the task title; body defaults to the task description + the latest agent summary + “Created from AgentMan”. Without the CLI (or if it fails, e.g. not signed in), the branch is still pushed and `url` is the provider's “new pull request” page, so the user can open it with one tap.
- If no identity is configured for git on the server, commits are made as `AgentMan <agentman@localhost>`.
- Afterwards one resolved `agent` comment summarising the result in plain language (with links) is posted on the task and returned as `comment`; `comment.added` and `task.updated` are published.

### Agent rules (Trello flow)

- Move a card to **In progress** (PATCH `status`) → omp agent starts in the board `workdir` (when the board has `autoRun`; otherwise call `POST /tasks/:id/run`).
- The web UI creates new cards on `autoRun` boards with `status: "in_progress"`, so they start right away (unless the user opts out). API clients choose `status` themselves; the default is still `todo`.
- Agent finishes successfully → its final message is posted as an `agent` comment, every open feedback comment included in the run is **auto-resolved**, and the card moves to **Done**. If that message asks the user something, the advisor (a read-only `omp -p` agent) triages it first: questions it can answer are posted as an `agent` comment ("**Advisor** answered…"); when an answer needs more work it adds a `user` feedback comment starting with `**Advisor:**`, keeps the card In progress and resumes the agent (once: a run addressing advisor feedback sends its own questions to the user). What is left for the user is stored on `task.question` (cleared when the next run starts or via PATCH `question: null`); the web UI shows it on the card and lets the user answer with one click.
- Agent fails → card stays in **In progress** with `agentState: "error"` and an agent comment explaining the error. With `autoRetry` on, the run is retried automatically in the same omp session after 15 s, 30 s, 1 min, 2 min, 4 min … (at most 10 min apart) while `task.autoRetries` (retries used) is below `maxAutoRetries`; `task.retryAt` is when the next one starts (null when none is scheduled). A success, `POST /tasks/:id/run` or a feedback comment resets `autoRetries` to 0; Stop or moving the card out of In progress cancels a pending retry. The UI shows such a card as **Retrying**.
- Server restart (boot recovery, on the first API call — the supervisor's health probe makes that immediate): runs left `running` are marked `aborted`; queued cards are queued again; with `autoRetry` on, cards that were running and failed In progress cards resume (each using one retry, so a card whose run keeps taking the server down stops once its budget is used up) and pending retries keep their `retryAt`. With `autoRetry` off, cards that were running end with `agentError: "Interrupted by server restart"`.
- Comment on a **Done** card (or an idle In-progress card) → card reopens to **In progress** and the agent resumes the same omp session with the feedback.
- Comment while the agent is **running** → feedback is steered into the live session as an RPC `prompt` with `streamingBehavior: "steer"` (like omp's interactive input, so magic keywords such as `orchestrate` apply; large feedback gets the `orchestrate` keyword added; keywords in another card agent's message are neutralized).
- Move to **To do**/**Done** manually while running → agent is stopped.
- The web UI never sets an arbitrary status: cards move by themselves as their agent works, and the only status-affecting controls are its quick actions — **Start**/**Resume**/**Retry** = `POST /tasks/:id/run`, **Stop** = `POST /tasks/:id/stop`, **Revert to To do** = `PATCH /tasks/:id` with `{ status: "todo" }`. Done cards not pushed yet also get **Push to main** = `POST /tasks/:id/git/push` (no status change). Dragging in the UI only reorders within a column (PATCH `position`). API clients can still PATCH any `status`.

### Workspaces, files, browser and collaboration

- **Dedicated workspaces** (`Board.worktrees`): the card's first run creates `DATA_DIR/workspaces/<taskId>/<folder>` as a git worktree of each project folder that is the top of a git repository with a commit, on branch `omp/<title-slug>-<id>`; the agent runs there. Other folders stay shared. Worktrees and the branch are removed with the card.
- **Files**: every run gets the card's folder (`DATA_DIR/files/tasks/<taskId>`) and the board's (`DATA_DIR/files/boards/<boardId>`) as `--add-dir`. `files.updated` is published on upload/delete and when a run ends.
- **Browser control** (`AppSettings.browser`: `off` · `headless` · `visible` · `relay`): written to a per-run omp config overlay (`--config`); screenshots go to the card's `screenshots/` folder.
- **Agent-to-agent tools** (omp RPC host tools, scoped to the card's board): `board_list_cards`, `board_read_card`, `board_create_card` (new card with `createdByTaskId`, its agent starts unless `start: false`; at most 20 per card, 3 levels deep), `board_message_card` (a `Comment` with `author: "user"` and `fromTaskId` = sender, handled like feedback), `board_wait_for_cards` (blocks until the cards are no longer queued/running; the waiting agent's slot is lent to the queue meanwhile). Plus `ask_advisor` (`{ question, options?, context? }`): the advisor decides the question instead of the user, or marks it as one only the user can answer.

## Docker

Long jobs stream `200 application/x-ndjson`, one `DockerJobEvent` per line: `{ "type": "log", "line" }` while the command works, then one `{ "type": "done", ok, message, id? }`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/docker/running` | – | `RunningSummary`: `{ available, error, containers: DockerContainer[], composeProjects: ComposeProject[] }`, running only (the sidebar badge and its popover). When Docker is unavailable, `available` is `false` and `error` says why; the request does not fail |
| POST | `/docker/quick-run` | `QuickRunSpec`: `RunContainerSpec` fields (`image`, `name?`, `env?`, `volumes?`, `restart?`, `command?`, `network?`, `interactive?`, `privileged?`) plus `autoPorts?` (publish every port the image EXPOSEs; ignored when `ports` is given) and `ports?: { container, host?, protocol? }[]` | NDJSON job; `done.id` is the container id. Pulls the image when missing; busy host ports move to the next free one (default host port = container port, 8000+port below 1024); a taken name gets a `-2` suffix |
| POST | `/docker/quick-compose` | `QuickComposeSpec`: exactly one of `template` (template id), `yaml` or `url`, plus `name?` and `env?` | NDJSON job; `done.id` is the project name. Runs compose `up` as a new project (a taken name gets a `-2` suffix); busy host ports move to free ones |
| GET | `/docker/compose-url?url=<url>` | – | `{ yaml, url }`: downloads a compose file (at most 512 KB, with a timeout). GitHub/GitLab blob links and gists become raw links; 400 when the link returns a web page or the file is too large |
| GET | `/docker/registry/search?q=&registry=dockerhub\|quay` | – | `HubRepository[]`: `{ name, description, stars, pulls, official, verified? }` (`verified`: Docker Hub Verified Publisher) |
| GET | `/docker/registry/tags?repo=<postgres\|owner/name\|quay.io/ns/name>` | – | recent `HubTag[]`: `{ name, size, updatedAt }` |

Registry search and tag results are cached for 2 min; each registry request times out after 6 s.

## Memory

AgentMan fronts a local [agentmemory](https://github.com/rohitg00/agentmemory) server (`AGENTMEMORY_URL`, default `http://127.0.0.1:3111`) that gives card runs persistent memory (see README).

| Method | Path | Response |
| --- | --- | --- |
| GET | `/memory?refresh=1` | `MemoryStatus`: `{ enabled: "auto"\|"true"\|"false", installed, installSource: "path"\|"npx"\|null, version, url, viewerUrl, reachable, healthy, starting, error, level, headline, problems: { level, message, fix? }[], embeddings, embeddingsSource: "server"\|"config", llm, stats, omp: { agentDir, connected, mcp, error } }`. `embeddings` is `"bm25"` (keyless) or the embedding provider (`"local"`, `"openai"`, …), read from the running server or else `~/.agentmemory/.env`; `llm` is the summary provider (`"noop"` when keyless, `null` while down); `stats` is `{ memories, sessions, observations, lessons }` or `null`; `level`/`headline`/`problems` come from agentmemory's own status check. `omp.connected`: `agentmemory connect omp` installed its extension in omp's agent dir; `omp.mcp`: with the MCP toolset. `refresh=1` looks for the CLI again |
| POST | `/memory/start` | `MemoryStatus`. Starts the server unless it is healthy: through the `systemctl --user` unit `agentmemory.service` when it is enabled, else the `agentmemory` CLI. Answers within a minute, with `starting: true` while it still boots. 409 when agentmemory is not installed or `AGENTMEMORY_URL` is not a loopback address |
| POST | `/memory/connect-omp` | `MemoryStatus` after running `agentmemory connect omp --with-mcp` (installs agentmemory's OMP extension, skills and MCP toolset into omp's agent dir). 409 when not installed; 502 with the CLI output when it fails |

The browse routes below proxy the memory server and normalize its records (types in [`lib/memory-types.ts`](../lib/memory-types.ts)). When the server does not answer they return `503 { error, installed, healthy: false }`. `range` is `24h`, `7d`, `30d`, `90d` or `all`; `cursor` is the previous page's `nextCursor`.

| Method | Path | Query | Response |
| --- | --- | --- | --- |
| GET | `/memory/memories` | `project`, `type`, `q`, `range`, `limit` (default 40, ≤100), `cursor` | `MemoryListResponse`: `{ items: MemoryItem[], total, nextCursor }`. Long-term memories (latest versions), newest first, ranked when `q` is given. `total` is `null` with a `range` |
| GET | `/memory/memories/:id` | `layer` (`memory`\|`observation`), `sessionId` (speeds up an observation lookup) | `MemoryDetail`: a `MemoryItem` plus `{ content, facts, concepts, files, sessionIds, version, isLatest, agentId, origin, forgetAfter, sessions: MemorySession[], related: MemoryItem[] }`. Without `layer`, memories are tried first. 404 when not found |
| DELETE | `/memory/memories/:id` | `layer` (`memory`, default, or `observation`), `sessionId` (required for observations) | `{ deleted }`; permanently forgets the record. 404 when nothing was deleted |
| GET | `/memory/search` | `q` (required), `project`, `layer` (`all`, default, `memory` or `observation`), `type`, `range`, `limit` (default 30, ≤40) | `MemorySearchResponse`: `{ mode, items: MemoryItem[], lessons: MemoryLesson[] }`. Hybrid search (BM25, plus vectors and graph when configured); items carry `score`; `lessons` (`{ id, content, confidence, score, project, createdAt }`) only with `layer=all` |
| GET | `/memory/sessions` | `project`, `status` (`active`\|`completed`\|`abandoned`), `q`, `limit` (default 30, ≤100), `cursor` | `MemorySessionsResponse`: `{ items: MemorySession[], nextCursor }`, newest first |
| GET | `/memory/sessions/:id` | `limit` (default 50, ≤200), `cursor` | `MemorySessionDetail`: `{ session, keyDecisions, filesModified, observations: MemoryItem[], total, nextCursor }`, observations newest first. 404 when not found |
| GET | `/memory/stats` | – | `MemoryStoreStats`: `{ version, provider, embeddingProvider, counts: { sessions, activeSessions, observations, memories, latestMemories, lessons, graphNodes, graphEdges }, projects, types, agents, sessionStatuses, sessionProjects, flags: { key, label, enabled }[] }`. `projects` (`{ value, count, boardId, boardName }`) also lists every board by its folder name; the facets are `{ value, count }[]`. `embeddingProvider: "none"` means keyword-only recall |

- `MemoryItem` = `{ id, layer: "memory"\|"observation"\|"lesson"\|"insight", type, title, summary (≤280 chars), project, sessionId, createdAt, updatedAt, importance (0–10), confidence (0–1), score }`.
- `MemorySession` = `{ id, project, cwd, status, startedAt, endedAt, observationCount, model, agentId, firstPrompt, title, narrative, tags, card }`; `card` (`{ boardId, taskId, title }`) links a session to the card whose run it recorded, else `null`.

## Live updates

`GET /events?boardId=<id>` – Server-Sent Events. Each message: `data: <ServerEvent JSON>\n\n`. Omit `boardId` to receive everything; `queue.updated` is sent on every stream. A `: ping` comment is sent every 20 s.

Run events of kind `agent` hold a JSON `SubagentSnapshot` (one subagent of an orchestrated run); the latest per `id` is its state. They are written when a subagent appears, changes status or reports, and when the run ends (subagents still working are marked `aborted`). Progress in between is sent only live as `run.agent`.

Types (`Board`, `Task`, `Comment`, `Run`, `RunEvent`, `AppSettings`, `ServerEvent`, `FsBrowseResult`, `GitStatus`, `GitRepoActionResult`, `GitActionResult`, `SharedFiles`, `TaskWorkspace`, `QueueSnapshot`, `ConcurrencyInfo`, `Dashboard`, `OmpConfigSnapshot`, `OmpModel`, `MemoryStatus`) are defined in [`lib/types.ts`](../lib/types.ts); `TaskDiff` and `DiffSummary` in [`lib/diff-types.ts`](../lib/diff-types.ts); `RunningSummary`, `QuickRunSpec`, `QuickComposeSpec`, `DockerJobEvent` and `HubRepository` in [`lib/docker-types.ts`](../lib/docker-types.ts); the `/memory/*` browse shapes in [`lib/memory-types.ts`](../lib/memory-types.ts).
