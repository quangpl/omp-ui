# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories:
https://github.com/quangpl/omp-ui/security/advisories/new

Do not open public issues for security problems. Include affected version, reproduction steps, and impact.

## Scope and exposure guidance

OMP-UI runs omp agents that execute commands and edit files on the host. Anyone who can reach the UI can effectively run code as the user running it. Therefore:

- Always set `ADMIN_PASSWORD` when the UI is reachable by anyone but you.
- Do not expose it directly to the public internet; prefer a private network such as [Tailscale](https://tailscale.com).
- Run it as an unprivileged user, or in Docker, with access only to the repos you intend agents to touch.
