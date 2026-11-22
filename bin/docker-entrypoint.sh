#!/bin/sh
# Container entrypoint: adapt the unprivileged `omp` user to the mounted volumes,
# then drop root and run the command (default: node server.js) as `omp`.
#
# docker-compose.yml mounts the host user's credentials (omp, Claude, git, gh, glab,
# SSH, AWS) into /home/omp. Any of them may be missing on the host, in which case
# Docker mounts an empty placeholder (a root-owned directory, or /dev/null for the
# ssh-agent socket); those are ignored here instead of breaking the tools.
set -eu

home=/home/omp

# Docker creates a directory when a bind-mounted file is missing on the host.
# ~/.gitconfig as a directory breaks git: use the XDG config (~/.config/git/config)
# when there is one, else only the image's system config.
if [ -d "$home/.gitconfig" ]; then
  if [ -f "$home/.config/git/config" ]; then
    export GIT_CONFIG_GLOBAL="$home/.config/git/config"
  else
    export GIT_CONFIG_GLOBAL=/dev/null
  fi
fi

# SSH agent forwarding: compose mounts $SSH_AUTH_SOCK (or /dev/null) here.
if [ -n "${SSH_AUTH_SOCK:-}" ] && [ ! -S "$SSH_AUTH_SOCK" ]; then
  unset SSH_AUTH_SOCK
fi

if [ "$(id -u)" = "0" ]; then
  data_dir=${DATA_DIR:-/data}
  omp_home=$home/.omp
  mkdir -p "$data_dir" /workspace "$omp_home"

  # Run as the owner of the mounted omp config (or data dir) so provider auth,
  # the database and workspace files stay readable/writable on the host.
  target_uid=$(id -u omp)
  target_gid=$(id -g omp)
  for dir in "$omp_home" "$data_dir" /workspace; do
    uid=$(stat -c %u "$dir")
    if [ "$uid" != "0" ]; then
      target_uid=$uid
      target_gid=$(stat -c %g "$dir")
      break
    fi
  done
  if [ "$target_gid" != "$(id -g omp)" ]; then
    groupmod -o -g "$target_gid" omp
  fi
  if [ "$target_uid" != "$(id -u omp)" ]; then
    usermod -o -u "$target_uid" -g "$target_gid" omp
  fi
  # The image's own home folders (not the mounts inside them) follow the remapped user.
  chown omp:omp "$home" "$home/.config"
  chown -R omp:omp "$home/.cache"
  # Writable mounts Docker created as root-owned placeholders for missing host paths
  # (read-only mounts such as ~/.ssh are left alone).
  for dir in "$data_dir" /workspace "$omp_home" "$home/.claude" "$home/.config/gh" "$home/.config/glab-cli"; do
    if [ -d "$dir" ] && [ "$(stat -c %u "$dir")" = "0" ]; then
      chown omp:omp "$dir" 2>/dev/null || true
    fi
  done

  # ~/.claude.json: an empty file (pre-created placeholder) is not valid JSON.
  claude_json=$home/.claude.json
  if [ -f "$claude_json" ] && [ ! -s "$claude_json" ]; then
    printf '{}\n' 2>/dev/null >"$claude_json" || true
  fi
  if [ -d "$claude_json" ]; then
    echo "omp-ui: $claude_json is a directory (missing on the host when the container was created); create it with: echo '{}' > ~/.claude.json" >&2
  fi

  exec setpriv --reuid=omp --regid=omp --init-groups "$@"
fi

exec "$@"
