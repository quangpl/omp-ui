# AgentMan

A self-hosted kanban board for [omp](https://omp.sh/docs) coding agents. Write a card, and an agent does the work in your project. You can follow it live from your desktop or phone.

## Requirements

- Node.js 24 or newer
- omp, installed and signed in:

```sh
curl -fsSL https://omp.sh/install | sh
omp            # run once and sign in to an AI provider
```

## Quick start

```sh
npx omp-ui
```

This one command sets everything up, starts AgentMan in the background with pm2 and prints its URL. It asks for a password for the `admin` account, or generates one and prints it. Open the URL, sign in and follow the setup wizard.

To install it permanently:

```sh
npm i -g omp-ui
omp-ui
```

Settings and data live in `~/.omp-ui`. SQLite is the default database, so you don't need to set one up.

## Basic commands

| Command | What it does |
| --- | --- |
| `omp-ui` | Set up and start AgentMan |
| `omp-ui status` | Check whether it is running and show its URL |
| `omp-ui stop` / `start` / `restart` | Stop, start or restart the server |
| `omp-ui logs -f` | Follow the server log |
| `omp-ui open` | Open AgentMan in your browser |
| `omp-ui config set port 8080` | Change a setting (`port`, `data-dir`, `db-url`), then run `restart` |
| `omp-ui doctor` | Check Node.js, omp, git, gh and pm2 |
| `omp-ui update` | Update to the latest version and restart |
| `omp-ui help` | List every command |

## Using it

1. **Create a project.** Pick a folder or clone a Git repository.
2. **Add a card.** Describe the task in your own words, and an agent starts working on it.
3. **Give feedback.** Comment on the card. The agent reads your comments and keeps going.
4. **Ship it.** Click **Create PR**, **Push to main** or **Push to current branch**.

## Access from anywhere

AgentMan runs commands on your machine. Before exposing it, set a strong admin password with `omp-ui passwd`.

### Tailscale (private, recommended)

Reach AgentMan only from your own devices, over HTTPS:

```sh
tailscale serve --bg 3000
```

Open `https://<machine-name>.<tailnet>.ts.net` on any device in your tailnet. To share it with people outside your tailnet, use `tailscale funnel --bg 3000` instead.

### Cloudflare Tunnel

To get a temporary public link right away:

```sh
omp-ui public          # prints an https://….trycloudflare.com link
omp-ui public stop
```

The link changes every time it starts. For a permanent address on your own domain, create a [named Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) that points to `http://localhost:3000`.

If you use Tailscale, Cloudflare or another proxy, add `VINEXT_TRUST_PROXY=1` to `~/.omp-ui/.env`, then run `omp-ui restart`.

## Docker

```sh
docker compose up -d   # then open http://localhost:3000
```

## Learn more

- [Advanced guide](docs/ADVANCED.md): every feature, the full CLI, PM2, systemd, Docker, databases, clustering and configuration.
- [API reference](docs/API.md)
- [Cluster mode](docs/CLUSTER.md)

## Contributing

```sh
pnpm install
pnpm dev
pnpm test
```

## License

[MIT](LICENSE)
