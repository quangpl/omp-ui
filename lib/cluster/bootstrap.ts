// Joining a machine with nothing installed: the request base URL the join command points at, the
// POSIX sh join script served by GET /api/v1/cluster/join, and the downloads it uses (the app
// bundle as a gzip tar stream, gzip streams of the Node and omp binaries).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, pipeline } from "node:stream";
import { createGzip } from "node:zlib";
import { dataDir } from "@/lib/files";
import { HttpError } from "@/lib/server/http";
import type { ClusterJoinInfo } from "@/lib/types";

/** Longest primary URL accepted in a join/test request. */
const MAX_URL_LENGTH = 2048;
/** Longest join token accepted in a join/test request. */
const MAX_TOKEN_LENGTH = 200;
/** Host header values that are safe to bake into a shell script (host name / IPv4 / [IPv6], optional port). */
const SAFE_HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;
/** Scripts next to server.js the node starts with. */
const BIN_SCRIPTS = ["supervisor.mjs"];

/**
 * Base URL this request reached the server at (reverse proxies: x-forwarded-proto/host), without a
 * trailing slash. Host values that are not a plain host[:port] are ignored, since the URL ends up
 * in a shell script; 400 when no safe host is left (req.url itself is built from the raw Host header).
 */
export function requestBaseUrl(req: Request): string {
  const origin = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
  const proto = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : origin.protocol.slice(0, -1);
  const host = [
    req.headers.get("x-forwarded-host")?.split(",")[0].trim(),
    req.headers.get("host")?.trim(),
    origin.host,
  ].find((value) => value && SAFE_HOST.test(value));
  if (!host || (proto !== "http" && proto !== "https")) throw new HttpError(400, "Invalid Host header");
  return `${proto}://${host}`;
}

/** What a new machine needs to join the cluster whose primary answered `req`. */
export function clusterJoinInfo(req: Request, token: string): ClusterJoinInfo {
  const url = requestBaseUrl(req);
  return { token, url, joinCommand: `curl -fsSL ${url}/api/v1/cluster/join | sh -s -- ${token}` };
}

/**
 * `{ url, token }` of a join/test request body: `url` an http(s) URL (trailing slashes dropped),
 * `token` 1..200 characters (0..200 with `allowEmptyToken`: "" means the node's stored token).
 */
export function parseJoinTarget(
  body: Record<string, unknown>,
  opts: { allowEmptyToken?: boolean } = {},
): { url: string; token: string } {
  const url = typeof body.url === "string" ? body.url.trim().replace(/\/+$/, "") : "";
  if (!url || url.length > MAX_URL_LENGTH || !/^https?:\/\/\S+$/i.test(url) || !URL.canParse(url)) {
    throw new HttpError(400, `url must be an http(s) URL of at most ${MAX_URL_LENGTH} characters`);
  }
  const token = typeof body.token === "string" ? body.token.trim() : null;
  const min = opts.allowEmptyToken ? 0 : 1;
  if (token === null || token.length < min || token.length > MAX_TOKEN_LENGTH) {
    throw new HttpError(400, `token must be a string of ${min} to ${MAX_TOKEN_LENGTH} characters`);
  }
  return { url, token };
}

/** The running server's app dir (the dist/standalone folder holding server.js); null when not found. */
export function appDir(): string | null {
  const script = process.argv[1];
  const candidates = [
    script ? path.dirname(path.resolve(script)) : null,
    path.join(process.cwd(), "dist", "standalone"),
  ];
  return candidates.find((dir) => dir && existsSync(path.join(dir, "server.js"))) ?? null;
}

/**
 * Folder whose `bin/` holds the node scripts: the app dir itself (a joined node's app) or the
 * checkout the dist/standalone build lives in.
 */
function binParent(app: string): string | null {
  const candidates = [app, path.resolve(app, "..", ".."), process.cwd()];
  return (
    candidates.find((dir) => BIN_SCRIPTS.every((name) => existsSync(path.join(dir, "bin", name)))) ?? null
  );
}

/**
 * GET /cluster/bundle: gzip tar of the app dir (never `.env*`, `data` or whatever holds DATA_DIR)
 * plus bin/supervisor.mjs, streamed from `tar` (length unknown). 404 when
 * this server has no build.
 */
export async function bundleResponse(): Promise<Response> {
  const app = appDir();
  if (!app) throw new HttpError(404, "This server has no app build (dist/standalone/server.js) to share");
  const bin = binParent(app);
  if (!bin) throw new HttpError(404, "bin/supervisor.mjs was not found next to the app");
  const data = path.resolve(dataDir());
  // Entries named explicitly ("./" so none reads as an option) instead of --exclude patterns, whose
  // matching differs between GNU tar and bsdtar.
  const entries = readdirSync(app)
    // Server secrets (.env*) and data never leave this machine.
    .filter((name) => {
      const entry = path.resolve(app, name);
      return !name.startsWith(".env") && name !== "data" && entry !== data && !data.startsWith(entry + path.sep);
    })
    .map((name) => `./${name}`);
  const args = ["-czf", "-", "-C", app, ...entries];
  if (bin !== app) args.push("-C", bin, ...BIN_SCRIPTS.map((name) => `bin/${name}`));
  // COPYFILE_DISABLE: macOS tar would add AppleDouble `._*` files.
  const child = spawn("tar", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  await once(child, "spawn");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.once("close", (code, signal) => {
    // A client that stops reading kills tar with SIGPIPE: not worth a log line.
    if (code !== 0 && signal !== "SIGPIPE") {
      console.error(`[cluster] app bundle tar failed (${signal ?? `code ${code}`}): ${stderr.trim()}`);
    }
  });
  return streamResponse(Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, "omp-ui-app.tar.gz");
}

/** Gzip stream of one file (a Node or omp binary); 404 when it is not a readable file. */
export async function gzipFileResponse(file: string, downloadName: string): Promise<Response> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "File not found");
  const gzip = createGzip();
  // pipeline destroys the gzip stream on a read error, which errors the response body.
  pipeline(createReadStream(file), gzip, () => {});
  return streamResponse(Readable.toWeb(gzip) as ReadableStream<Uint8Array>, downloadName);
}

