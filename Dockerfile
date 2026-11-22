# syntax=docker/dockerfile:1
# OMP-UI — kanban control panel for omp coding agents, with omp baked in.
#   docker compose up -d          (recommended; see docker-compose.yml)
#   docker build -t omp-ui .      (optional: --build-arg OMP_VERSION=v18.19.0 to pin omp)

ARG NODE_IMAGE=node:24-bookworm-slim

# ─── deps: install node_modules from the lockfile ───────────────────────────
FROM ${NODE_IMAGE} AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ─── build: vite build → dist/standalone (server.js + runtime node_modules) ─
FROM deps AS build
COPY . .
RUN pnpm build && test -f dist/standalone/server.js
# Database drivers are loaded at runtime; make sure they exist in the standalone
# output even when the bundler inlined or skipped them.
RUN set -eu; \
    cd dist/standalone; \
    missing=""; \
    for pkg in mongodb pg; do \
      if ! node --input-type=module -e "await import('$pkg')" >/dev/null 2>&1; then \
        missing="$missing $pkg@$(node -p "require('/app/node_modules/$pkg/package.json').version")"; \
      fi; \
    done; \
    if [ -n "$missing" ]; then \
      echo "Adding runtime packages:$missing"; \
      mkdir -p /tmp/runtime && cd /tmp/runtime && echo '{"private":true}' > package.json; \
      npm install --omit=dev --no-audit --no-fund --loglevel=error $missing; \
      cp -Rn /tmp/runtime/node_modules/. /app/dist/standalone/node_modules/; \
    fi

# ─── runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG OMP_VERSION=""
ARG GLAB_VERSION=""

# Tools the omp agent and the git integration rely on (git, ssh, ripgrep) + tini as PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client procps ripgrep tini unzip \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) from the official apt repository — "Create PR" on GitHub.
RUN set -eu; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*; \
    gh --version

# GitLab CLI (glab) from the official release .deb — "Create MR" on GitLab.
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    version="${GLAB_VERSION#v}"; \
    if [ -z "$version" ]; then \
      version="$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest' | sed -n 's/.*"tag_name":"v\([^"]*\)".*/\1/p')"; \
    fi; \
    curl -fsSL -o /tmp/glab.deb "https://gitlab.com/gitlab-org/cli/-/releases/v${version}/downloads/glab_${version}_linux_${arch}.deb"; \
    dpkg -i /tmp/glab.deb; \
    rm -f /tmp/glab.deb; \
    glab --version

# omp: official installer (prebuilt, checksum-verified binary) into /usr/local/bin.
RUN set -eu; \
    if [ -n "$OMP_VERSION" ]; then \
      curl -fsSL https://omp.sh/install | PI_INSTALL_DIR=/usr/local/bin sh -s -- --binary --ref "$OMP_VERSION"; \
    else \
      curl -fsSL https://omp.sh/install | PI_INSTALL_DIR=/usr/local/bin sh -s -- --binary; \
    fi; \
    omp --version; \
    rm -rf /root/.omp

# Unprivileged user `omp` (uid 1000; the entrypoint adapts it to the mounted volumes).
# ~/.ssh is mounted read-only, so new host keys go to a writable known_hosts file.
RUN usermod -l omp -d /home/omp -m node \
 && groupmod -n omp node \
 && mkdir -p /data /workspace /home/omp/.omp /home/omp/.config/gh /home/omp/.cache/ssh \
 && chown -R omp:omp /data /workspace /home/omp \
 && git config --system --add safe.directory '*' \
 && git config --system user.name "OMP-UI agent" \
 && git config --system user.email "omp-ui@localhost" \
 && mkdir -p /etc/ssh/ssh_config.d \
 && printf 'Host *\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile /home/omp/.cache/ssh/known_hosts ~/.ssh/known_hosts\n' \
      > /etc/ssh/ssh_config.d/omp-ui.conf

WORKDIR /app
COPY --from=build /app/dist/standalone ./
COPY --from=build /app/bin ./bin
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    DATABASE_URL=sqlite:/data/omp-ui.db \
    WORKSPACE_DIR=/workspace \
    OMP_PATH=omp \
    HOME=/home/omp

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/bin/docker-entrypoint.sh"]
# bin/supervisor.mjs restarts the server when it crashes or its health check keeps failing (Docker
# itself only reports "unhealthy"); `restart: unless-stopped` covers the supervisor. Tune it with
# OMP_UI_HEALTH_* (and OMP_UI_STOP_TIMEOUT_MS) in .env; see .env.example.
CMD ["node", "bin/supervisor.mjs", "node", "server.js"]
