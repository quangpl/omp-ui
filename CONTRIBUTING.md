# Contributing to OMP-UI

Thanks for helping out! OMP-UI is a self-hosted web UI / kanban board for the [omp](https://omp.sh) AI coding agent CLI.

## Prerequisites

- Node.js 24+
- pnpm (version pinned in `package.json` under `packageManager`)
- [omp](https://omp.sh) installed and on your `PATH`

## Setup

```bash
git clone https://github.com/quangpl/omp-ui.git
cd omp-ui
pnpm install
pnpm dev
```

## Tests

```bash
pnpm test        # unit tests
pnpm typecheck   # TypeScript
pnpm test:e2e    # Playwright end-to-end tests
```

Run all three before opening a PR.

## Workflow

1. Fork the repo and create a branch from `main` (e.g. `fix/card-drag`, `feat/stats-export`).
2. Make focused changes; add or update tests.
3. Open a pull request using the template and describe what and why.

## Commit style

Short, imperative subject lines: `Fix card drag on touch`, `Add env vars page`. One logical change per commit.

## Agent conventions

If you use an AI coding agent on this repo, see [AGENTS.md](AGENTS.md) for project conventions.

## Conduct and security

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
