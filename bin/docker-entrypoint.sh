#!/bin/sh
# Container entrypoint: adapt the unprivileged `omp` user to the mounted volumes,
# then drop root and run the command (default: node server.js) as `omp`.
set -eu

# Docker creates a directory when a bind-mounted file is missing on the host;
# fall back to the image's system git config instead of breaking git.
if [ -d /home/omp/.gitconfig ]; then
  export GIT_CONFIG_GLOBAL=/dev/null
fi

if [ "$(id -u)" = "0" ]; then
  data_dir=${DATA_DIR:-/data}
  omp_home=/home/omp/.omp
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
  chown omp:omp /home/omp

  # Directories Docker created for missing bind mounts are owned by root.
  for dir in "$data_dir" /workspace "$omp_home"; do
    if [ "$(stat -c %u "$dir")" = "0" ]; then
      chown omp:omp "$dir"
    fi
  done

  exec setpriv --reuid=omp --regid=omp --init-groups "$@"
fi

exec "$@"
