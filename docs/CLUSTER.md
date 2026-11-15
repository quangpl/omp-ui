# Cluster mode

Cluster mode spreads card agents over several machines. One omp-ui server is the **primary**: it keeps
the database, serves the UI, runs the agent queue and dispatches runs. Every other machine is a
**replica node**: it runs cards for the primary, keeps a replicated copy of the primary's state, and
takes over as primary when the primary goes down. Cluster mode is opt-in; a server that never enables
it (`standalone`) behaves exactly as before.

## Setting it up

1. On the machine that should coordinate, open **Settings → Cluster** and turn on **Enable cluster
   mode**. This server becomes the primary and gets a join token.
2. Copy the join command shown there and run it on each machine you want to add:

   ```sh
   curl -fsSL http://<primary>:3000/api/v1/cluster/join | sh -s -- <token>
   ```

   Add `--service` to install it as a systemd user service (starts on boot, restarts on failure), or
   `--background` to keep it running after you log out. Without a flag it runs in the foreground.

Nothing else has to be installed or configured on the new machine (besides `curl` or `wget`):

| Needed on the node | Where it comes from |
| --- | --- |
| Node.js | the primary's own Node binary when OS/architecture match, else nodejs.org |
| omp-ui | the primary's build (`/api/v1/cluster/bundle`) |
| omp | the primary's omp binary (same OS/architecture), verified by SHA-256 |
| omp configuration, credentials, skills, extensions, rules, MCP servers | a copy of the primary's omp agent dir (`~/.omp/agent`), refreshed before every run |
| AI provider keys and MCP secrets | passed with every run (Settings → AI Providers on the primary) |
| Project files, card files, worktrees, omp sessions | synced before the run, changes streamed back while it runs |

Project toolchains the agents use (git, language runtimes, package managers, Docker) still have to
exist on the node, like on any development machine.

Environment variables of the join script: `OMP_UI_NODE_DIR` (default `~/.omp-ui-node`),
`OMP_UI_PORT` (the node's web port, default 3000), `OMP_UI_CLUSTER_PORT` (cluster port, default 7790).

A server that already runs omp-ui can join from **Settings → Cluster → Join a cluster** (primary URL +
token, **Test connection**, **Join**). Its own boards and data are replaced by the primary's (the
database is backed up to `DATA_DIR/cluster/backups/` first) and it restarts as a replica.

## How runs are distributed

The primary's queue limit becomes the cluster's: its own limit (when **Run cards on this machine too**
is on) plus the slots of every online node that can run omp. A node's slots follow the same rule as a
standalone server's limit (`maxConcurrentAgents`: `auto` from its cores and free memory, or the fixed
number per node). When a card starts, it goes to the machine with the most free slots, preferring the
node that ran the card's previous run.

A remote run is executed exactly like a local one: the primary keeps the whole run logic (prompt,
board tools, advisor, run guards, comments, database) and only the `omp` process runs on the node.
omp's RPC stream is relayed over the cluster channel; files are synced in both directions:

- before omp starts, the node's copy of the run's folders (project folders, card and board files,
  session dir) is brought up to date — only changed files are sent;
- while the agent works, changed files are pushed back every few seconds, and always before the agent
  finishes and before every board tool call, so the primary sees the same files as after a local run.

Cards that run on the same node at once share that node's copy of a folder they both use (the
project folder of a board without dedicated workspaces, the git repository behind worktrees), just
like two local runs share a folder: a second card never resets files the first one is changing.

The relay is light: on a loopback measurement an omp message takes about 0.1 ms longer per round trip
than over a local pipe, and file transfers run at well over 100 MiB/s, so a node's network link, not
the protocol, sets the pace.

The UI shows where each card runs: Visualize marks the node of every running agent, and a card's run
report and details say which machine ran it.

## Failures and failover

- **A node goes offline**: the primary marks it offline and posts a notice. Its runs wait 30 s for the
  node to come back (the node keeps omp running and buffers its output, so a short network blip loses
  nothing); after that the run fails with "…; rescheduled" and the card is queued again (no automatic
  retry is used), so it resumes its omp session on whichever machine is free, the same node included
  once it is back.
- **The primary goes down**: replicas notice the lost connection. After **failover timeout** seconds
  (Settings → Cluster, default 20) they hold an election: the reachable replica with the freshest
  replicated state is promoted. It becomes the primary under a higher *term*, resumes interrupted cards
  from the replicated database and session files, and announces itself to the other nodes, which
  follow it. Notices about every step appear in the UI of each node.
- **The original primary comes back** (failback): the machine that enabled cluster mode is the
  cluster's *home primary*. When it returns it first rejoins as a replica of the interim primary (its
  own database is backed up; changes it made while cut off are not merged) and receives the current
  state. Once it has stayed connected for 30 s and caught up, the interim primary starts no new runs,
  lets running ones finish (up to 2 minutes), ships a final snapshot and hands control back: the home
  primary is promoted under a new term and the interim primary becomes a replica again. Cards still
  running at the handover are resumed by the home primary. Any other returning primary simply stays a
  replica of the current primary.

Replication is asynchronous: the database is shipped every 15 s when it changed, project and card
files every 60 s. A promotion can therefore lose up to that much work; interrupted cards are resumed.
With only two machines a network split cannot be told apart from a crash: both sides may act as
primary until they see each other again, when the lower term steps down.

## Security

- Nodes authenticate with the join token through a mutual HMAC-SHA256 challenge (the token itself is
  never sent, and a node also checks that the primary knows the token). Every message after that is
  encrypted with AES-256-GCM using per-direction keys derived from the token and both sides' nonces,
  so AI provider keys and credentials never cross the network in clear text, even over plain HTTP.
- Rotating the token (Settings → Cluster) keeps connected nodes in and locks out everyone else.
- Changes a node sends back can only touch the folders of its own runs. Paths are validated, symlinks
  must stay inside their folder, and git configuration, hooks and repository pointers (`.git/config`,
  `config.worktree`, `commondir`, `.git/hooks/`, worktree `.git` files) are never accepted from a node.
- Replicas get the primary's `AUTH_SECRET` and credentials key (file or `CREDENTIALS_KEY`), so sessions
  and saved secrets keep working after a promotion; agents never see either. `node.json` and copied
  keys are written with mode 0600.
- A replica accepts no changes except sign-in and cluster actions; everything else answers 409 and
  names the primary.
- The join script, the app bundle and the Node/omp binaries are public downloads (they contain no
  secrets: `.env` files and the data dir are never bundled); joining requires the token.

## Ports

| Port | Purpose |
| --- | --- |
| `PORT` (3000) | web UI and API; the join script downloads from it |
| `OMP_UI_CLUSTER_PORT` (7790) | cluster channel (TCP), on every node |

Both must be reachable between the machines.

## Limits

- Binaries are shared only between machines of the same OS and architecture; a node of another
  platform needs omp installed locally.
- Replicas serve a read-only UI; changes are made on the primary.
- OAuth subscriptions whose refresh tokens rotate may ask for a new login if two machines refresh the
  same token at once.
