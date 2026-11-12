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
| GET | `/health` | `{ ok: true, version, db: "sqlite"\|"mongodb", agents: { running: string[], queued: string[] } }` (no auth) |
| GET | `/system` | `{ version, db, omp: { path, installed: boolean, version: string\|null } }` |
| GET | `/settings` | `AppSettings` |
| PATCH | `/settings` | `Partial<AppSettings>` → `AppSettings` |

## Boards

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/boards` | – | `BoardWithCounts[]` |
| POST | `/boards` | `{ name, workdir, model?, autoRun? }` | `Board` (201). 400 if `workdir` is not an existing directory |
| GET | `/boards/:id` | – | `Board` |
| PATCH | `/boards/:id` | `Partial<{ name, workdir, model, autoRun }>` | `Board` |
| DELETE | `/boards/:id` | – | `{ ok: true }` (stops its agents, cascades) |
| GET | `/boards/:id/tasks` | – | `Task[]` |
| POST | `/boards/:id/tasks` | `{ title, description?, status?, position? }` | `Task` (201). Creating directly in `in_progress` with autoRun starts the agent |

## Tasks (cards)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/tasks/:id` | – | `{ task: Task, comments: Comment[], runs: Run[] }` |
| PATCH | `/tasks/:id` | `Partial<{ title, description, status, position }>` | `Task`. Status change triggers agent rules below |
| DELETE | `/tasks/:id` | – | `{ ok: true }` |
| POST | `/tasks/:id/run` | – | `Task` (starts/queues agent, moves to In progress) |
| POST | `/tasks/:id/stop` | – | `Task` |
| GET | `/tasks/:id/comments` | – | `Comment[]` |
| POST | `/tasks/:id/comments` | `{ body }` | `Comment` (201, author `user`) – feedback for the agent |
| PATCH | `/comments/:id` | `{ resolved: boolean }` | `Comment` |
| DELETE | `/comments/:id` | – | `{ ok: true }` |
| GET | `/tasks/:id/runs` | – | `Run[]` |
| GET | `/runs/:id/events?after=<seq>&limit=<n>` | – | `RunEvent[]` |

### Agent rules (Trello flow)

- Move a card to **In progress** → omp agent starts in the board `workdir` (when the board has `autoRun`; otherwise press *Run*).
- Agent finishes successfully → its final message is posted as an `agent` comment, every open feedback comment included in the run is **auto-resolved**, and the card moves to **Done**.
- Agent fails → card stays in **In progress** with `agentState: "error"` and an agent comment explaining the error.
- Comment on a **Done** card (or an idle In-progress card) → card reopens to **In progress** and the agent resumes the same omp session with the feedback.
- Comment while the agent is **running** → feedback is steered into the live session.
- Move to **To do**/**Done** manually while running → agent is stopped.

## Live updates

`GET /events?boardId=<id>` – Server-Sent Events. Each message: `data: <ServerEvent JSON>\n\n`. Omit `boardId` to receive everything. A `: ping` comment is sent every 20 s.

Types (`Board`, `Task`, `Comment`, `Run`, `RunEvent`, `AppSettings`, `ServerEvent`) are defined in [`lib/types.ts`](../lib/types.ts).
