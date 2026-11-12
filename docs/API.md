# OMP UI REST API (v1)

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
| GET | `/health` | `{ ok: true, version, db: "sqlite"\|"mongodb"\|"postgres", agents: { running: string[], queued: string[] } }` (no auth) |
| GET | `/system` | `{ version, db, omp: { path, installed: boolean, version: string\|null } }` |
| GET | `/settings` | `AppSettings`: `{ maxConcurrentAgents, ompPath, approvalMode, defaultModel, autoModel, browser }` |
| PATCH | `/settings` | `Partial<AppSettings>` → `AppSettings`. `autoModel` (boolean, default `true`): on boards without a model, pick a model role per run from the card (see README) |

## Stats

| Method | Path | Response |
| --- | --- | --- |
| GET | `/stats/system` | `SystemStats`: host (hostname, OS, uptime, Node), CPU (model, cores, load average, usage % sampled over ~200 ms), memory, disk of the `DATA_DIR` filesystem (`null` if unavailable), server process (pid, uptime, RSS, heap) and app counts (boards, tasks per status, agents running/queued). Bytes are bytes, durations seconds |
| GET | `/stats/ai?refresh=1` | `AiStats`: provider quota from `omp usage --json` and token/cost usage from `omp stats --json`. Cached 60 s server-side; `refresh=1` bypasses the cache |

`AiStats.quota` and `AiStats.usage` each carry `available: boolean` and a plain-language `error` (e.g. `"omp is not installed"`, `"omp usage took too long to respond"`); a failing `omp` command never fails the request. Each quota limit has `usedFraction` (0–1), `windowLabel` (e.g. `"5 Hour"`) and `resetsAt` (ISO). Timestamps are ISO strings.

## Dashboard

