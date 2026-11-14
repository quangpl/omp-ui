# AgentMan

Self-hosted kanban board for [omp](https://omp.sh/docs) coding agents. Write a card; an agent does the work. Runs on your machine or server and works on your phone.

## Start in one command

```sh
./omp-ui up
```

`up` asks for an admin password, then installs, builds and starts AgentMan. It prints a local link and one for your phone on the same Wi-Fi.

Requires **Node.js 24+** and **omp**, installed and signed in:

```sh
curl -fsSL https://omp.sh/install | sh   # install omp
omp                                      # run once, sign in to a provider
```

**Docker** instead (the image includes omp and shares your sign-ins — see [Credentials](#credentials)):

```sh
./omp-ui docker up                       # or: docker compose up -d — then open http://localhost:3000
```

## How it works

1. **Create a project.** Pick a folder or clone a Git repo. A project can span several folders, e.g. separate frontend and backend repos.
2. **Add a task.** Describe the task in your own words, any length (logs, specs, links). It lands in **In progress** immediately; a background agent turns it into a title and brief, then an omp agent works on it in your project folders. Watch it live.
3. **Comment to give feedback.** The agent picks up comments, marks them resolved, and moves the card to **Done** when finished. Commenting on a Done card reopens it; the agent continues where it left off.

Ship the result with one tap: **Create PR/MR** or **Push to main**.

**Quick actions.** Cards move between columns on their own as the agent works; you can't drag them across columns or set a status (dragging only reorders within a column). Manual controls: **Start**, **Resume** or **Retry** (run the agent), **Stop** (the card stays put) and **Revert to To do** (stop the agent, move the card back to To do). An unpushed Done card also shows a **Push to main** icon (git repo with a remote only); once pushed, its title is struck through and the icon disappears. Hover, right-click or open a card, or focus it and press <kbd>R</kbd> (Start/Resume/Retry), <kbd>S</kbd> (Stop), <kbd>Z</kbd> (Revert) or <kbd>P</kbd> (Push to main). On phones, the card's main button is its first quick action; the rest are in its **⋯** menu. Failed cards keep **Retry** pinned.

**Bulk actions.** Select cards with <kbd>X</kbd> or <kbd>⌘</kbd>/<kbd>Ctrl</kbd>/<kbd>Shift</kbd>+click (see [Keyboard shortcuts](#keyboard-shortcuts)). A floating bar shows the selection count and how many cards each action applies to: **Start**, **Stop**, **Revert**, **Push**. <kbd>R</kbd>/<kbd>S</kbd>/<kbd>Z</kbd>/<kbd>P</kbd> also act on the selection. The **To do** header has **Start all**; **In progress** has **Stop all**.

**Advisor.** Agents don't stop to ask you technical questions. When a card's agent (or a subagent) is unsure, it calls the `ask_advisor` tool: an advisor agent (omp's `advisor` model role, else `slow`, else the default model at high thinking) reads the card and project and picks the best option. If a run still ends with questions, the advisor answers what it can — posting answers on the card and, when an answer needs more work, sending the agent back once. Only questions that need your judgment (preference or taste, private information, business/legal/money calls, destructive actions) reach you.

**Agent questions.** When an agent ends with a question in its summary ("Should the banner auto-dismiss?"), the card shows an amber **The agent has a question** strip. Click it to move the card back to **To do** and open the question; type your answer and the agent continues — or dismiss it. You can also answer from the open card in any column.

**Task progress.** Every card shows a progress ring before its title, on the board and in the card's status pill. When the agent keeps a todo list (omp's `todo` tool), the ring fills with its completed items and the card shows the count (e.g. `2/5`); the open card lists the items by phase under **Progress**. While the list has nothing left, each open feedback comment counts as one more pending item (e.g. `3/4`, "1 open feedback"), so a resumed or steered card stops looking finished until the agent adds items for it or the feedback is resolved. Without a todo list the ring follows the column: dashed in To do, half in In progress, full with a check in Done. The list stays on the card after the run ends.

**Shortcuts and menus.** <kbd>N</kbd> on any page adds a card; it lands in In progress and its agent starts while the card writer runs in the background. Outside a board, the form asks for the project. <kbd>⌘K</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> (or <kbd>/</kbd>) opens the command palette: search cards, jump to a project or page, run an action. Right-click a card (or focus it and press <kbd>.</kbd>) to open it, run quick actions, duplicate it, copy its link, or delete it. Right-click the board background or a project on the Projects page to add a card there. All keys: [Keyboard shortcuts](#keyboard-shortcuts); <kbd>?</kbd> anywhere opens the cheat sheet.

<details>
<summary>The details</summary>

- The columns are **To do**, **In progress** and **Done**.
- A new card lands in **In progress** and its agent starts immediately, regardless of the project's **Auto-run** setting. Duplicates always go to To do.
- **Card writer.** A read-only omp agent reads your text and the project, then writes the title and a Markdown brief (goal, context with the real files involved, requirements, acceptance criteria, notes). It keeps every concrete detail (names, paths, errors, code), enables parallel subagents for large work, adds **Run after** links to open cards your text builds on, and points the agent to matching installed OMP skills. It runs in the background: **Create task** closes the form immediately so you can add the next card. Meanwhile the card is titled from your text's first line, shows **Writing card** with the writer's progress, and its run waits until the brief is written. Title or description edits made meanwhile are kept. If the writer fails, the agent works from your text as typed and the card notes it; stopping the card stops its writer too. A short single line is used as the title as typed, skipping the writer. Short requests use the `smol` model role; long ones (150+ words or 5+ list items) use the default model. The writer is told to finish after 8 lookups (16 for long requests), so a draft usually takes well under a minute. "orchestrate" in your text always enables parallel subagents. Text of 2,000+ characters is also saved verbatim on the card as `brief.md`. In a column's **Add a task** box, one short line (up to 100 characters) becomes the title as typed; longer text goes through the writer.
- Each card's agent runs `omp --mode rpc --cwd <primary folder>`, plus `--add-dir <folder>` for every extra folder.
- Helper agents (card writer, advisor, queue planner, change summaries) share a pool of warm `omp --mode rpc --no-session` workers: started on first use, reused between calls, closed after 5 idle minutes, capped at half the logical cores (2–8). Up to half the logical cores (4–16) cards can be written concurrently.
- An agent's prompt is the card's title and description plus any unresolved comments.
- For large cards (4+ list items or comments, 300+ words, or phrases like "across the codebase", "every page", "in parallel"), the prompt includes omp's `orchestrate` keyword so omp splits the work across parallel subagents.
- **Model per card.** A project's **Model**, if set, always wins. Otherwise, with **Auto-select model per card** on (Settings, the default), each run reads the card (or, on resume, the new comments) and picks one of your omp model roles (`omp config get modelRoles`, read in the project folder): `smol` for small mechanical edits (typos, renames, docs, version bumps), `slow` for debugging, concurrency, performance, security, migrations and architecture, `designer` for UI and styling, and the **Default model** for everything else. If a role isn't configured, the default model runs with `--thinking low` (small edits) or `--thinking high` (hard problems). The **Agent log** shows the pick and the reason.
- The **Agent log** shows run internals: counts of tool calls, subagents, messages and errors; an **Agents** section with one card per subagent (live status, current tool, tokens, cost; expand for assignment, recent tool calls, output, and final report or error), sorted with working and failed agents first; and a **Steps** timeline: each step is what the agent thought or said, with the actions it took next listed by intent ("Running the tests") and icon. Tap an action for the exact command and, if it failed, its error; long steps fold after a few actions, and the run's closing message is highlighted as its **Summary**. **Raw** shows every event as recorded (with optional line wrapping); the choice is remembered.
- A comment on a running card goes straight into the live session, like typing into the omp CLI mid-run: omp's magic keywords (`orchestrate`, `ultrathink`, …) take effect, and a large comment (4+ list items, 300+ words, or phrases like "in parallel") gets `orchestrate` added. Messages from another card's agent have these keywords neutralized.
- On success, the agent's final message is posted as a comment, the feedback it handled is resolved, and the card moves to Done.
- On failure, the card stays in In progress with the error and retries automatically in the same omp session until it is Done or you press **Stop**. Quota and usage-limit errors (detected from the error message: quota, usage or rate limit, 429, …) wait 5, 10, 15, 30 min, then hourly, and the card shows **Waiting for quota**; other errors back off 15 s, 30 s, 1 min, 2 min … up to 10 min apart, and the card shows **Retrying**. Turn off **Keep retrying until done** to stop after 5 consecutive retries instead: the card then stays failed until you comment or press **Retry**. Configure in **Settings → Retry failed runs automatically**.
- **Stop** leaves the card where it is (press **Resume** to continue the same session); **Revert to To do** stops the agent and parks the card in To do.
- Up to `MAX_AGENTS` agents run concurrently. The default, `auto`, derives the limit from the machine: the minimum of the logical cores, the running agents plus what free memory allows at ~600 MB per agent (keeping 10% of RAM free, at most 2 GB), and 32; re-checked every 30 s. A number (1–16) sets a fixed cap. Switch between Auto and Manual in **Settings**, or run `omp-ui init --max-agents <n|auto>`. Other cards wait in a queue; the header's queue button shows it and lets you move a card up or run it next.
- **Smart queue.** When you add several cards to a project, a read-only planner agent orders its queued cards (prerequisites and quick unblockers first) and adds **Run after** links between dependent cards, so independent cards run in parallel and the rest wait. New cards are held ~1.5 s so cards added together are planned together; if the planner fails, they run in the order added. Disable in **Settings → Smart queue**.
- On server restart, queued cards go back in the queue, and cards whose agent was working or had failed resume their omp session automatically (this uses one of the card's retries, even with **Keep retrying until done** on, so a card that keeps crashing the server stops after 5). With automatic retries off, an interrupted card shows **Interrupted by server restart** and **Resume** continues it.
- **Self-healing server.** `omp-ui start`/`up`, systemd, pm2 and Docker run the server under `bin/supervisor.mjs`, which restarts it on crash (backing off up to 30 s) and force-restarts it after 3 consecutive failed `/api/v1/health` checks (15 s apart; tune with `OMP_UI_HEALTH_*`). See [Start on boot and self-healing](#start-on-boot-and-self-healing).

</details>

### Agents working together

- **Dedicated workspaces.** With **Dedicated workspace per card** on in a project's settings, each card's agent works in its own git worktree (`DATA_DIR/workspaces`, branch `omp/<card>`), so several agents can change the same repo at once. **Create PR/MR** and **Push to main** ship from that worktree. Deleting the card (or **Remove workspace**) removes the worktree and its local branch.
- **Run after.** Pick the cards a card should wait for; its agent stays queued until all of them are Done.
- **Files.** Upload files to a card for its agent to read; the agent saves reports, exports and screenshots there. **Shared files** (board menu) are available to every card's agent in the project.
- **Browser control.** **Settings → Browser control** sets agent browser access: off, headless (default), a visible window on the server, or your own Chrome via `omp browser-relay`. Screenshots land in the card's files.
- **Agent-to-agent.** Agents can list and read the project's cards, hand off separate work to a new card (which starts its own agent), message another card's agent, and wait for cards to finish. A waiting agent lends its slot to the queue. Agent-created cards show a bot icon and link back; messages from other agents are marked as such in the card's activity.
- **Visualize.** The **Visualize** tab is a live factory floor for your agents. The control room up top shows stations in use (of the agent limit), cards in line, cards that need a hand and cards shipped, a ticker of what each worker is doing right now (with the subagents it has at work, each by name and role), and the crew plate: crew level and rank, XP (100 per shipped card), progress to the next level and every badge, earned or locked. The **Factory floor** has one room per department, and each card has its own robot worker (stable name and colour) that stands in the room of what its agent is doing right now: **Design office** (thinking, planning, writing), **Code shop** (reading and editing files), **Build & test** (commands and tests), **Research lab** (web), **Archive** (memory), **Dispatch** (board tools, talking to other cards), **Advisor's office** and **Team room** (subagents). When the activity changes the worker walks to the next room; busy subagents step out of their agent as smaller robots and walk to their own room. Every worker wears its name and a role tag: card agents are **Lead**; subagents go by the name their lead gave them (`AuthScout`) and their role from the agent type (**Builder**, **Scout**, **Reviewer**, **Security**, …). Queued cards wait in **Receiving** in start order (a lock means blocked on other cards), failed or stalled cards go to the **Rework bay** and finished ones to the **Shipping dock**. Hover a worker for its card, current activity, time on the run, subagents and links to other cards; click it to open the card. **Worksites** lists every project with its shipped share, a strip of its cards by column and the workers on site. Everything updates live.
  Workers show how they feel, worked out from their run: **working**, **energized** (fresh and productive), **thinking** and **deep in thought** (thinking on a productive run), **stuck** (the same tool failing again and again, or errors with no progress), **stressed**, **running hot** (failing calls piling up), **overloaded** (many busy subagents or a fast tool rate), **tired** (many tool calls, a long run, or low mana) and **needs help** (errors in a row, model retries, or no sign of life for minutes; marked with a "!" badge, and the control room counts them). Each robot's look shows its role: the card's **Lead** agent and subagents as **Builder**, **Scout**, **Reviewer**, **Security**, **Sprinter**, **Medium**, **Planner**, **Designer** or **Helper**. The bar under a working robot is its **mana**: how much of its context window is left. The ticker adds the feeling in words and Mana, Tired, Load and Heat meters, and **Who's who** under the floor explains every role and mood. Animations are off with reduced motion.

### Orchestration guardrails

**Settings → Orchestration** holds opt-in controls for running agents. All are off by default; they are stored in the database with the other settings and apply without a restart.

- **Run time limit.** A run still working after N minutes (5–1440, default 120) is stopped and the card fails without an automatic retry. Checked every 10 s, so turning it on also covers runs already working.
- **Stall watchdog.** A run whose omp process sends nothing for N minutes (2–240, default 20) is stopped and fails like a crash, so automatic retries resume it. Agents waiting on another card (`board_wait_for_cards`) are exempt. A single tool that runs silently longer than the timeout (a long build) also trips it; raise the timeout for such projects.
- **Run budget.** Stops a run (no automatic retry) once its omp session plus its subagents report more than $N or N tokens (0 = no token cap), from omp's `get_session_stats`.
- **Loop detection.** An agent that repeats the same tool call with the same result 4 times, gets the same error from the same call 3 times, or alternates between two calls 3 times is first told to change approach; if it keeps looping, the run fails without a retry. Applies to runs started while it is on; turning it off stops enforcement right away.
- **Git checkpoints.** Before each run, every git folder the agent works in is snapshotted (tracked and untracked files, `.gitignore` respected) under `refs/agentman/checkpoints/<card>/…` without touching the working tree, index or branch; the newest 20 per card are kept. The card's **Checkpoints** panel restores one (only while the agent is not running): the current state is checkpointed first, so a restore can be undone.
- **Load guard.** While the 1-minute load average per core is above N % (default 150 %), queued cards stay queued and the queue shows why; running agents are not touched. Never trips on Windows, which reports no load average.
- **OpenTelemetry traces.** Each finished run is POSTed as one OTLP/HTTP JSON trace to your collector (e.g. `http://localhost:4318/v1/traces`): an `invoke_agent` root span with the card, model, status, cost and tokens, plus `execute_tool` and subagent child spans (GenAI semantic conventions). Extra headers (auth) come from `OTEL_EXPORTER_OTLP_HEADERS`; **Send test span** checks the endpoint.

### Around the app

- **Navigation.** The left sidebar holds pages, projects, and utilities in its footer; collapse it to an icon rail with <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>B</kbd>. On phones, a menu button opens it as a sheet and tabs run along the bottom.
- **Theme color.** **Settings → Appearance** picks the interface's primary color (buttons, links, active navigation, focus rings, chart accents) from 16 Tailwind-based presets: Jade (the default), Blue, Indigo, Violet, Purple, Pink, Rose, Red, Orange, Amber, Green, Emerald, Teal, Cyan, Sky and Slate. A pick recolors every page at once, in light and dark mode, and is saved with the other settings; pages are rendered in the saved color, so there is no flash of the default on load.
- **Home.** The Projects page is a dashboard: **Needs you** (cards waiting on you: a question, a failure, a scheduled retry, unanswered feedback, a stalled card, or Done but unpushed), **Live agents**, every project with git status and success rate (pinned ones first), 24-hour and 7-day run stats with a sparkline, an activity feed, a getting-started checklist, and quick actions with go-to key hints. Unpinned projects follow the pinned ones under an **Other projects** toggle, expanded by default, and the project filter searches both; the sidebar's **Your projects** lists only pinned ones. Pin or unpin a project from its ⋯ menu or right-click menu on the dashboard; right-click a sidebar project to unpin it.
- **Optimize.** The Stats page's **Optimize** section analyzes the server on demand: CPU, memory and disk usage, recommendations, top CPU and memory processes, and every agent-related process (orphaned agents from a crashed server, dev servers and browsers agents started). End a process (never the server itself; a running card's agent is stopped via its card), close idle helper agents to free memory, and clean storage: files and worktrees of deleted cards, worktrees of shipped cards, old run configs, drafts and change summaries, rotated logs, SQLite compaction and Docker prunes. Items marked **Review** may delete something you still want and are excluded from **Clean up safe items**; omp sessions and tool caches are reported only.
- **Scheduled cleanup.** On the Settings page, the AgentMan-data part of that cleanup (not Docker prunes) can run weekly or monthly, counting from when you turn it on, or right away with **Clean up now**. Pick what it removes (worktrees of shipped cards are opt-in); the last run's results and the next run time are shown there.
- **Changes tab.** Shows a card's code changes per repo against the base branch: uncommitted changes plus commits ahead. An agent writes a one- or two-sentence summary on top, cached by diff hash in `DATA_DIR/runtime/diff-summaries/`; if that fails, a plain changed-file count is shown instead.
- **Files tab.** A card's **Files** tab edits the project's files next to the agent chat: a tree of every project folder (`.gitignore`'d files hidden, like "@" mentions), **Open file…** (<kbd>⌘P</kbd>) to search them, and a code editor with syntax highlighting. <kbd>⌘S</kbd> or **Save** writes the file; a save over a file that changed on disk meanwhile is refused with a **Reload** option. Only existing text files up to 2 MB open; `.git` and paths outside the project folders are refused. Closing the card or opening another one with unsaved edits asks first. The chat beside it messages the card's agent; type `@` to mention a file, and picking one also opens it in the editor. Side by side on desktop, stacked on phones.
- **Files page.** **Files** in the sidebar (<kbd>G</kbd> then <kbd>F</kbd>) is the same editor outside a card: pick a project (all its folders) or **Folder…** for any folder on the server; the URL keeps the choice (`/files?project=<id>` or `/files?folder=<path>`) and the last one is reopened. For a project, the panel beside the editor starts a new card in it from your message (`@` mentions files, and picking one opens it); folders have no chat. Switching the project or folder with unsaved edits asks first. Hide it in **Settings → Menu** like the other optional pages.
- **File and folder actions.** In the Files tree (tab and page), right-click a file, a folder or the empty area for VSCode-style actions: **New File…** and **New Folder…** (typed inline; `a/b.ts` creates the folders on the way), **Rename…** (<kbd>F2</kbd>), **Delete** (asks first; permanent), **Duplicate**, **Cut** / **Copy** / **Paste** (<kbd>⌘X</kbd> / <kbd>⌘C</kbd> / <kbd>⌘V</kbd>; a copy onto an existing name becomes `name copy`), **Copy Path** and **Copy Relative Path**. The tree's header has **New File**, **New Folder**, **Refresh** and **Collapse All**. While something is cut or copied, a **Paste here** bar sits above the tree. On phones every row has a **…** button (or long-press it) that opens the actions as a bottom sheet with large rows; names are typed inline with ✓ / ✕ buttons, and the delete confirmation has full-width buttons. An open file follows a rename or move and closes when it is deleted. New empty folders show right away; `.git` and the project folders themselves can't be changed.
- **Attachments.** Card and shared files, file links in comments and agent output, and file links in a card's description (shown as **Linked files** chips under it) open in a viewer instead of downloading: images (zoom and pan), video and audio (seekable), PDF, Markdown (rendered, with a source toggle), CSV/TSV as a table, Jupyter notebooks, text, code, JSON and logs up to 2 MB (extension-less files such as `Dockerfile` are detected as text), Word (`.docx`), Excel (`.xlsx`, one tab per sheet), PowerPoint (`.pptx`) and EPUB (simplified text-and-structure previews), and archives (`.zip`, `.jar`, `.whl`, `.tar`, `.tar.gz`/`.tgz`) as a filterable contents list. Office, EPUB and archive previews are parsed in the browser, up to 50 MB. A missing file, a network error or a file too large to preview shows why, with **Try again** where it helps and always **Download**. <kbd>⌘</kbd>/<kbd>Ctrl</kbd>-click opens a file in a new tab. Images, video, audio, PDF and plain-text formats are served inline with HTTP range support.
- **Run reports.** Agents end their summary with a `## Report` section: `Outcome:`, `Tests:`, `Changes:` and `Model:` lines, plus images linked as `/api/v1/tasks/<id>/files/<path>`. The card's activity shows it as a report card with the outcome, duration, model, changes, a test summary bar and a screenshot gallery; each screenshot's **Feedback** button quotes `> re: <path>` into the comment box.
- **Containers.** The **Containers** page runs Docker for your projects. Its sidebar entry shows the running container count; click it for a list with **Logs**, **Restart** and **Stop**. One launcher searches templates, local images and Docker Hub (and Quay, when enabled), and accepts a pasted image reference from any registry (`ghcr.io`, `quay.io`, `registry.k8s.io`, `public.ecr.aws`, …); <kbd>Enter</kbd> runs the image with free host ports mapped automatically. Compose stacks start with one click (including `mysql-adminer`, `elastic-kibana`, `n8n-postgres` and `minio-console`), or from pasted YAML or a URL. Links: `/containers?launch=1` opens the launcher, `/containers?logs=<id>&name=<name>` a container's logs, `/containers?logs=compose:<project>` a stack's logs.
- **Terminal.** The **Terminal** tab is a shell on the server, as the server user (AgentMan's own secrets are stripped from its environment). Each command runs as its own block with streamed output, exit code and duration; `cd` carries over to the next command, <kbd>↑</kbd>/<kbd>↓</kbd> recall history, <kbd>Ctrl</kbd>+<kbd>C</kbd> stops the newest running command and <kbd>Ctrl</kbd>+<kbd>L</kbd> (or `clear`) clears finished blocks. Like a tmux session it keeps running when you leave: commands run detached with their output in `DATA_DIR/terminal/`, so they survive closing the page and even restarting AgentMan, and reopening the tab re-attaches with every block and its live output. Limits: 8 concurrent commands, 6 hours and 8 MB of output per command.
- **Logs.** The **Logs** tab shows one sub-tab per log type: **System** (server output, `DATA_DIR/omp-ui.log`), **Security** (logins, failed and blocked attempts, password and credential changes, unauthorized requests), **Access** (API requests and page views), **Agents** (runs of every card: starts, completions, failures), **Database** (connections, migrations, failed and slow queries), **Restarts** and **Tunnel**. Newest first, with search, severity and time-range filters, paging, refresh and auto-refresh, and export as JSON, NDJSON or text. Rotated `*.log.1` archives are included and can be picked per file. Security, access and database events are written as JSON lines to `DATA_DIR/{security,access,database}.log`, rotated past 5 MB; secrets and query strings are never logged.
- **OMP settings.** **Settings → OMP** edits omp's own `config.yml` (in the agent folder `omp config path` reports) via a form (model roles, thinking level, approval mode, steering and interrupt modes, retry, compaction, advisor, tools) or raw YAML. Each save is validated with the omp CLI on a temporary copy, the previous file is kept as `config.yml.bak`, and the file is replaced atomically; saving raw YAML over a file that changed meanwhile is refused. AgentMan's own approval mode, project or default model, and **Auto-select model per card** override the matching omp settings for its runs.
- **Chat control (Telegram, Discord).** **Settings → Chat integrations**: paste a bot token (from [@BotFather](https://t.me/BotFather), or a Discord application's Bot → Token) and click **Connect**; AgentMan checks the token and starts the bot (Telegram long polling, or a webhook when you give a public HTTPS URL; Discord over its gateway, so no public URL is needed). Without a Telegram bot yet, **Open @BotFather** opens BotFather straight in Telegram (with a Telegram Web link as fallback) and **Copy /newbot** copies the command to send there; pasting BotFather's whole reply works, the token is picked out of it. Then send `/login <admin password>` to the bot, preferably in a direct message; it answers "AgentMan connected". After that just write what you want in natural language ("show my boards", "create a card on omp-ui to fix the login page and start it", "what is running right now?", "tell card 1a2b to also add tests"): an AgentMan assistant (an omp helper agent with AgentMan tools, using the default model from **Settings → Agent**, omp's default when empty) lists boards and cards, reads, creates, runs, stops, moves and messages cards, picks the chat's default board, and replies; cards it starts stream their output into the chat. The only commands are `/login <password>`, `/logout` and `/stop [cardId]` (without an id it cancels the assistant's current request); card ids may be shortened to a unique prefix. Tokens are stored AES-256-GCM encrypted with the credentials key. Changing the admin password logs every chat out. On Discord, enable **Message Content Intent** to talk to the bot in server channels without mentioning it (slash commands work either way).

## Keyboard shortcuts

Press <kbd>?</kbd> anywhere for the cheat sheet; type to filter it. <kbd>⌘</kbd> is <kbd>Ctrl</kbd> on Windows and Linux.

| Where | Keys | Action |
| --- | --- | --- |
| Everywhere | <kbd>⌘K</kbd> or <kbd>/</kbd> | Command palette |
| | <kbd>N</kbd> or <kbd>C</kbd> | New task |
| | <kbd>?</kbd> | Keyboard shortcuts (filterable) |
| | <kbd>⌘B</kbd> | Collapse or expand the sidebar |
| Go to | <kbd>G</kbd> then <kbd>P</kbd> or <kbd>H</kbd> | Projects home |
| | <kbd>G</kbd> then <kbd>V</kbd> / <kbd>D</kbd> / <kbd>X</kbd> / <kbd>F</kbd> / <kbd>A</kbd> / <kbd>M</kbd> / <kbd>K</kbd> / <kbd>T</kbd> / <kbd>L</kbd> / <kbd>S</kbd> | Visualize / Containers / Terminal / Files / Artifacts / Memory / Credentials / Stats / Logs / Settings |
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
| | <kbd>⌘P</kbd> / <kbd>⌘S</kbd> | Open file / save it (Files tab) |
| | <kbd>F2</kbd> / <kbd>⌫</kbd> / <kbd>⌘X</kbd> <kbd>⌘C</kbd> <kbd>⌘V</kbd> | Rename / delete / cut, copy, paste the focused file or folder (Files tree) |
| Home | <kbd>J</kbd> / <kbd>K</kbd> | Next / previous Needs-you row |
| | <kbd>↵</kbd> | Open the focused card |
| | <kbd>R</kbd> / <kbd>S</kbd> / <kbd>P</kbd> | Retry or resume / Stop / Push to main, on the focused card |
| Containers | <kbd>L</kbd> | Focus the launcher |
| | <kbd>↑</kbd> / <kbd>↓</kbd> | Select a result (in the launcher) |
| | <kbd>↵</kbd> / <kbd>⇧↵</kbd> | Run with defaults / customize first |
| | <kbd>Esc</kbd> | Clear the launcher |
| Attachment viewer | <kbd>←</kbd> / <kbd>→</kbd> | Previous / next file (swipe on phones for images, video and audio) |
| | <kbd>Home</kbd> / <kbd>End</kbd> | First / last file |
| | <kbd>D</kbd> | Download |
| | <kbd>Z</kbd> | Toggle fit / 100% zoom |
| | <kbd>Esc</kbd> | Close |
| Files list | <kbd>↑</kbd> / <kbd>↓</kbd>, <kbd>Home</kbd> / <kbd>End</kbd> | Move between files |
| | <kbd>↵</kbd> or <kbd>Space</kbd> | Preview the focused file |
| Command palette | <kbd>↓</kbd>, <kbd>Ctrl+N</kbd> or <kbd>Tab</kbd> | Next result |
| | <kbd>↑</kbd>, <kbd>Ctrl+P</kbd> or <kbd>⇧Tab</kbd> | Previous result |
| | <kbd>Home</kbd> / <kbd>End</kbd>, <kbd>PgUp</kbd> / <kbd>PgDn</kbd> | First / last result, page through results |
| | <kbd>↵</kbd> | Run the highlighted entry |
| | <kbd>⌘↵</kbd> | Open a card in a new tab |
| | <kbd>Esc</kbd> | Close |

The command palette lists the actions of the focused or open card first, then **Recent**. Search is fuzzy; typing an action and a card name (`stop login`) offers that action on matching cards, and the **Board** group has **Stop all running** and **Start all To do**.

## Persistent memory (agentmemory)

AgentMan integrates [agentmemory](https://github.com/rohitg00/agentmemory) so card agents remember what earlier runs learned about a project.

1. Install it once on the server host: `npx -y @agentmemory/agentmemory@latest` (or `npm i -g @agentmemory/agentmemory`).
2. Connect omp to it: **Settings → Memory → Connect OMP**, or run `agentmemory connect omp --with-mcp`.

- `omp-ui up` and the supervisor start the memory server when it is installed (an enabled `systemctl --user` unit `agentmemory` is used instead when present), and the supervisor checks it again every 5 minutes (`OMP_UI_MEMORY_CHECK_MS`). **Settings → Memory** shows its status and can start it.
- Its REST API listens on `127.0.0.1:3111` and its live viewer on `127.0.0.1:3113`, on the server host's loopback only.
- Without API keys, recall uses BM25 keyword search. For semantic recall computed on the machine, set `EMBEDDING_PROVIDER=local` in `~/.agentmemory/.env`.
- Card runs store and recall memories under their board's project (the board folder's git root name, worktrees included, or `AGENTMEMORY_PROJECT_NAME`), shared with your own omp sessions in that folder. Each run's session is titled `<card title> (card <id>)`. Helper agents (card writer, advisor, queue planner, change summaries) don't capture or recall anything.
- The **Memory** page (`/memory`, <kbd>G</kbd> then <kbd>M</kbd>, or **Memory** in the sidebar) browses and searches memories and sessions and shows store stats.
- `AGENTMEMORY_ENABLED` (`auto`, the default, starts it when installed; `true` also warns when it is missing; `false` never starts it), `AGENTMEMORY_URL`, `AGENTMEMORY_VIEWER_URL`, `AGENTMEMORY_PROJECT_NAME` and `OMP_UI_MEMORY_CHECK_MS` are in [Configuration](#configuration); Docker setup is under [Docker](#docker).

## Shipping changes

A card has two ship buttons. Each acts on every project folder with changes; neither asks for confirmation. Agents also push to main or open a PR/MR on their own when the card or your feedback explicitly asks for it.

| Button | What happens | Needs |
| --- | --- | --- |
| **Create PR/MR** (recommended) | Commits to a new `omp/<card>` branch, pushes it, and opens a pull request (GitHub) or merge request (GitLab) | `git` plus [`gh`](https://cli.github.com) for GitHub or [`glab`](https://gitlab.com/gitlab-org/cli) for GitLab, signed in |
| **Push to main** | Commits and pushes directly to the repo's default branch | `git` with push access |

To authenticate, either:

- Run `gh auth login` and/or `glab auth login` once.
- Export `GH_TOKEN` / `GITLAB_TOKEN` in your shell (or set them in `.env`).

Pushing over SSH uses your normal `~/.ssh` keys and ssh-agent. See [Credentials](#credentials) for everything AgentMan picks up from your machine.

To change branches, tap the branch name in the board header, then the branch next to a folder. The list shows local branches and `origin` branches you haven't checked out yet. Uncommitted changes come along unless they would be overwritten. Switching is blocked while an agent on the board is running or queued.

## Credentials

AgentMan never asks for your AI or Git logins; it uses what this machine already has.

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
- AgentMan's own secrets (`ADMIN_PASSWORD`, `AUTH_SECRET`, `DATABASE_URL`, `POSTGRES_PASSWORD`, `OMP_UI_*`, …) are removed from the environment of agents and git commands.
- `omp-ui doctor` lists what it found (names only, never values).

### Saved credentials (MCP servers and services)

The **Credentials** page (`/credentials`, <kbd>G</kbd> then <kbd>K</kbd>, or **Credentials** in the sidebar) keeps keys and tokens for popular MCP servers and services (GitHub, GitLab, Slack, Notion, Linear, OpenAI, Anthropic, AWS, Cloudflare, Stripe, Postgres, Brave Search, a custom MCP server over HTTP, …).

- Each provider's form checks the fields before saving (required values, key formats, URLs) and shows a ready-to-copy `mcpServers` config snippet; secrets in it stay `${ENV_VAR}` placeholders.
- Credentials are stored in AgentMan's database; secret values are encrypted (AES-256-GCM) and only ever sent back masked. The key is `CREDENTIALS_KEY` (any non-empty string) or else one generated into `DATA_DIR/credentials.key` on first use. Back up that file (or the variable) with the database: with another key the stored secrets cannot be decrypted, the credentials show as failing, and their secrets must be entered again.
- Every credential can be tested before saving or at any time. Those with automatic checks on (the default) are re-checked every 10 minutes and show **healthy**, **failing** or **untested**.
- The bell in the sidebar footer (in the header on phones) counts unread problems: failing checks, expired keys, keys expiring within 7 days and untested credentials. Mark them read or dismiss them there; a new failure raises a new notification, and a browser notification when you have allowed them.

## CLI

Run `./omp-ui <command>`. Add `--help` to any command for details.

| Command | What it does |
| --- | --- |
| `up` | Set everything up and start it. This is the only command you need. Add `--public` for an internet link and `--port 8080` to change the port |
| `status` | Check whether it is running and show its links |
| `stop` / `start` / `restart` | Stop or start the server. `restart` rebuilds first when the sources changed (`--rebuild` always rebuilds), so committed changes go live with one command. If the build fails, the previous build is put back and started, and the command exits with an error |
| `logs -f` | Follow the server log |
| `open` | Open AgentMan in your browser |
| `passwd` | Change the admin password |
| `public` | Get a public `https://` link (cloudflared, or ngrok) · `public stop` |
| `doctor` | Check that Node, omp, git, gh/glab, the port and the database are OK, and list the credentials found |
| `init` | Re-run setup (`--force` overwrites `.env`, `--max-agents <n\|auto>` sets the agent limit) |
| `pm2 start` / `stop` / `restart` / `logs` / `status` / `save` / `startup` / `delete` | Run it under pm2. `omp-ui up --pm2` sets everything up first |
| `systemd install` / `uninstall` / `start` / `stop` / `restart` / `logs` / `status` / `unit` | Start on boot with a systemd user service (Linux). `omp-ui up --systemd` sets everything up first |
| `docker up` / `down` / `logs` / `ps` | Run it in Docker (`--postgres` or `--mongo` adds a database) |
| `deploy --host me@server` | Copy it to a server and start it there with Docker |
| `dev` / `build` / `version` | For development |

Settings live in `.env`, which `init` creates with permissions 600. Logs and runtime files go in `./data`.

**Restart from the browser.** The **Restart server** button in the header (↻; on phones, in the account menu) does `omp-ui restart --rebuild` for you: it stops the server, builds the current sources and starts it again, then reloads the page on the new build. The app is down while it builds (about a minute), and running agents are interrupted, then resume by themselves (with automatic retries on). If the build fails, the previous build keeps running and the dialog shows the build output (also in `data/restart.log`). It works for a server started with `omp-ui up`/`start`, under pm2 or under systemd (there it runs `systemctl --user restart omp-ui.service`, which rebuilds when the sources changed); Docker, `omp-ui dev` and `omp-ui start -f` show why they can't restart from the browser.

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
pm2 save && pm2 startup           # start on boot (or: omp-ui pm2 save, omp-ui pm2 startup)
```

This works on a fresh clone. The first run sets everything up and builds the app, which takes a few minutes. If you didn't set `ADMIN_PASSWORD`, the generated password is printed to `data/pm2-out.log` (search for `AgentMan ADMIN PASSWORD`). `omp-ui up --pm2` also shows it in your terminal.

- Follow the logs with `omp-ui pm2 logs`.
- While pm2 runs it, use `omp-ui pm2 stop` / `restart`. Plain `omp-ui stop` refuses so it doesn't fight pm2.
- `omp-ui pm2 restart` rebuilds when the sources changed; `omp-ui pm2 restart --rebuild` stops the app, always rebuilds, then starts it.
- `pm2 save && pm2 startup` is what makes it start on boot. See [Start on boot and self-healing](#start-on-boot-and-self-healing).

## Start on boot and self-healing

How each way of running AgentMan comes back after a crash or a reboot. All of them run the server under `bin/supervisor.mjs`, which watches its health.

### systemd (Linux)

```sh
omp-ui up --systemd          # set everything up, then install the service
omp-ui systemd install       # or just install the service
```

- `install` writes a user unit to `~/.config/systemd/user/omp-ui.service` (from the repo's `omp-ui.service`), enables it at boot and starts it. A server you started with `omp-ui up`/`start` is stopped first so systemd takes over.
- It also turns on lingering (`loginctl enable-linger $USER`) so the service starts at boot without a login. If that fails, run `sudo loginctl enable-linger $USER`.
- Manage it with `omp-ui systemd start` / `stop` / `restart [--rebuild]` / `status` / `logs [-n N] [-f]` / `uninstall`.
- `omp-ui systemd unit` prints the unit for a manual install:

  ```sh
  omp-ui systemd unit > ~/.config/systemd/user/omp-ui.service \
    && systemctl --user daemon-reload \
    && systemctl --user enable --now omp-ui.service
  ```

- The service does not see variables exported in your interactive shell (`GH_TOKEN`, `ANTHROPIC_API_KEY`, `SSH_AUTH_SOCK`, …). Put them in `.env` or in a drop-in from `systemctl --user edit omp-ui.service`:

  ```ini
  [Service]
  Environment=GH_TOKEN=…
  ```

- `PATH` is captured at install time. Re-run `omp-ui systemd install` after changing it (e.g. a new Node or omp location).
- While systemd runs it, plain `omp-ui stop` / `restart` refuse; use `omp-ui systemd stop` / `restart`. The browser **Restart server** button runs `systemctl --user restart omp-ui.service`.
- On stop, systemd sends SIGTERM to the CLI only, which passes it to the supervisor, and the server stops its agents. Anything left after 30 s is killed (`KillMode=mixed`, `TimeoutStopSec=30`).

### Plain `omp-ui up` / `start`

- The supervisor restarts a crashed or unhealthy server, but nothing starts it again after a reboot. Use systemd or pm2.
- Last resort: a `@reboot` cron entry (`crontab -e`): `@reboot cd /path/to/omp-ui && ./omp-ui start`.

### PM2

- `pm2 start ecosystem.config.cjs` (or `omp-ui up --pm2`), then `omp-ui pm2 save` and `omp-ui pm2 startup`.
- `pm2 startup` needs a global pm2 (`npm i -g pm2`) and prints a `sudo` command: run it. Run `pm2 save` again after changing the process list.
- pm2 restarts the CLI if it dies; the supervisor inside restarts the server on a crash or failed health checks.

### Docker

- `restart: unless-stopped` in `docker-compose.yml` restarts the containers after a crash or a reboot, as long as the Docker daemon starts at boot (`sudo systemctl enable docker`; Docker Desktop: **Start Docker Desktop when you sign in**).
- A container you stopped with `docker compose stop` stays stopped after a reboot.
- The image `HEALTHCHECK` only marks the container **unhealthy**; Docker does not restart it for that. The supervisor inside does the force restart.

### Health monitoring

- Crash: the supervisor restarts the server, backing off from 1 s up to 30 s.
- `OMP_UI_HEALTH_FAILURES` failed probes in a row: SIGTERM, then SIGKILL after `OMP_UI_STOP_TIMEOUT_MS`, then a restart.

| Variable | Default | |
| --- | --- | --- |
| `OMP_UI_HEALTH_URL` | `http://<HOST>:<PORT>/api/v1/health` | URL to probe |
| `OMP_UI_HEALTH_INTERVAL_MS` | `15000` | Time between probes |
| `OMP_UI_HEALTH_TIMEOUT_MS` | `10000` | Timeout per probe |
| `OMP_UI_HEALTH_FAILURES` | `3` | Failed probes in a row before a force restart (`0` = never) |
| `OMP_UI_HEALTH_GRACE_MS` | `120000` | Startup time before failures count |
| `OMP_UI_STOP_TIMEOUT_MS` | `8000` | Wait after SIGTERM before SIGKILL |

To see it, look for `[supervisor …] health check failed (n/3)` and `server is unhealthy — force restarting it` in `data/omp-ui.log`, `data/pm2-out.log`, `omp-ui systemd logs` or `docker compose logs omp-ui`.

### No data loss on restarts

- Database writes are committed synchronously (SQLite in WAL mode, Postgres, MongoDB).
- Data lives in `DATA_DIR` / `DATABASE_URL` (Docker: the `./data` bind mount and the named volumes).
- On SIGTERM the server stops its omp agents.
- After any restart, queued cards go back in the queue and interrupted cards resume their omp session automatically.

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
- **Start on boot:** the containers come back after a crash or reboot when the Docker daemon starts at boot. See [Start on boot and self-healing](#start-on-boot-and-self-healing).

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
| `OMP_UI_HEALTH_URL` | `http://<HOST>:<PORT>/api/v1/health` | URL the supervisor probes. See [Start on boot and self-healing](#start-on-boot-and-self-healing) |
| `OMP_UI_HEALTH_INTERVAL_MS` | `15000` | Time between health probes (ms) |
| `OMP_UI_HEALTH_TIMEOUT_MS` | `10000` | Timeout per health probe (ms) |
| `OMP_UI_HEALTH_FAILURES` | `3` | Failed probes in a row before a force restart (`0` = never) |
| `OMP_UI_HEALTH_GRACE_MS` | `120000` | Startup time before failed probes count (ms) |
| `OMP_UI_STOP_TIMEOUT_MS` | `8000` | Wait after SIGTERM before SIGKILL (ms) |
| `GH_TOKEN` / `GITLAB_TOKEN` | – | Git hosting tokens (instead of `gh` / `glab` login). Usually exported in your shell; see [Credentials](#credentials) |
| `CREDENTIALS_KEY` | `DATA_DIR/credentials.key` | Encryption key for secrets on the Credentials page. See [Saved credentials](#saved-credentials-mcp-servers-and-services) |
| `VINEXT_TRUST_PROXY` | – | `1` behind a reverse proxy |

## Security

- **Set a strong admin password before you make AgentMan public.** It is the only thing protecting a tool that runs commands on your machine.
- Agents run in **`yolo`** approval mode by default: they run commands and edit files without asking. Only point projects at folders you are happy for an agent to change. Use Docker if you want isolation. You can change the mode in **Settings**.
- Changing the password signs out every session. Keep `.env` private.
- Use HTTPS outside your home network: either the `public` link or a reverse proxy.

## Development

```sh
pnpm install && ./omp-ui dev        # live reload, loads .env
pnpm typecheck
```

Built with [vinext](https://vinext.dev) (Next.js App Router on Vite), React, Tailwind v4, shadcn/ui and dnd-kit.
