# OMP UI

A self-hosted kanban board for [omp](https://omp.sh/docs) coding agents. Write a card, drag it to **In progress**, and an agent does the work. It runs on your computer or server and works well on your phone.

## Start in one command

```sh
./omp-ui up
```

`up` asks for an admin password, then installs, builds and starts OMP UI. It prints a link to open on this computer and one for your phone on the same Wi-Fi.

Before you start you need **Node.js 24+** and **omp**, installed and signed in:

```sh
curl -fsSL https://omp.sh/install | sh   # install omp
omp                                      # run once, sign in to a provider
```

To use **Docker** instead (omp is included in the image, and your sign-ins are shared with it — see [Credentials](#credentials)):

```sh
./omp-ui docker up                       # or: docker compose up -d — then open http://localhost:3000
```

## How it works

1. **Create a project.** Pick its folder, or clone a Git repository. A project can include extra folders too, for example a separate frontend and backend repo.
2. **Add a card and drag it to *In progress*.** An omp agent starts working on it in your project folders. You can watch it work live.
3. **Comment to give feedback.** The agent picks up your comments, marks them resolved, and moves the card to **Done** when it finishes. Comment on a Done card and the agent reopens it and continues where it left off.

Then ship the result with one tap: **Create PR/MR** or **Push to main**.

**Quick actions.** Press <kbd>N</kbd> on any page to add a card (<kbd>Shift</kbd>+<kbd>N</kbd> also starts its agent); outside a board, the form asks which project. Right-click a card to open it, run or stop its agent, move, duplicate, copy its link, or delete it. Right-click the board background or a project on the Projects page to add a card there.

<details>
<summary>The details</summary>

- The columns are **To do**, **In progress** and **Done**.
- Each project runs `omp --cwd <primary folder>`, plus `--add-dir <folder>` for every extra folder.
- An agent's prompt is the card's title and description plus any unresolved comments.
- For a large card (4+ list items or comments, 300+ words, or asks like "across the codebase", "every page", "in parallel"), the prompt also includes omp's `orchestrate` keyword, so omp splits the work across parallel subagents.
- A comment on a running card is sent straight into the live session.
- When a run succeeds, the agent's final message is posted as a comment, the feedback it handled is resolved, and the card moves to Done.
- If a run fails, the card stays in In progress with the error. Comment, or press **Run**, to retry.
- If you drag a running card out of In progress, its agent stops.
- Up to `MAX_AGENTS` agents run at the same time. The others wait in a queue.

</details>

## Shipping changes

A card has two buttons. Each one acts on every project folder that has changes.

| Button | What happens | Needs |
| --- | --- | --- |
| **Create PR/MR** (recommended) | Commits to a new `omp/<card>` branch, pushes it, and opens a pull request (GitHub) or merge request (GitLab) | `git` plus [`gh`](https://cli.github.com) for GitHub or [`glab`](https://gitlab.com/gitlab-org/cli) for GitLab, signed in |
| **Push to main** | Commits and pushes directly to the repo's default branch | `git` with push access |

To set up authentication, do one of the following:

- Run `gh auth login` and/or `glab auth login` once.
- Export `GH_TOKEN` / `GITLAB_TOKEN` in your shell (or set them in `.env`).

Pushing over SSH uses your normal `~/.ssh` keys and ssh-agent. See [Credentials](#credentials) for everything OMP UI picks up from your machine.

To change branches, tap the branch name in the board header, then the branch next to a folder. The list shows local branches and `origin` branches you haven't checked out yet. Uncommitted changes come along unless they would be overwritten. Switching is blocked while an agent on the board is running or queued.

## Credentials

OMP UI never asks for your AI or Git logins. It uses what this machine already has.

- **Local (`omp-ui up` / `start`):** the server runs as you, with your full environment. Agents and git use your omp and Claude sign-ins, `~/.gitconfig`, saved Git credentials, `~/.ssh` keys and ssh-agent, the `gh` / `glab` logins, and any API keys or proxies in your environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`, `HTTPS_PROXY`, …). Values in `.env` only override; keep credentials out of it.
- **Docker:** `docker-compose.yml` shares the same things with the container:

  | From your computer | What it is |
  | --- | --- |
  | `~/.omp` | omp sign-ins and settings |
  | `~/.claude`, `~/.claude.json` | Claude Code / Anthropic sign-in |
  | `~/.gitconfig`, `~/.config/git`, `~/.git-credentials` (read-only) | Git identity, credential helpers, saved HTTPS logins |
  | `~/.ssh` (read-only), `$SSH_AUTH_SOCK` | SSH keys and your ssh-agent |
  | `~/.config/gh`, `~/.config/glab-cli` | GitHub CLI and GitLab CLI sign-ins |
  | `~/.aws` (read-only) | AWS profiles (Bedrock) |
  | Environment variables | `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITLAB_HOST`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `AWS_*`, `HTTP(S)_PROXY`, … (full list in `docker-compose.yml`) |

  Docker turns a missing path into an empty root-owned folder. `omp-ui docker up` creates the missing ones first; before a plain `docker compose up`, run the commands listed in `docker-compose.yml`. Delete any line there you do not want to share. On Docker Desktop for macOS, start with `SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock` to share the ssh-agent.
- OMP UI's own secrets (`ADMIN_PASSWORD`, `AUTH_SECRET`, `DATABASE_URL`, `POSTGRES_PASSWORD`, `OMP_UI_*`, …) are removed from the environment of agents and git commands.
- `omp-ui doctor` lists what it found (names only, never values).

## CLI

Run `./omp-ui <command>`. Add `--help` to any command for details.

| Command | What it does |
| --- | --- |
| `up` | Set everything up and start it. This is the only command you need. Add `--public` for an internet link and `--port 8080` to change the port |
| `status` | Check whether it is running and show its links |
| `stop` / `start` / `restart` | Stop or start the server |
| `logs -f` | Follow the server log |
| `open` | Open OMP UI in your browser |
| `passwd` | Change the admin password |
| `public` | Get a public `https://` link (cloudflared, or ngrok) · `public stop` |
| `doctor` | Check that Node, omp, git, gh/glab, the port and the database are OK, and list the credentials found |
| `init` | Re-run setup (`--force` overwrites `.env`) |
| `pm2 start` / `stop` / `restart` / `logs` / `status` / `save` / `startup` / `delete` | Run it under pm2. `omp-ui up --pm2` sets everything up first |
| `docker up` / `down` / `logs` / `ps` | Run it in Docker (`--postgres` or `--mongo` adds a database) |
| `deploy --host me@server` | Copy it to a server and start it there with Docker |
| `dev` / `build` / `version` | For development |

Settings live in `.env`, which `init` creates with permissions 600. Logs and runtime files go in `./data`.

## Databases

| | `DATABASE_URL` | |
| --- | --- | --- |
| **SQLite** (default) | `sqlite:./data/omp-ui.db` | No setup needed |
| **PostgreSQL** | `postgres://user:pass@host:5432/omp_ui` | For an existing Postgres server |
| **MongoDB** | `mongodb://host:27017/omp_ui` or `mongodb+srv://…` | For MongoDB or Atlas |

To choose a database, either:

- Run `omp-ui init --db postgres --db-url postgres://…`.
- Or edit `DATABASE_URL` in `.env` and run `omp-ui restart`.

In Docker, `omp-ui docker up --postgres` or `--mongo` runs a bundled database for you. Data is not migrated when you switch databases.

## Run with PM2

```sh
npm i -g pm2                      # optional; without it, `npx -y pm2` is used
pm2 start ecosystem.config.cjs    # or: omp-ui up --pm2
pm2 save && pm2 startup           # start again after a reboot
```

This works on a fresh clone. The first run sets everything up and builds the app, which takes a few minutes. If you didn't set `ADMIN_PASSWORD`, the generated password is printed to `data/pm2-out.log` (search for `OMP UI ADMIN PASSWORD`). `omp-ui up --pm2` also shows it in your terminal.

- Follow the logs with `omp-ui pm2 logs`.
- While pm2 runs it, use `omp-ui pm2 stop` / `restart`. Plain `omp-ui stop` refuses so it doesn't fight pm2.
- `omp-ui pm2 restart` rebuilds when the sources changed.

## Docker

- `docker compose up -d` builds the image (Node 24 with omp, git, gh and glab) and runs it as an unprivileged user.
- The container uses these folders from your computer:

  | On your computer | In the container | What it is |
  | --- | --- | --- |
  | `./data` | `/data` | Database and logs |
  | `~/.omp` | `/home/omp/.omp` | omp sign-in |
  | `WORKSPACE_DIR` | `/workspace` | Your projects |
  | Your sign-ins and keys | under `/home/omp` | See [Credentials](#credentials) |

  The `WORKSPACE_DIR` default is `./workspace`. In the app, project folders are under `/workspace/…`.
- If omp is not signed in on your computer yet, run `omp` there, or `docker compose exec -u omp omp-ui omp`.
- `omp-ui docker up --postgres` (or `--mongo`) saves the choice to `.env`, so plain `docker compose up -d` keeps using it.
- `omp-ui deploy --host me@server` copies the project, including `.env`, to `~/omp-ui` on the server and runs `docker compose up -d --build` there.
- To pin versions: `docker compose build --build-arg OMP_VERSION=v18.19.0 --build-arg GLAB_VERSION=v1.130.0`.

## Use it from anywhere

- **Quick link:** `omp-ui public` prints an `https://….trycloudflare.com` link. The link changes on each start. The CLI refuses to open the link if no admin password is set. With Docker, use `docker compose --profile public up -d`, then `docker compose logs tunnel`.
- **Your own domain:** put a TLS reverse proxy in front of `127.0.0.1:3000` and set `VINEXT_TRUST_PROXY=1` in `.env`. Turn off response buffering for live updates, e.g. `proxy_buffering off;` in nginx. A Caddy example: `omp.example.com { reverse_proxy 127.0.0.1:3000 }`.
- **Phone:** open the link, then tap **Share → Add to Home Screen**.
- **Your own app:** a client only needs the server URL and the admin password. See [`docs/API.md`](docs/API.md).

## Configuration

`.env` is created for you. Every variable is described in [`.env.example`](.env.example).

| Variable | Default | |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens. `HOST=127.0.0.1` keeps it to this computer |
| `ADMIN_PASSWORD` | – | Applied at every start. Change it with `omp-ui passwd` |
| `AUTH_SECRET` | generated | Signs login tokens |
| `DATA_DIR` | `./data` | Database, logs, pid files |
| `DATABASE_URL` | `sqlite:${DATA_DIR}/omp-ui.db` | `sqlite:` · `postgres://` · `mongodb://` (see [Databases](#databases)) |
| `MONGODB_DB` | `omp_ui` | MongoDB database name if the URL has none |
| `WORKSPACE_DIR` | `~/omp-workspace` (Docker: `/workspace`) | The folder picker starts here, and cloned repositories go here |
| `OMP_PATH` | `omp` | omp executable |
| `MAX_AGENTS` | `2` | Agents running at once |
| `OMP_EXTRA_ARGS` | – | Extra omp flags, e.g. `--thinking=high` |
| `GH_TOKEN` / `GITLAB_TOKEN` | – | Git hosting tokens (instead of `gh` / `glab` login). Usually exported in your shell; see [Credentials](#credentials) |
| `VINEXT_TRUST_PROXY` | – | `1` behind a reverse proxy |

## Security

- **Set a strong admin password before you make OMP UI public.** It is the only thing protecting a tool that runs commands on your machine.
- Agents run in **`yolo`** approval mode by default: they run commands and edit files without asking. Only point projects at folders you are happy for an agent to change. Use Docker if you want isolation. You can change the mode in **Settings**.
- Changing the password signs out every session. Keep `.env` private.
- Use HTTPS outside your home network: either the `public` link or a reverse proxy.

## Development

```sh
pnpm install && ./omp-ui dev        # live reload, loads .env
pnpm typecheck
```

Built with [vinext](https://vinext.dev) (Next.js App Router on Vite), React, Tailwind v4, shadcn/ui and dnd-kit.