| Method | Path | Response |
| --- | --- | --- |
| GET | `/dashboard` | `Dashboard`: everything the home page shows in one request — `boards` (each `BoardWithCounts` plus `lastActivityAt` and `attentionCount`, most recently active first), `totals` (cards per column across all projects), `attention` (cards that need you: `reason: "failed"` when the agent errored, `"stalled"` when a card sits In progress with no agent working on it; failed first, at most 12), `finished` (Done cards an agent worked on, newest first, at most 6), `queue` (`QueueSnapshot`) and `setup: { hasCard, hasRun, hasDone }` for the getting-started checklist |

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
| POST | `/boards/:id/tasks` | `{ title, description?, status?, position?, blockedBy? }` | `Task` (201). Creating directly in `in_progress` with autoRun starts the agent |
| GET | `/boards/:id/files` | – | `SharedFiles` of the board (shared with every card's agent) |
| POST | `/boards/:id/files?name=<file>` | raw file bytes | `SharedFiles` (201); replaces a file of the same name; max 100 MB |
| GET | `/boards/:id/files/<name>` | – | the file (`?download=1` forces a download) |
| DELETE | `/boards/:id/files/<name>` | – | `SharedFiles` |
| GET | `/boards/:id/git` | – | `GitStatus[]`, one per project folder (`workdir` first, then `extraFolders`) |
| GET | `/boards/:id/git/branches?folder=<abs>` | – | `GitBranches`: `current` (null when detached) and `branches` – local ones newest first, then `origin` branches without a local copy (`remoteOnly: true`). No fetch; reflects the last fetch. 400 if `folder` is not a project folder or not a git repository |
| POST | `/boards/:id/git/branches` | `{ folder, branch }` | `GitStatus` of `folder` after checking out `branch` (a `remoteOnly` branch becomes a local branch tracking `origin`). Uncommitted changes carry over; if they would be overwritten git refuses and the 400 says so. 400 if the branch doesn't exist; 409 while any agent on the board is queued or running |

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
| PATCH | `/tasks/:id` | `Partial<{ title, description, status, position, blockedBy }>` | `Task`. Status change triggers agent rules below. `blockedBy`: ids of other cards on the same board; 400 for the card itself, unknown cards, or a cycle |
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
| GET | `/tasks/:id/files/<name>` | – | the file. Images, PDF and plain text open inline; anything else (HTML, SVG, …) is always a download. `?download=1` forces a download |
| DELETE | `/tasks/:id/files/<name>` | – | `SharedFiles` |

## Agent queue

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/queue` | – | `QueueSnapshot`: `limit` (max agents at once), `running` and `queued` (start order) `QueueEntry`s, each with the blocking cards that are not Done yet (`waitingFor`) |
| POST | `/queue` | `{ taskId, position }` | `QueueSnapshot` after moving a queued card (`position` 0 starts next); 409 if the card is not queued |

Queued cards start in queue order as slots free up, skipping cards whose `blockedBy` cards are not all Done; a card reaching Done re-checks the queue.

### Git buttons (Push to main / Create PR)

Both act on every project folder (`workdir` + `extraFolders`), or only on `folders` (each must be one of the project folders), one folder at a time. On a board with `worktrees`, the card's existing worktrees stand in for the project folders. A failure in one folder doesn't stop the others; each folder gets a `GitRepoActionResult`.

- 409 while the task's agent is queued or running (“Wait for the agent to finish first.”). 400 if none of the folders is a git repository.
- Folders that are not git repositories, or have nothing to commit or push, are returned with `skipped: true`.
- **Push to main**: if there are uncommitted changes, `git add -A` + commit (message = `message` or the task title), then `git push origin HEAD:<default branch>`. The default branch comes from `origin/HEAD` (falling back to `main`/`master`). `url` links to the pushed commit on GitHub/GitLab, otherwise to the repository page. If the remote has newer commits or the branch is protected, that folder's `error` explains it and suggests Create PR.
- **Create PR**: creates branch `omp/<task-slug>-<random>` from the current HEAD (the folder stays on that branch), commits uncommitted changes (message = PR title), `git push -u origin <branch>`, then opens a PR with `gh` (GitHub) or an MR with `glab` (GitLab) against the default branch. PR title defaults to the task title; body defaults to the task description + the latest agent summary + “Created from OMP UI”. Without the CLI (or if it fails, e.g. not signed in), the branch is still pushed and `url` is the provider's “new pull request” page, so the user can open it with one tap.
- If no identity is configured for git on the server, commits are made as `OMP UI <omp-ui@localhost>`.
- Afterwards one resolved `agent` comment summarising the result in plain language (with links) is posted on the task and returned as `comment`; `comment.added` and `task.updated` are published.

### Agent rules (Trello flow)

- Move a card to **In progress** (PATCH `status`) → omp agent starts in the board `workdir` (when the board has `autoRun`; otherwise call `POST /tasks/:id/run`).
- The web UI creates new cards on `autoRun` boards with `status: "in_progress"`, so they start right away (unless the user opts out). API clients choose `status` themselves; the default is still `todo`.
- Agent finishes successfully → its final message is posted as an `agent` comment, every open feedback comment included in the run is **auto-resolved**, and the card moves to **Done**.
- Agent fails → card stays in **In progress** with `agentState: "error"` and an agent comment explaining the error.
- Comment on a **Done** card (or an idle In-progress card) → card reopens to **In progress** and the agent resumes the same omp session with the feedback.
- Comment while the agent is **running** → feedback is steered into the live session.
- Move to **To do**/**Done** manually while running → agent is stopped.
- The web UI never sets an arbitrary status: cards move by themselves as their agent works, and the only status-affecting controls are its quick actions — **Start**/**Resume**/**Retry** = `POST /tasks/:id/run`, **Stop** = `POST /tasks/:id/stop`, **Revert to To do** = `PATCH /tasks/:id` with `{ status: "todo" }`. Dragging in the UI only reorders within a column (PATCH `position`). API clients can still PATCH any `status`.

### Workspaces, files, browser and collaboration

- **Dedicated workspaces** (`Board.worktrees`): the card's first run creates `DATA_DIR/workspaces/<taskId>/<folder>` as a git worktree of each project folder that is the top of a git repository with a commit, on branch `omp/<title-slug>-<id>`; the agent runs there. Other folders stay shared. Worktrees and the branch are removed with the card.
- **Files**: every run gets the card's folder (`DATA_DIR/files/tasks/<taskId>`) and the board's (`DATA_DIR/files/boards/<boardId>`) as `--add-dir`. `files.updated` is published on upload/delete and when a run ends.
- **Browser control** (`AppSettings.browser`: `off` · `headless` · `visible` · `relay`): written to a per-run omp config overlay (`--config`); screenshots go to the card's `screenshots/` folder.
- **Agent-to-agent tools** (omp RPC host tools, scoped to the card's board): `board_list_cards`, `board_read_card`, `board_create_card` (new card with `createdByTaskId`, its agent starts unless `start: false`; at most 20 per card, 3 levels deep), `board_message_card` (a `Comment` with `author: "user"` and `fromTaskId` = sender, handled like feedback), `board_wait_for_cards` (blocks until the cards are no longer queued/running; the waiting agent's slot is lent to the queue meanwhile).

## Live updates

`GET /events?boardId=<id>` – Server-Sent Events. Each message: `data: <ServerEvent JSON>\n\n`. Omit `boardId` to receive everything; `queue.updated` is sent on every stream. A `: ping` comment is sent every 20 s.

Run events of kind `agent` hold a JSON `SubagentSnapshot` (one subagent of an orchestrated run); the latest per `id` is its state. They are written when a subagent appears, changes status or reports, and when the run ends (subagents still working are marked `aborted`). Progress in between is sent only live as `run.agent`.

Types (`Board`, `Task`, `Comment`, `Run`, `RunEvent`, `AppSettings`, `ServerEvent`, `FsBrowseResult`, `GitStatus`, `GitRepoActionResult`, `GitActionResult`, `SharedFiles`, `TaskWorkspace`, `QueueSnapshot`) are defined in [`lib/types.ts`](../lib/types.ts).