function streamResponse(body: ReadableStream<Uint8Array>, downloadName: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${downloadName}"`,
      "cache-control": "no-store",
    },
  });
}

/**
 * GET /cluster/join: the POSIX sh script `curl -fsSL <url>/api/v1/cluster/join | sh -s -- <token>`
 * runs. It makes a bare machine a ready node in one run: installs what is missing (system
 * packages, Node.js with npm, the primary's omp), installs the app, starts the node (background by
 * default) and waits until it has joined. `baseUrl` (from requestBaseUrl: scheme://host[:port]
 * only) and this server's Node version are baked in; the token is the script's argument and never
 * part of it.
 */
export function joinScript(baseUrl: string): string {
  const nodeVersion = process.versions.node;
  return `#!/bin/sh
# Joins this machine to the omp-ui cluster whose primary is ${baseUrl} (script generated by it).
#
#   curl -fsSL ${baseUrl}/api/v1/cluster/join | sh -s -- <token> [--service|--foreground]
#
# One run makes a bare machine ready:
#   1. checks this machine: OS/CPU (glibc Linux or macOS) and root rights (root or passwordless sudo)
#   2. installs missing system packages: tar, gzip, curl, CA certificates and git
#   3. checks that the primary answers and has cluster mode on
#   4. Node.js >= 24 with npm (the official build from nodejs.org unless one is on PATH)
#   5. omp: the primary's binary (sha256-verified) when it runs on this OS/CPU
#   6. the primary's omp-ui build and the node's configuration in $OMP_UI_NODE_DIR
#   7. starts the node and waits until it has joined the cluster (it then syncs its config and
#      credentials from the primary). The node runs in the background (nohup, default), as a
#      systemd user service (--service, Linux) or in this terminal (--foreground). When it does
#      not join in time the script stops it again and fails.
#
# Environment: OMP_UI_NODE_DIR  install dir (default ~/.omp-ui-node)
#              OMP_UI_PORT      web port of the node (default 3000)
#              OMP_UI_CLUSTER_PORT  cluster channel port of the node (default 7790)
#              NO_COLOR         plain output even on a terminal
#
# Everything runs from main(), called on the last line: a download cut short runs nothing.
set -eu

PRIMARY_URL='${baseUrl}'
# Node.js version of the primary when the script was generated (its info route says the same).
PRIMARY_NODE_VERSION='${nodeVersion}'
UNIT=omp-ui-node
# Seconds the node gets to join the cluster after it starts.
READY_TIMEOUT=300

# --- Output -------------------------------------------------------------------------------------
# Colors only on a terminal, and never with NO_COLOR set.
setup_colors() {
  if [ -t 1 ] && [ -z "\${NO_COLOR:-}" ]; then
    BOLD=$(printf '\\033[1m'); DIM=$(printf '\\033[2m'); RED=$(printf '\\033[31m')
    GREEN=$(printf '\\033[32m'); YELLOW=$(printf '\\033[33m'); RESET=$(printf '\\033[0m')
  else
    BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
  fi
}
BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""

# step <n> <title>: a numbered step header; ok/warn/die: its result lines; detail: dim progress.
step() { printf '\\n%s[%s/7] %s%s\\n' "$BOLD" "$1" "$2" "$RESET"; }
ok() { printf '  %s✓%s %s\\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\\n' "$YELLOW" "$RESET" "$*"; }
detail() { printf '    %s%s%s\\n' "$DIM" "$*" "$RESET"; }
die() { printf '  %s✗ %s%s\\n' "$RED" "$*" "$RESET" >&2; exit 1; }
# show_lines: stdin indented and dimmed (log excerpts).
show_lines() { sed "s/^/    $DIM/; s/\\$/$RESET/"; }

have() { command -v "$1" >/dev/null 2>&1; }

# --- Downloads ----------------------------------------------------------------------------------
# fetch <url>: the body on stdout; fails on HTTP errors. Errors go to $JOIN_LOG.
fetch() {
  if have curl; then
    curl -fsSL --connect-timeout 20 "$1" 2>>"$JOIN_LOG"
  else
    wget -qO- -T 60 -t 2 "$1" 2>>"$JOIN_LOG"
  fi
}

# local_info: this machine's node's /cluster/info on one line (empty while it does not answer).
local_info() {
  url="http://127.0.0.1:$PORT/api/v1/cluster/info"
  if have curl; then
    curl -fsS --noproxy '*' -m 5 "$url" 2>/dev/null | tr -d '\\n' || true
  else
    wget -qO- --no-proxy -T 5 -t 1 "$url" 2>/dev/null | tr -d '\\n' || true
  fi
}

# json_value <json> <key>: the string/number/boolean value of a key that occurs once in a flat
# JSON document; empty when the key is missing or null. Enough for /cluster/info (no jq needed).
json_value() {
  value=$(printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\\{0,1\\}\\([^",}]*\\).*/\\1/p')
  [ "$value" = null ] && value=""
  printf '%s' "$value"
}

# file_sha256 <file>: hex sha256 of the file; empty when neither sha256sum nor shasum exists.
file_sha256() {
  if have sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# --- Arguments and settings ---------------------------------------------------------------------
parse_args() {
  TOKEN=""
  MODE=background
  for arg in "$@"; do
    case "$arg" in
      --service) MODE=service ;;
      --background) MODE=background ;;
      --foreground) MODE=foreground ;;
      -*) die "unknown option: $arg" ;;
      *) TOKEN="$arg" ;;
    esac
  done
  [ -n "$TOKEN" ] || die "usage: curl -fsSL $PRIMARY_URL/api/v1/cluster/join | sh -s -- <token> [--service|--foreground]"
  case "$TOKEN" in *[!A-Za-z0-9_-]*) die "the token has unexpected characters (copy it again from the primary)" ;; esac

  DIR="\${OMP_UI_NODE_DIR:-$HOME/.omp-ui-node}"
  PORT="\${OMP_UI_PORT:-3000}"
  CLUSTER_PORT="\${OMP_UI_CLUSTER_PORT:-}"
  case "$DIR" in /*) ;; *) die "OMP_UI_NODE_DIR must be an absolute path" ;; esac
  case "$DIR" in *[!A-Za-z0-9._/@+=:,~-]*) die "OMP_UI_NODE_DIR must not contain spaces, quotes or shell characters" ;; esac
  case "$PORT" in ''|*[!0-9]*) die "OMP_UI_PORT must be a port number" ;; esac
  case "$CLUSTER_PORT" in *[!0-9]*) die "OMP_UI_CLUSTER_PORT must be a port number" ;; esac

  OMP_DIR="$DIR/data/cluster/bin"
  PID_FILE="$DIR/omp-ui-node.pid"
  LOG_FILE="$DIR/omp-ui-node.log"
  ENV_FILE="$DIR/omp-ui-node.env"
  # Package manager and download output of this script (the node logs to $LOG_FILE).
  JOIN_LOG="$DIR/join.log"
  UNIT_FILE="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT.service"
}

header() {
  case "$MODE" in
    service) mode_text="systemd user service ($UNIT)" ;;
    foreground) mode_text="in this terminal" ;;
    *) mode_text="in the background" ;;
  esac
  printf '%somp-ui cluster node setup%s\\n' "$BOLD" "$RESET"
  printf '  primary  %s\\n' "$PRIMARY_URL"
  printf '  install  %s\\n' "$DIR"
  printf '  runs     %s\\n' "$mode_text"
  printf '  log      %s\\n' "$JOIN_LOG"
}

# --- 1. This machine ----------------------------------------------------------------------------
check_machine() {
  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) die "unsupported OS: $(uname -s) (Linux and macOS are supported)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "unsupported CPU architecture: $(uname -m) (x86_64 and arm64 are supported)" ;;
  esac
  if [ "$OS" = linux ] && is_musl; then
    die "musl-based Linux (Alpine) is not supported: the Node.js and omp binaries need glibc. Use a glibc distribution (Debian, Ubuntu, Fedora, ...)"
  fi
  ok "$OS-$ARCH"

  IS_ROOT=0
  CAN_ROOT=0
  if [ "$(id -u)" = 0 ]; then
    IS_ROOT=1
    CAN_ROOT=1
    ok "running as root"
  elif have sudo && sudo -n true </dev/null >/dev/null 2>&1; then
    CAN_ROOT=1
    ok "passwordless sudo is available"
  elif [ "$OS" = darwin ]; then
    ok "no root rights needed on macOS (packages come from Homebrew)"
  else
    warn "no root rights (not root, no passwordless sudo): missing system packages cannot be installed"
  fi
}

is_musl() {
  [ -f /etc/alpine-release ] && return 0
  ls /lib/ld-musl-* >/dev/null 2>&1 && return 0
  ldd --version 2>&1 | grep -qi musl
}

# --- 2. System packages -------------------------------------------------------------------------
# find_missing: REQUIRED (the script cannot go on without them) and OPTIONAL (agents need them).
find_missing() {
  REQUIRED=""
  OPTIONAL=""
  for cmd in tar gzip; do
    have "$cmd" || REQUIRED="$REQUIRED $cmd"
  done
  have curl || have wget || REQUIRED="$REQUIRED curl"
  [ "$OS" = darwin ] || has_ca_bundle || REQUIRED="$REQUIRED ca-certificates"
  have git || OPTIONAL="$OPTIONAL git"
  REQUIRED="\${REQUIRED# }"
  OPTIONAL="\${OPTIONAL# }"
}

# has_ca_bundle: one of the CA bundles the distributions install (HTTPS downloads need it).
has_ca_bundle() {
  for bundle in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt \\
    /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem; do
    [ -s "$bundle" ] && return 0
  done
  return 1
}

# detect_package_manager: PKG_MGR, PKG_UPDATE (may be empty) and PKG_INSTALL; PKG_MGR empty when none.
detect_package_manager() {
  PKG_MGR=""
  PKG_UPDATE=""
  PKG_INSTALL=""
  if [ "$OS" = darwin ]; then
    if have brew; then PKG_MGR=brew; PKG_INSTALL="brew install"; fi
  elif have apt-get; then
    PKG_MGR=apt-get; PKG_UPDATE="apt-get update"; PKG_INSTALL="apt-get install -y --no-install-recommends"
  elif have dnf; then
    PKG_MGR=dnf; PKG_INSTALL="dnf install -y"
  elif have yum; then
    PKG_MGR=yum; PKG_INSTALL="yum install -y"
  elif have microdnf; then
    PKG_MGR=microdnf; PKG_INSTALL="microdnf install -y"
  elif have zypper; then
    PKG_MGR=zypper; PKG_INSTALL="zypper -n install"
  elif have pacman; then
    PKG_MGR=pacman; PKG_INSTALL="pacman -Sy --noconfirm --needed"
  elif have apk; then
    die "Alpine (apk) is not supported: the Node.js and omp binaries need glibc"
  fi
}

# install_hint <packages>: the command to run by hand.
install_hint() {
  if [ -z "$PKG_MGR" ]; then
    if [ "$OS" = darwin ]; then
      printf 'install Homebrew (https://brew.sh) and run: brew install %s' "$1"
    else
      printf 'install %s with your package manager' "$1"
    fi
  elif [ "$PKG_MGR" = brew ]; then
    printf 'brew install %s' "$1"
  elif [ -n "$PKG_UPDATE" ]; then
    printf 'sudo %s && sudo %s %s' "$PKG_UPDATE" "$PKG_INSTALL" "$1"
  else
    printf 'sudo %s %s' "$PKG_INSTALL" "$1"
  fi
}

# as_pkg_user <command...>: as root (directly or with sudo -n), Homebrew as the current user.
as_pkg_user() {
  if [ "$PKG_MGR" = brew ] || [ "$IS_ROOT" = 1 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

# install_packages <packages...>: one package manager run (plus its index update). Word splitting
# of $PKG_UPDATE/$PKG_INSTALL is intended.
install_packages() {
  if [ -n "$PKG_UPDATE" ]; then
    as_pkg_user env DEBIAN_FRONTEND=noninteractive $PKG_UPDATE || return 1
  fi
  as_pkg_user env DEBIAN_FRONTEND=noninteractive $PKG_INSTALL "$@"
}

ensure_packages() {
  find_missing
  if [ -z "$REQUIRED$OPTIONAL" ]; then
    ok "tar, gzip, curl/wget, CA certificates and git are installed"
    return 0
  fi
  detect_package_manager
  wanted=$(echo $REQUIRED $OPTIONAL)
  if [ -n "$PKG_MGR" ] && { [ "$PKG_MGR" = brew ] || [ "$CAN_ROOT" = 1 ]; }; then
    detail "installing $wanted with $PKG_MGR"
    # stdin is this script when it is piped into sh: package managers must not read it.
    if install_packages $wanted >>"$JOIN_LOG" 2>&1 </dev/null; then
      ok "installed $wanted"
    else
      warn "$PKG_MGR failed (full output in $JOIN_LOG):"
      tail -n 10 "$JOIN_LOG" | show_lines
    fi
    find_missing
  fi
  if [ -n "$REQUIRED" ]; then
    if [ -n "$PKG_MGR" ] && [ "$CAN_ROOT" = 0 ] && [ "$PKG_MGR" != brew ]; then
      die "missing $REQUIRED and no root rights to install it; run: $(install_hint "$REQUIRED")"
    fi
    die "missing $REQUIRED; $(install_hint "$REQUIRED"), then run this command again"
  fi
  if [ -n "$OPTIONAL" ]; then
    warn "git is missing: agents need it ($(install_hint git))"
  else
    ok "tar, gzip, curl/wget, CA certificates and git are installed"
  fi
}

# --- 3. Primary ---------------------------------------------------------------------------------
check_primary() {
  INFO=$(fetch "$PRIMARY_URL/api/v1/cluster/info" | tr -d '\\n' || true)
  [ -n "$INFO" ] || die "cannot reach the primary at $PRIMARY_URL/api/v1/cluster/info (is omp-ui running there, and is the address reachable from this machine?)"
  PRIMARY_ROLE=$(json_value "$INFO" role)
  case "$PRIMARY_ROLE" in
    primary) ;;
    standalone) die "cluster mode is off on the primary: enable it in Settings → Cluster, then run this command again" ;;
    '') die "$PRIMARY_URL did not answer like an omp-ui server" ;;
    *) die "$PRIMARY_URL is a $PRIMARY_ROLE, not the primary: use the join command the primary shows" ;;
  esac
  PRIMARY_CLUSTER_PORT=$(json_value "$INFO" port)
  PRIMARY_PLATFORM=$(json_value "$INFO" platform)
  PRIMARY_ARCH=$(json_value "$INFO" arch)
  PRIMARY_OMP=$(json_value "$INFO" available)
  PRIMARY_OMP_SHA=$(json_value "$INFO" sha256)
  version=$(json_value "$INFO" nodeVersion)
  version="\${version#v}"
  [ -n "$version" ] && PRIMARY_NODE_VERSION="$version"
  ok "the primary answers with cluster mode on"
  detail "cluster port $PRIMARY_CLUSTER_PORT, $PRIMARY_PLATFORM-$PRIMARY_ARCH, Node.js $PRIMARY_NODE_VERSION"
}

# --- 4. Node.js ---------------------------------------------------------------------------------
# use_path_node: a node >= 24 on PATH that comes with npm.
use_path_node() {
  have node && have npm || return 1
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 24 ] 2>/dev/null || return 1
  NODE=$(command -v node)
  NODE_BIN_DIR=$(dirname "$NODE")
}

# install_node_dist: the official build (node, npm, npx, corepack) in $DIR/runtime/node; kept
# when an earlier run installed the same version.
install_node_dist() {
  dest="$DIR/runtime/node"
  name="node-v$PRIMARY_NODE_VERSION-$OS-$ARCH"
  if [ -x "$dest/bin/npm" ] && [ "$("$dest/bin/node" --version 2>/dev/null || true)" = "v$PRIMARY_NODE_VERSION" ]; then
    return 0
  fi
  tmp="$DIR/runtime/node.tmp"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  detail "downloading $name.tar.gz from nodejs.org"
  if ! fetch "https://nodejs.org/dist/v$PRIMARY_NODE_VERSION/$name.tar.gz" | tar -xzf - -C "$tmp" 2>>"$JOIN_LOG" ||
    [ ! -x "$tmp/$name/bin/node" ]; then
    rm -rf "$tmp"
    return 1
  fi
  "$tmp/$name/bin/node" --version >/dev/null 2>&1 ||
    die "Node.js $PRIMARY_NODE_VERSION from nodejs.org does not run on this machine (glibc too old?)"
  # Earlier versions of this script left a single binary at $dest.
  rm -rf "$dest"
  mv "$tmp/$name" "$dest" || return 1
  rm -rf "$tmp"
}

# install_primary_node: the primary's node binary alone (no npm), when it runs on this OS/CPU.
install_primary_node() {
  dest="$DIR/runtime/node"
  tmp="$DIR/runtime/node.tmp"
  rm -rf "$tmp"
  mkdir -p "$tmp/bin"
  detail "downloading the primary's Node.js binary"
  if fetch "$PRIMARY_URL/api/v1/cluster/runtime/node?platform=$OS&arch=$ARCH" |
    gzip -dc >"$tmp/bin/node" 2>>"$JOIN_LOG" && chmod 755 "$tmp/bin/node" &&
    "$tmp/bin/node" --version >/dev/null 2>&1; then
    rm -rf "$dest"
    mv "$tmp" "$dest" && return 0
  fi
  rm -rf "$tmp"
  return 1
}

ensure_node() {
  if use_path_node; then
    ok "Node.js $(node --version) from $NODE"
  else
    if install_node_dist; then
      :
    elif install_primary_node; then
      warn "nodejs.org is unreachable: installed the primary's Node.js binary without npm (agents that need npm will fail)"
    else
      die "cannot install Node.js: nodejs.org is unreachable and the primary's Node.js does not run here. Install Node.js >= 24 with npm, then run this command again"
    fi
    NODE="$DIR/runtime/node/bin/node"
    NODE_BIN_DIR="$DIR/runtime/node/bin"
    ok "Node.js $("$NODE" --version) in $DIR/runtime/node"
  fi
  npm_cmd="$NODE_BIN_DIR/npm"
  [ -x "$npm_cmd" ] || npm_cmd=$(command -v npm || true)
  NPM_VERSION=""
  if [ -n "$npm_cmd" ]; then
    NPM_VERSION=$(PATH="$NODE_BIN_DIR:$PATH" "$npm_cmd" --version 2>/dev/null </dev/null || true)
  fi
  if [ -n "$NPM_VERSION" ]; then ok "npm $NPM_VERSION"; fi
  # pnpm/yarn shims in $DIR/bin (on the node's PATH); Node.js 25+ no longer ships corepack.
  corepack_cmd="$NODE_BIN_DIR/corepack"
  [ -x "$corepack_cmd" ] || corepack_cmd=$(command -v corepack || true)
  if [ -n "$corepack_cmd" ]; then
    if PATH="$NODE_BIN_DIR:$PATH" "$corepack_cmd" enable --install-directory "$DIR/bin" </dev/null >>"$JOIN_LOG" 2>&1; then
      ok "pnpm and yarn (corepack)"
    else
      warn "corepack enable failed: pnpm and yarn are not set up (see $JOIN_LOG)"
    fi
  fi
}

# --- 5. omp -------------------------------------------------------------------------------------
# download_omp: the primary's omp as $OMP_DIR/omp-<sha256[0:12]> (where the node's server looks
# for it), verified against the sha256 from the primary's info; $OMP_DIR/omp points at it.
download_omp() {
  sha12=$(printf '%s' "$PRIMARY_OMP_SHA" | cut -c 1-12)
  target="$OMP_DIR/omp-$sha12"
  mkdir -p "$OMP_DIR"
  actual=""
  if [ -x "$target" ]; then actual=$(file_sha256 "$target"); fi
  if [ ! -x "$target" ] || { [ -n "$actual" ] && [ "$actual" != "$PRIMARY_OMP_SHA" ]; }; then
    tmp="$OMP_DIR/.omp-download.$$"
    detail "downloading omp from the primary"
    if ! fetch "$PRIMARY_URL/api/v1/cluster/runtime/omp" | gzip -dc >"$tmp" 2>>"$JOIN_LOG"; then
      rm -f "$tmp"
      return 1
    fi
    actual=$(file_sha256 "$tmp")
    if [ -z "$actual" ]; then
      warn "neither sha256sum nor shasum is installed: the omp download is not verified"
    elif [ "$actual" != "$PRIMARY_OMP_SHA" ]; then
      rm -f "$tmp"
      die "the omp download does not match the primary's sha256 ($actual != $PRIMARY_OMP_SHA)"
    fi
    chmod 755 "$tmp" || return 1
    mv -f "$tmp" "$target" || return 1
  fi
  # Swap the symlink atomically (rename over the old one).
  ln -sf "omp-$sha12" "$OMP_DIR/omp.new" || return 1
  mv -f "$OMP_DIR/omp.new" "$OMP_DIR/omp" || return 1
  OMP_CMD="$OMP_DIR/omp"
}

ensure_omp() {
  OMP_CMD=""
  OMP_VERSION=""
  if [ "$PRIMARY_OMP" != true ] || [ -z "$PRIMARY_OMP_SHA" ]; then
    missing="the primary has no omp to share"
  elif [ "$PRIMARY_PLATFORM" != "$OS" ] || [ "$PRIMARY_ARCH" != "$ARCH" ]; then
    missing="the primary's omp is for $PRIMARY_PLATFORM-$PRIMARY_ARCH"
  elif download_omp; then
    missing=""
  else
    missing="the primary's omp could not be downloaded"
  fi
  if [ -z "$OMP_CMD" ] && have omp; then
    OMP_CMD=$(command -v omp)
    detail "$missing; using the omp on PATH"
  fi
  if [ -z "$OMP_CMD" ]; then
    warn "$missing and no omp is on PATH: cards cannot run here until omp is installed (https://omp.sh)"
    return 0
  fi
  if output=$("$OMP_CMD" --version </dev/null 2>&1); then
    OMP_VERSION=$(printf '%s\\n' "$output" | head -n 1)
    case "$OMP_VERSION" in omp*) ok "$OMP_VERSION" ;; *) ok "omp $OMP_VERSION" ;; esac
    detail "$OMP_CMD"
  else
    warn "$OMP_CMD does not run here ($(printf '%s\\n' "$output" | head -n 1)): cards cannot run until a working omp is installed"
  fi
}

# --- 6. App and configuration -------------------------------------------------------------------
# Stop a node started by an earlier run of this script.
stop_running_node() {
  if [ -f "$PID_FILE" ]; then
    old_pid=$(cat "$PID_FILE")
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      detail "stopping the node started earlier (pid $old_pid)"
      kill "$old_pid"
      i=0
      while kill -0 "$old_pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
    fi
    rm -f "$PID_FILE"
  fi
  if have systemctl && systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
    detail "stopping the $UNIT service"
    systemctl --user stop "$UNIT"
  fi
}

# port_answers: whether a server answers on the node's web port.
port_answers() {
  url="http://127.0.0.1:$PORT/"
  rc=0
  if have curl; then
    # 0: an HTTP answer, 52: an empty reply; 7 (refused) means the port is free.
    curl -s -o /dev/null --noproxy '*' -m 5 "$url" 2>/dev/null || rc=$?
    [ "$rc" = 0 ] || [ "$rc" = 52 ]
  else
    # 0: a success, 8: an HTTP error status; both mean a server answered.
    wget -q -O /dev/null --no-proxy -T 5 -t 1 "$url" 2>/dev/null || rc=$?
    [ "$rc" = 0 ] || [ "$rc" = 8 ]
  fi
}

# check_port: nothing else may answer on the node's web port (the node would fail to listen). A
# node stopped just before may take a few seconds to let go of it.
check_port() {
  i=0
  while port_answers; do
    i=$((i + 1))
    if [ "$i" -ge 10 ]; then
      die "port $PORT is already in use on this machine: stop that server or choose another port (OMP_UI_PORT=<port>)"
    fi
    sleep 1
  done
}

install_app() {
  detail "downloading omp-ui from the primary"
  rm -rf "$DIR/app.new"
  mkdir -p "$DIR/app.new"
  fetch "$PRIMARY_URL/api/v1/cluster/bundle" | tar -xzf - -C "$DIR/app.new" 2>>"$JOIN_LOG" ||
    die "downloading the app bundle from the primary failed (see $JOIN_LOG)"
  if [ ! -f "$DIR/app.new/server.js" ] || [ ! -f "$DIR/app.new/bin/supervisor.mjs" ]; then
    die "the app bundle from the primary is incomplete"
  fi
  rm -rf "$DIR/app.old"
  if [ -d "$DIR/app" ]; then mv "$DIR/app" "$DIR/app.old"; fi
  mv "$DIR/app.new" "$DIR/app"
  rm -rf "$DIR/app.old"
  ok "omp-ui in $DIR/app"
}

# node_path <PATH>: the entries that are safe in the env file (sourced by sh, read by systemd),
# without duplicates. Entries with spaces or shell characters are left out.
node_path() {
  result=""
  set -f
  old_ifs=$IFS
  IFS=:
  for entry in $1; do
    case "$entry" in ''|*[!A-Za-z0-9._/@+=,~-]*) continue ;; esac
    case ":$result:" in *":$entry:"*) continue ;; esac
    result="$result:$entry"
  done
  IFS=$old_ifs
  set +f
  printf '%s' "\${result#:}"
}

# The configuration the server reads (mode 600: it holds the token). A new join id per run makes
# the server join again even when it was a member before; a plain restart never re-joins.
write_env() {
  join_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')
  [ -n "$join_id" ] || die "cannot read /dev/urandom"
  node_env_path=$(node_path "$OMP_DIR:$DIR/bin:$NODE_BIN_DIR:\${PATH:-/usr/local/bin:/usr/bin:/bin}")
  umask 077
  {
    echo "NODE_ENV=production"
    echo "HOST=0.0.0.0"
    echo "PORT=$PORT"
    echo "DATA_DIR=$DIR/data"
    echo "PATH=$node_env_path"
    echo "OMP_UI_CLUSTER_JOIN=$PRIMARY_URL"
    echo "OMP_UI_CLUSTER_TOKEN=$TOKEN"
    echo "OMP_UI_CLUSTER_JOIN_ID=$join_id"
    if [ -n "$CLUSTER_PORT" ]; then echo "OMP_UI_CLUSTER_PORT=$CLUSTER_PORT"; fi
  } >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "configuration in $ENV_FILE"
}

# --- 7. Start and verify ------------------------------------------------------------------------
# alive <pid>: whether the process runs. A child of this shell that exited stays a zombie until it
# is reaped, and kill -0 still succeeds for it: Linux shows the state in /proc.
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/stat" ]; then
    case "$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d ' ' -f 1)" in Z) return 1 ;; esac
  fi
  return 0
}

# node_log: what the node logged since this run started it: background mode from line $LOG_START
# of $LOG_FILE, service mode the unit's journal since $LOG_SINCE; nothing in the foreground (the
# node's output is on the terminal already).
node_log() {
  if [ -n "\${LOG_START:-}" ]; then
    tail -n +"$LOG_START" "$LOG_FILE" 2>/dev/null || true
  elif [ -n "\${LOG_SINCE:-}" ]; then
    journalctl --user -u "$UNIT" --since "@$LOG_SINCE" -o cat --no-pager 2>/dev/null || true
  fi
}

# wait_ready <pid>: 0 once the node's info route says it is a replica connected to the primary (a
# replica alone is not enough: one the primary does not welcome keeps reconnecting); 1 after
# $READY_TIMEOUT s; 2 when process <pid> (the supervisor; may be empty) exits first; 3 when the
# node logged that it could not join (see node_log; the reason is in $JOIN_ERROR), checked before
# the ready test and after reading the info: a replica that cannot join this cluster keeps running
# and reconnects to its old primary, and it logs the error before it can connect. Every 15 s it
# shows the node's role and link state ($NODE_STATE, kept for not_ready) and its latest [cluster]
# log line when that is new.
wait_ready() {
  watch_pid=$1
  started=$(date +%s)
  next_report=15
  last_shown=""
  NODE_STATE=""
  while :; do
    info=$(local_info)
    JOIN_ERROR=$(node_log | grep -m 1 'Could not join the cluster' | sed 's/^.*Could not join/Could not join/' || true)
    if [ -n "$JOIN_ERROR" ]; then return 3; fi
    role=$(json_value "$info" role)
    connection=$(json_value "$info" connection)
    if [ "$role" = replica ] && [ "$connection" = connected ]; then return 0; fi
    NODE_STATE="$role\${connection:+, $connection}"
    if [ -n "$watch_pid" ] && ! alive "$watch_pid"; then return 2; fi
    elapsed=$(($(date +%s) - started))
    if [ "$elapsed" -ge "$READY_TIMEOUT" ]; then return 1; fi
    if [ "$elapsed" -ge "$next_report" ]; then
      detail "waiting for the node to join the cluster ($elapsed s, node: \${NODE_STATE:-not answering yet})"
      last=$(node_log | grep -F '[cluster] ' | tail -n 1 || true)
      if [ -n "$last" ] && [ "$last" != "$last_shown" ]; then
        detail "  last: $last"
        last_shown=$last
      fi
      next_report=$((next_report + 15))
    fi
    sleep 2
  done
}

# How to read the node's log, stop it and remove it, per mode.
mode_commands() {
  case "$MODE" in
    service)
      LOGS_CMD="journalctl --user -u $UNIT -f"
      STOP_CMD="systemctl --user stop $UNIT"
      UNINSTALL_CMD="systemctl --user disable --now $UNIT && rm -f $UNIT_FILE && rm -rf $DIR"
      ;;
    background)
      LOGS_CMD="tail -f $LOG_FILE"
      STOP_CMD="kill \\$(cat $PID_FILE)"
      UNINSTALL_CMD="kill \\$(cat $PID_FILE); rm -rf $DIR"
      ;;
    *)
      LOGS_CMD="(this terminal)"
      STOP_CMD="Ctrl+C"
      UNINSTALL_CMD="stop it, then rm -rf $DIR"
      ;;
  esac
}

report_ready() {
  mode_commands
  git_version=$(git --version 2>/dev/null | sed 's/^git version //' || true)
  host=$(uname -n 2>/dev/null || echo localhost)
  ok "joined the cluster"
  printf '\\n%s%s✓ This machine is ready as a cluster node.%s\\n' "$BOLD" "$GREEN" "$RESET"
  printf '  node       %s  (http://%s:%s)\\n' "$host" "$host" "$PORT"
  printf '  primary    %s\\n' "$PRIMARY_URL"
  printf '  Node.js    %s\\n' "$("$NODE" --version)"
  printf '  npm        %s\\n' "\${NPM_VERSION:-not installed}"
  printf '  omp        %s\\n' "\${OMP_VERSION:-not installed (cards cannot run here)}"
  printf '  git        %s\\n' "\${git_version:-not installed (agents need it)}"
  printf '  logs       %s\\n' "$LOGS_CMD"
  printf '  stop       %s\\n' "$STOP_CMD"
  printf '  uninstall  %s\\n' "$UNINSTALL_CMD"
}

# not_ready <wait_ready status> <pid>: explain, show the end of the node's log, stop the node
# this run started, fail.
not_ready() {
  if [ "$1" = 3 ]; then
    printf '  %s✗ %s%s\\n' "$RED" "$JOIN_ERROR" "$RESET" >&2
  elif [ "$1" = 2 ]; then
    printf '  %s✗ the node stopped before it joined the cluster%s\\n' "$RED" "$RESET" >&2
  else
    printf '  %s✗ the node did not join the cluster within %s s%s%s\\n' "$RED" "$READY_TIMEOUT" "\${NODE_STATE:+ (node: $NODE_STATE)}" "$RESET" >&2
  fi
  case "$MODE" in
    service)
      printf '    last log lines (journalctl --user -u %s):\\n' "$UNIT" >&2
      journalctl --user -u "$UNIT" -n 30 --no-pager 2>&1 | show_lines >&2 || true
      ;;
    background)
      printf '    last log lines (%s):\\n' "$LOG_FILE" >&2
      tail -n 30 "$LOG_FILE" 2>&1 | show_lines >&2 || true
      ;;
    *) printf '    see the node output above\\n' >&2 ;;
  esac
  printf '    hints: this machine must reach %s and port %s on the primary host;\\n' "$PRIMARY_URL" "$PRIMARY_CLUSTER_PORT" >&2
  printf '           a used or expired token needs a new join command from the primary (Settings → Cluster)\\n' >&2
  case "$MODE" in
    service) systemctl --user stop "$UNIT" 2>/dev/null || true ;;
    *)
      if [ -n "$2" ]; then kill "$2" 2>/dev/null || true; fi
      rm -f "$PID_FILE"
      ;;
  esac
  printf '    the node was stopped; run the join command again once the cause is fixed\\n' >&2
  exit 1
}

start_node() {
  supervisor="$DIR/app/bin/supervisor.mjs"
  server="$DIR/app/server.js"
  cd "$DIR/app"
  # bin/supervisor.mjs <node> <server.js> restarts the server when it exits or hangs.
  case "$MODE" in
    service)
      have systemctl || die "--service needs systemd (systemctl); run without --service to start the node in the background"
      mkdir -p "$(dirname "$UNIT_FILE")"
      cat >"$UNIT_FILE" <<EOF
[Unit]
Description=omp-ui cluster node (primary: $PRIMARY_URL)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR/app
EnvironmentFile=$ENV_FILE
ExecStart=$NODE $supervisor $NODE $server
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload >>"$JOIN_LOG" 2>&1
      # The journal from here on is this run's node (node_log).
      LOG_SINCE=$(date +%s)
      systemctl --user enable --now "$UNIT" </dev/null >>"$JOIN_LOG" 2>&1 ||
        die "systemctl --user enable --now $UNIT failed (see $JOIN_LOG)"
      ok "started the $UNIT service"
      detail "to keep it running after you log out: sudo loginctl enable-linger $(id -un)"
      rc=0
      wait_ready "" || rc=$?
      if [ "$rc" != 0 ]; then not_ready "$rc" ""; fi
      report_ready
      ;;
    background)
      set -a
      . "$ENV_FILE"
      set +a
      printf '\\n--- started by the join script, %s\\n' "$(date)" >>"$LOG_FILE"
      LOG_START=$(wc -l <"$LOG_FILE")
      nohup "$NODE" "$supervisor" "$NODE" "$server" >>"$LOG_FILE" 2>&1 </dev/null &
      node_pid=$!
      echo "$node_pid" >"$PID_FILE"
      ok "started in the background (pid $node_pid)"
      rc=0
      wait_ready "$node_pid" || rc=$?
      if [ "$rc" != 0 ]; then not_ready "$rc" "$node_pid"; fi
      report_ready
      ;;
    *)
      set -a
      . "$ENV_FILE"
      set +a
      ok "starting the node on port $PORT in this terminal (Ctrl+C stops it)"
      # The readiness check runs next to the node and prints its result into the node's output;
      # $$ is this shell, which exec turns into the supervisor.
      (
        rc=0
        wait_ready "$$" || rc=$?
        if [ "$rc" != 0 ]; then not_ready "$rc" "$$"; fi
        report_ready
      ) &
      exec "$NODE" "$supervisor" "$NODE" "$server"
      ;;
  esac
}

main() {
  setup_colors
  parse_args "$@"
  header
  mkdir -p "$DIR/runtime" "$DIR/data" "$DIR/bin"
  chmod 700 "$DIR"
  printf '# omp-ui join %s\\n' "$(date)" >"$JOIN_LOG"
  step 1 "Checking this machine"
  check_machine
  step 2 "Installing system packages"
  ensure_packages
  step 3 "Checking the primary"
  check_primary
  step 4 "Installing Node.js"
  ensure_node
  step 5 "Installing omp"
  ensure_omp
  step 6 "Installing omp-ui"
  stop_running_node
  check_port
  install_app
  write_env
  step 7 "Starting the node"
  start_node
}

main "$@"
`;
}
