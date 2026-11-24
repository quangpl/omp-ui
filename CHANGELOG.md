# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project header: a **Pull latest changes** button next to the branch menu fast-forwards every project repo's current branch (`POST /boards/:id/git/pull`); it shows how many commits upstream is ahead. Discard all changes stays beside the changes chip.
- Create PR/MR saves the opened PR/MR link on the card (`Task.pullRequests`); the Ship panel then shows **Open PR/MR** instead of asking to create it again.
- Activity chat and agent log render images in place when the text links to one (`[shot](…png)`, a bare image URL, or an app file path in backticks) instead of showing only a file chip or path.
- Visualize: the **Agent hub** section now shows the roster of omp's Agent Hub (subagents of recent runs with status, model, age, activity, cost/time/requests/tools/tokens, inspector, parent/child tree, activity log) instead of omp usage statistics, which stay on the Stats page (`GET /agent-hub`).

### Changed

- Stats (quota, balances, usage totals and per-model table) cover only the Main AI provider from Settings → AI Providers; agents, projects and hourly spend are hidden while another provider has usage, as omp cannot split them.

## [0.1.6] - 2026-11-22

### Added

- Stats page: per-model TTFT, tokens/s, cache rate and failures, and a "Usage by project" panel, from `omp stats`.
- Stats icon in the desktop header.

## [0.1.5] - 2026-11-22

## [0.1.4] - 2026-11-22

## [0.1.3] - 2026-11-22

## [0.1.2] - 2026-11-22

## [0.1.1]

### Added

- npm package and `omp-ui` CLI, with pm2 support.
- Onboarding wizard.
- Env vars page.
- Streaming stats.
- Automatic resolution of PR merge conflicts.
- "Advanced" navigation group.
- MIT license.

### Changed

- Renamed the project to OMP-UI.

### Removed

- Memories and SDLC features.

## [0.1.0]

Initial release.
