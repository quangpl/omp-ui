# OMP UI

A self-hosted kanban board for [omp](https://omp.sh/docs) coding agents. Write a card, press **Start**, and an agent does the work. It runs on your computer or server and works well on your phone.

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
2. **Add a card and press *Start*.** Write the card in your own words, as long as you like (pasted logs, specs, links): an agent turns it into a clear title and brief. Then an omp agent starts working on it in your project folders, and the card moves to **In progress** by itself. You can watch it work live.
3. **Comment to give feedback.** The agent picks up your comments, marks them resolved, and moves the card to **Done** when it finishes. Comment on a Done card and the agent reopens it and continues where it left off.

Then ship the result with one tap: **Create PR/MR** or **Push to main**.

**Quick actions.** Cards move between columns by themselves as their agent works; you can't drag them to another column or pick a status (dragging only reorders cards within a column). The only manual controls are the quick actions: **Start**, **Resume** or **Retry** (run the agent), **Stop** (stop it; the card stays where it is) and **Revert to To do** (stop the agent and move the card back to To do). A Done card that hasn't been pushed yet also shows a **Push to main** icon (when the project is a git repo with a remote); once pushed, its title is struck through and the icon goes away. Hover a card, right-click it, open it, or focus it and press <kbd>R</kbd> (Start/Resume/Retry), <kbd>S</kbd> (Stop), <kbd>Z</kbd> (Revert) or <kbd>P</kbd> (Push to main). On a phone, the card's main button is its first quick action and its **⋯** menu has the rest. A failed card keeps its **Retry** button pinned.

**Acting on several cards.** Select cards with <kbd>X</kbd> or <kbd>⌘</kbd>/<kbd>Ctrl</kbd>/<kbd>Shift</kbd>+click (see [Keyboard shortcuts](#keyboard-shortcuts)). A floating bar shows how many are selected and how many each action applies to, with bulk **Start**, **Stop**, **Revert** and **Push**; <kbd>R</kbd>/<kbd>S</kbd>/<kbd>Z</kbd>/<kbd>P</kbd> act on the selection too. The **To do** column header has **Start all** and the **In progress** header has **Stop all**.

**Advisor.** Agents don't stop to ask you technical questions. When a card's agent (or one of its subagents) is unsure which way to go, it calls the `ask_advisor` tool: an advisor agent (omp's `advisor` model role, else `slow`, else the default model thinking hard) reads the card and the project and picks the best option. When a run still ends with questions, the advisor answers the ones it can — posting its answers on the card and, when an answer needs more work, sending the agent back to it once — and only questions that need your own judgment (personal preference or taste, private information, business/legal/money calls, destructive actions) reach you.

**Agent questions.** When an agent finishes with a question in its summary ("Should the banner auto-dismiss?"), the card grows an amber **The agent has a question** strip. Click it to send the card back to **To do** and open it on the question, type your answer, and the agent continues with it — or dismiss the question. Answering from the open card works from any column.

**Shortcuts and menus.** Press <kbd>N</kbd> on any page to add a card (<kbd>Shift</kbd>+<kbd>N</kbd> always starts its agent); outside a board, the form asks which project. <kbd>⌘K</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> (or <kbd>/</kbd>) opens the command palette: search cards, jump to a project or page, or run an action. Right-click a card (or focus it and press <kbd>.</kbd>) to open it, use its quick actions, duplicate it, copy its link, or delete it. Right-click the board background or a project on the Projects page to add a card there. Every key is listed under [Keyboard shortcuts](#keyboard-shortcuts); press <kbd>?</kbd> anywhere for the cheat sheet.

<details>
<summary>The details</summary>

- The columns are **To do**, **In progress** and **Done**.
- On a project with **Auto-run** on (the default), a new card skips To do: it lands in In progress and its agent starts. Turn off **Start agent now** in the form to park it in To do instead. Duplicates always go to To do.
- The **card writer**: a read-only omp agent reads your text and the project and writes the title and a Markdown brief (goal, context with the real files involved, requirements, acceptance criteria, notes). It keeps every concrete detail (names, paths, errors, code), turns on parallel subagents for large work, adds **Run after** links to open cards your text says it builds on, and points the agent to installed OMP skills that fit. **Create card** creates it right away; **Review first** lets you edit the title, brief, parallel subagents and Run after before creating. If the agent fails or you stop it, your text is used as typed (first line → title). Short requests use the `smol` model role (fast); long ones (150+ words or 5+ list items) use the default model. To keep it quick, it is told to write the card once it has made 8 lookups (16 for long requests), so a draft usually takes well under a minute; writing "orchestrate" in your text always turns on parallel subagents. Text of 2,000+ characters is also saved word for word on the card as `brief.md`. In a column's **Add a card** box, one short line (up to 100 characters) is used as the title as typed; longer text goes through the card writer.
- Each card's agent runs `omp --mode rpc --cwd <primary folder>`, plus `--add-dir <folder>` for every extra folder.
- Helper agents (card writer, advisor, queue planner, change summaries) run on a pool of warm `omp --mode rpc --no-session` workers: started on first use, reused between calls, closed after 5 idle minutes, at most half the logical cores (2–8). Up to half the logical cores (4–16) cards can be written at once.
- An agent's prompt is the card's title and description plus any unresolved comments.
- For a large card (4+ list items or comments, 300+ words, or asks like "across the codebase", "every page", "in parallel"), the prompt also includes omp's `orchestrate` keyword, so omp splits the work across parallel subagents.
- **Model per card.** A project with a **Model** set always uses it. Otherwise, with **Auto-select model per card** on (Settings, the default), each run reads the card (or, when resuming, the new comments) and picks one of your omp model roles (`omp config get modelRoles`, read in the project folder): `smol` for small mechanical edits (typos, renames, docs, version bumps) to go fast, `slow` for debugging, concurrency, performance, security, migrations and architecture to get the best answer, `designer` for UI and styling work, and the **Default model** for everything else. When a role is not configured, the default model runs with `--thinking low` (small edits) or `--thinking high` (hard problems). The **Agent log** shows the pick and why.
- The card's **Agent log** shows how a run works: counts of tool calls, subagents, messages and errors; an **Agents** section with one card per subagent (live status, current tool, tokens and cost; expand for its assignment, recent tool calls, output, and final report or error), sorted so working and failed agents come first; and a timeline where long runs of tool calls fold into one expandable line.
- A comment on a running card is sent straight into the live session.
- When a run succeeds, the agent's final message is posted as a comment, the feedback it handled is resolved, and the card moves to Done.
- If a run fails, the card stays in In progress with the error and is retried automatically in the same omp session (after 15 s, 30 s, 1 min, 2 min, 4 min; the card shows **Retrying**). After 5 retries in a row it stays failed: comment, or press **Retry**, to try again. Change or turn this off in **Settings → Retry failed runs automatically**.
- **Stop** leaves the card where it is (press **Resume** to continue the same session); **Revert to To do** stops the agent and parks the card in To do.
- Up to `MAX_AGENTS` agents run at the same time. The default, `auto`, sets the limit from the machine: the smaller of the logical cores, the running agents plus what free memory allows at about 600 MB per agent (after keeping 10% of RAM free, at most 2 GB), and 32; it is checked again every 30 s. A number (1–16) is a fixed cap. Switch between Auto and Manual in **Settings**, or run `omp-ui init --max-agents <n|auto>`. The others wait in a queue; the queue button in the header shows it, and you can move a card up or make it run next.
- **Smart queue.** When you add several cards to a project, a read-only planner agent orders its queued cards (prerequisites and quick unblockers first) and adds **Run after** links between cards that build on each other, so independent cards run in parallel and the rest wait. New cards are held for about 1.5 s so cards added together are planned at once; if the planner fails, they run in the order you added them. Turn it off in **Settings → Smart queue**.
- If the server restarts, cards that were waiting in the queue go back in it and run, and cards whose agent was working or that had failed resume their omp session automatically (this uses one of the card's retries, so a card that keeps taking the server down stops after 5). With automatic retries off, an interrupted card shows **Interrupted by server restart** and **Resume** continues it.
- **Self-healing server.** `omp-ui start`/`up`, pm2 and Docker run the server under `bin/supervisor.mjs`: it restarts the server when it crashes (backing off up to 30 s) and force-restarts it when `/api/v1/health` fails 3 checks in a row (15 s apart; tune with `OMP_UI_HEALTH_*`, see `.env.example`).

</details>

### Agents working together

- **Dedicated workspaces.** Turn on **Dedicated workspace per card** in a project's settings and each card's agent works in its own git worktree (in `DATA_DIR/workspaces`, on branch `omp/<card>`), so several agents can change the same repo at once. **Create PR/MR** and **Push to main** then ship from that card's worktree. Deleting the card (or **Remove workspace**) removes the worktree and its local branch.
- **Run after.** In a card, pick the cards it should wait for. Its agent stays queued until all of them are Done.
- **Files.** Upload files to a card for its agent to read; the agent saves reports, exports and screenshots there for you. **Shared files** in the board menu are shared with every card's agent on the project.
- **Browser control.** In **Settings → Browser control**, choose whether agents can use a browser: off, headless (default), a visible window on the server, or your own Chrome through `omp browser-relay`. Screenshots land in the card's files.
- **Agent-to-agent.** Every agent can list and read the project's cards, hand a separate piece of work to a new card (its own agent starts on it), send a message to another card's agent, and wait for cards to finish. A waiting agent lends its slot to the queue. Cards created by an agent show a bot icon and link back; messages from another agent are marked as such in the card's activity.
- **Visualize.** The **Visualize** tab shows your agents as a crew of robot workers, live. **The floor** has one desk per agent slot: each running card's worker (its own name and colour) shows what it is doing right now (running a command, editing, searching, briefing helpers…), how long it has been on the run, and its subagents as little helpers. Waiting cards stand in **The line** (a lock means they wait for other cards), failed or stalled ones are under **Need a hand**, and shipped cards go on the **Trophy wall**. Every Done card is worth 100 XP toward the crew's level, and badges unlock as you go.

### Around the app

- **Navigation.** A left sidebar holds the pages, your projects and utilities in its footer; collapse it to an icon rail with <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>B</kbd>. On phones, a menu button opens it as a sheet and tabs run along the bottom.
- **Home.** The Projects page is a dashboard: **Needs you** (cards waiting on you: a question, a failure, a scheduled retry, unanswered feedback, a stalled card, or Done but not pushed), **Live agents**, your projects with git status and success rate, run stats for the last 24 hours and 7 days with a sparkline, an activity feed, a getting-started checklist, and quick actions with go-to key hints.
- **Changes tab.** A card's **Changes** tab shows its code changes per repo against the base branch: uncommitted changes plus commits ahead. On top, an agent writes a one- or two-sentence summary, cached by the diff's hash in `DATA_DIR/runtime/diff-summaries/`; when it can't, a plain line with the changed file count is shown instead.
- **Attachments.** Card and shared files open in a viewer: images (zoom and pan), video, audio, PDF, and text, JSON or logs up to 2 MB; other files download. <kbd>⌘</kbd>/<kbd>Ctrl</kbd>-click opens a file in a new tab. `.mp4`, `.webm`, `.mov`, `.mp3`, `.wav` and `.ogg` files are served inline.
- **Run reports.** Agents end their summary with a `## Report` section: `Outcome:`, `Tests:`, `Changes:` and `Model:` lines, plus images linked as `/api/v1/tasks/<id>/files/<path>`. The card's activity shows it as a report card with the outcome, duration, model, changes, a test summary bar and a screenshot gallery; each screenshot's **Feedback** button quotes `> re: <path>` into the comment box.
- **Containers.** The **Containers** page runs Docker for your projects. Its sidebar entry shows how many containers are running; click the count for a list with **Logs**, **Restart** and **Stop**. One launcher searches templates, local images and Docker Hub (Quay too, when turned on), and takes a pasted image reference from any registry (`ghcr.io`, `quay.io`, `registry.k8s.io`, `public.ecr.aws`, …); <kbd>Enter</kbd> runs the image with free host ports mapped automatically. Compose stacks start with one click (including `mysql-adminer`, `elastic-kibana`, `n8n-postgres` and `minio-console`), or from pasted YAML or a URL. Links: `/containers?launch=1` opens the launcher, `/containers?logs=<id>&name=<name>` a container's logs, `/containers?logs=compose:<project>` a stack's logs.
- **OMP settings.** **Settings → OMP** edits omp's own `config.yml` (in the agent folder `omp config path` reports), with a form (model roles, thinking level, approval mode, steering and interrupt modes, retry, compaction, advisor, tools) or as raw YAML. Each save is checked with the omp CLI on a temporary copy, the previous file is kept as `config.yml.bak`, and the file is replaced atomically; saving raw YAML over a file that changed meanwhile is refused. OMP UI's own approval mode, project or default model, and **Auto-select model per card** override the matching omp settings for its runs.

## Keyboard shortcuts

Press <kbd>?</kbd> anywhere for the cheat sheet; type to filter it. <kbd>⌘</kbd> is <kbd>Ctrl</kbd> on Windows and Linux.

| Where | Keys | Action |
| --- | --- | --- |
| Everywhere | <kbd>⌘K</kbd> or <kbd>/</kbd> | Command palette |
| | <kbd>N</kbd> or <kbd>C</kbd> | New card |
| | <kbd>⇧N</kbd> or <kbd>⇧C</kbd> | New card, start its agent now |
| | <kbd>?</kbd> | Keyboard shortcuts (filterable) |
| | <kbd>⌘B</kbd> | Collapse or expand the sidebar |
| Go to | <kbd>G</kbd> then <kbd>P</kbd> or <kbd>H</kbd> | Projects home |
| | <kbd>G</kbd> then <kbd>V</kbd> / <kbd>D</kbd> / <kbd>M</kbd> / <kbd>T</kbd> / <kbd>S</kbd> | Visualize / Containers / Memory / Stats / Settings |
| Board | <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> or <kbd>K</kbd><kbd>J</kbd><kbd>H</kbd><kbd>L</kbd> | Previous / next card, column left / right |
| | <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> | Jump to To do / In progress / Done |
| | <kbd>Home</kbd> / <kbd>End</kbd> | First / last card of the column |
| | <kbd>↵</kbd>, <kbd>O</kbd> or <kbd>E</kbd> | Open card |
| | <kbd>D</kbd> | Duplicate card |
| | <kbd>⌫</kbd> or <kbd>Delete</kbd> | Delete card (asks first) |
| | <kbd>Y</kbd> | Copy card link |
| | <kbd>.</kbd> or <kbd>⇧F10</kbd> | Card actions menu |
| | <kbd>Space</kbd> | Pick up / drop card (arrows move it) |
| Selection & quick actions | <kbd>X</kbd> | Toggle selection of the focused card (or <kbd>⌘</kbd>/<kbd>⇧</kbd>+click) |
| | <kbd>⇧↑</kbd> / <kbd>⇧↓</kbd> or <kbd>⇧K</kbd> / <kbd>⇧J</kbd> | Extend selection up / down |
| | <kbd>⌘A</kbd> | Select all in the column (whole board if no card is focused) |
| | <kbd>Esc</kbd> | Clear selection, then unfocus |
| | <kbd>R</kbd> / <kbd>S</kbd> / <kbd>Z</kbd> / <kbd>P</kbd> | Start, resume or retry / Stop / Revert to To do / Push to main, on the selected cards, else the focused card |
| Card panel | <kbd>J</kbd> / <kbd>K</kbd> | Next / previous card |
| | <kbd>R</kbd> / <kbd>S</kbd> / <kbd>Z</kbd> / <kbd>P</kbd> | Start, resume or retry / Stop / Revert to To do / Push to main |
| | <kbd>]</kbd> / <kbd>[</kbd> | Next / previous tab |
| | <kbd>⌘↵</kbd> | Send feedback / save text |
| | <kbd>Esc</kbd> | Close panel (or leave the field) |
| | <kbd>Alt+↓</kbd> / <kbd>Alt+↑</kbd> | Next / previous changed file (Changes tab) |
| Home | <kbd>J</kbd> / <kbd>K</kbd> | Next / previous Needs-you row |
| | <kbd>↵</kbd> | Open the focused card |
| | <kbd>R</kbd> / <kbd>S</kbd> / <kbd>P</kbd> | Retry or resume / Stop / Push to main, on the focused card |
| Containers | <kbd>L</kbd> | Focus the launcher |
| | <kbd>↑</kbd> / <kbd>↓</kbd> | Select a result (in the launcher) |
| | <kbd>↵</kbd> / <kbd>⇧↵</kbd> | Run with defaults / customize first |
| | <kbd>Esc</kbd> | Clear the launcher |
| Attachment viewer | <kbd>←</kbd> / <kbd>→</kbd> | Previous / next attachment |
| | <kbd>Z</kbd> | Toggle fit / 100% zoom |
| | <kbd>Esc</kbd> | Close |
| Command palette | <kbd>↓</kbd>, <kbd>Ctrl+N</kbd> or <kbd>Tab</kbd> | Next result |
| | <kbd>↑</kbd>, <kbd>Ctrl+P</kbd> or <kbd>⇧Tab</kbd> | Previous result |
| | <kbd>Home</kbd> / <kbd>End</kbd>, <kbd>PgUp</kbd> / <kbd>PgDn</kbd> | First / last result, page through results |
| | <kbd>↵</kbd> | Run the highlighted entry |
| | <kbd>⌘↵</kbd> | Open a card in a new tab |
| | <kbd>Esc</kbd> | Close |

The command palette lists the actions of the focused or open card first, then **Recent**. Search is fuzzy; typing an action and a card name (`stop login`) offers that action on matching cards, and the **Board** group has **Stop all running** and **Start all To do**.

## Persistent memory (agentmemory)

OMP UI works with [agentmemory](https://github.com/rohitg00/agentmemory), so card agents remember what earlier runs learned about a project.

1. Install it once on the server host: `npx -y @agentmemory/agentmemory@latest` (or `npm i -g @agentmemory/agentmemory`).
2. Connect omp to it: **Settings → Memory → Connect OMP**, or run `agentmemory connect omp --with-mcp`.

- `omp-ui up` and the supervisor start the memory server when it is installed (an enabled `systemctl --user` unit `agentmemory` is used instead when present), and the supervisor checks it again every 5 minutes (`OMP_UI_MEMORY_CHECK_MS`). **Settings → Memory** shows its status and can start it.
- Its REST API listens on `127.0.0.1:3111` and its live viewer on `127.0.0.1:3113`, on the server host's loopback only.
- Without API keys, recall uses BM25 keyword search. For semantic recall computed on the machine, set `EMBEDDING_PROVIDER=local` in `~/.agentmemory/.env`.
- Card runs store and recall memories under their board's project (the board folder's git root name, worktrees included, or `AGENTMEMORY_PROJECT_NAME`), shared with your own omp sessions in that folder. Each run's session is titled `<card title> (card <id>)`. Helper agents (card writer, advisor, queue planner, change summaries) don't capture or recall anything.
- The **Memory** page (`/memory`, <kbd>G</kbd> then <kbd>M</kbd>, or **Memory** in the sidebar) browses and searches memories and sessions and shows store stats.
- `AGENTMEMORY_ENABLED` (`auto`, the default, starts it when installed; `true` also warns when it is missing; `false` never starts it), `AGENTMEMORY_URL`, `AGENTMEMORY_VIEWER_URL`, `AGENTMEMORY_PROJECT_NAME` and `OMP_UI_MEMORY_CHECK_MS` are in [Configuration](#configuration); Docker setup is under [Docker](#docker).

## Shipping changes

A card has two buttons. Each one acts on every project folder that has changes. Neither asks for confirmation. Agents also push to main or open a PR/MR themselves, without asking, when the card or your feedback explicitly asks for it.

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
| `stop` / `start` / `restart` | Stop or start the server. `restart` rebuilds first when the sources changed (`--rebuild` always rebuilds), so committed changes go live with one command. If the build fails, the previous build is put back and started, and the command exits with an error |
| `logs -f` | Follow the server log |
| `open` | Open OMP UI in your browser |
| `passwd` | Change the admin password |
| `public` | Get a public `https://` link (cloudflared, or ngrok) · `public stop` |
| `doctor` | Check that Node, omp, git, gh/glab, the port and the database are OK, and list the credentials found |
| `init` | Re-run setup (`--force` overwrites `.env`, `--max-agents <n\|auto>` sets the agent limit) |
| `pm2 start` / `stop` / `restart` / `logs` / `status` / `save` / `startup` / `delete` | Run it under pm2. `omp-ui up --pm2` sets everything up first |
| `docker up` / `down` / `logs` / `ps` | Run it in Docker (`--postgres` or `--mongo` adds a database) |
| `deploy --host me@server` | Copy it to a server and start it there with Docker |
| `dev` / `build` / `version` | For development |

Settings live in `.env`, which `init` creates with permissions 600. Logs and runtime files go in `./data`.

**Restart from the browser.** The **Restart server** button in the header (↻; on phones, in the account menu) does `omp-ui restart --rebuild` for you: it stops the server, builds the current sources and starts it again, then reloads the page on the new build. The app is down while it builds (about a minute), and running agents are interrupted, then resume by themselves (with automatic retries on). If the build fails, the previous build keeps running and the dialog shows the build output (also in `data/restart.log`). It works for a server started with `omp-ui up`/`start` or under pm2; Docker, `omp-ui dev` and `omp-ui start -f` show why they can't restart from the browser.

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
- `omp-ui pm2 restart` rebuilds when the sources changed; `omp-ui pm2 restart --rebuild` stops the app, always rebuilds, then starts it.

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
- **Memory (opt-in):** set `AGENTMEMORY_VERSION=latest` in `.env` (the `AGENTMEMORY_VERSION` build arg) and run `docker compose build` to include agentmemory in the image; its state lives in the `agentmemory` volume. On start, the container runs `agentmemory connect omp`, which writes into the `~/.omp` config mounted from your computer; set `AGENTMEMORY_CONNECT_OMP=false` to avoid that.

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
| `MAX_AGENTS` | `auto` | Agents running at once: `auto` (from CPU cores and free memory) or a fixed number 1–16 |
| `OMP_EXTRA_ARGS` | – | Extra omp flags, e.g. `--thinking=high` |
| `AGENTMEMORY_ENABLED` | `auto` | Start the agentmemory server: `auto` (when installed), `true` (also warn when missing) or `false`. See [Persistent memory](#persistent-memory-agentmemory) |
| `AGENTMEMORY_URL` / `AGENTMEMORY_VIEWER_URL` | `http://127.0.0.1:3111` / `http://127.0.0.1:3113` | agentmemory REST API and viewer |
| `AGENTMEMORY_PROJECT_NAME` | – | One memory project for every card, instead of the board folder's git root name |
| `OMP_UI_MEMORY_CHECK_MS` | `300000` | How often the supervisor re-checks the memory server (ms; `0` = only at boot) |
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
