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
/** Scripts next to server.js the node starts with (bin/supervisor.mjs imports bin/agentmemory.mjs). */
const BIN_SCRIPTS = ["supervisor.mjs", "agentmemory.mjs"];

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
 * plus bin/supervisor.mjs and bin/agentmemory.mjs, streamed from `tar` (length unknown). 404 when
 * this server has no build.
 */
export async function bundleResponse(): Promise<Response> {
  const app = appDir();
  if (!app) throw new HttpError(404, "This server has no app build (dist/standalone/server.js) to share");
  const bin = binParent(app);
  if (!bin) throw new HttpError(404, "bin/supervisor.mjs and bin/agentmemory.mjs were not found next to the app");
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
 * runs. `baseUrl` (from requestBaseUrl: scheme://host[:port] only) and this server's Node version
 * are baked in; the token is the script's argument and never part of it.
 */
export function joinScript(baseUrl: string): string {
  const nodeVersion = process.versions.node;
  return `#!/bin/sh
# Joins this machine to the omp-ui cluster whose primary is ${baseUrl} (script generated by it).
#
#   curl -fsSL ${baseUrl}/api/v1/cluster/join | sh -s -- <token> [--service|--background]
#
# Installs Node.js (when no node >= 24 is on PATH) and the primary's omp-ui build into
# $OMP_UI_NODE_DIR, then starts the node: in the foreground (default), in the background with
# nohup (--background), or as a systemd user service (--service, Linux). The node joins the
# cluster on its first start and gets omp, its config and credentials from the primary.
#
# Environment: OMP_UI_NODE_DIR  install dir (default ~/.omp-ui-node)
#              OMP_UI_PORT      web port of the node (default 3000)
#              OMP_UI_CLUSTER_PORT  cluster channel port of the node (default 7790)
set -eu

PRIMARY_URL='${baseUrl}'
PRIMARY_NODE_VERSION='${nodeVersion}'
UNIT=omp-ui-node

say() { printf '[omp-ui join] %s\\n' "$*"; }
die() { printf '[omp-ui join] error: %s\\n' "$*" >&2; exit 1; }

TOKEN=""
MODE=foreground
for arg in "$@"; do
  case "$arg" in
    --service) MODE=service ;;
    --background) MODE=background ;;
    --foreground) MODE=foreground ;;
    -*) die "unknown option: $arg" ;;
    *) TOKEN="$arg" ;;
  esac
done
[ -n "$TOKEN" ] || die "usage: curl -fsSL $PRIMARY_URL/api/v1/cluster/join | sh -s -- <token> [--service|--background]"
case "$TOKEN" in *[!A-Za-z0-9_-]*) die "the token has unexpected characters (copy it again from the primary)" ;; esac

DIR="\${OMP_UI_NODE_DIR:-$HOME/.omp-ui-node}"
PORT="\${OMP_UI_PORT:-3000}"
CLUSTER_PORT="\${OMP_UI_CLUSTER_PORT:-}"
case "$DIR" in /*) ;; *) die "OMP_UI_NODE_DIR must be an absolute path" ;; esac
case "$DIR" in *[!A-Za-z0-9._/@+=:,~-]*) die "OMP_UI_NODE_DIR must not contain spaces, quotes or shell characters" ;; esac
case "$PORT" in ''|*[!0-9]*) die "OMP_UI_PORT must be a port number" ;; esac
case "$CLUSTER_PORT" in *[!0-9]*) die "OMP_UI_CLUSTER_PORT must be a port number" ;; esac

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "unsupported OS: $(uname -s) (Linux and macOS are supported)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- "$1"; }
else
  die "curl or wget is required"
fi

say "Installing an omp-ui cluster node in $DIR ($OS-$ARCH), primary: $PRIMARY_URL"
mkdir -p "$DIR/runtime" "$DIR/data"
chmod 700 "$DIR"

# --- Node.js ------------------------------------------------------------------------------------
NODE=""
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 24 ] 2>/dev/null; then
    NODE=$(command -v node)
    say "Using Node.js $(node --version) from $NODE"
  fi
fi
if [ -z "$NODE" ]; then
  TMP_NODE="$DIR/runtime/node.tmp"
  rm -f "$TMP_NODE"
  say "Downloading Node.js from the primary"
  if fetch "$PRIMARY_URL/api/v1/cluster/runtime/node?platform=$OS&arch=$ARCH" 2>/dev/null | gzip -dc > "$TMP_NODE" 2>/dev/null &&
    chmod 755 "$TMP_NODE" && "$TMP_NODE" --version >/dev/null 2>&1; then
    :
  else
    NAME="node-v$PRIMARY_NODE_VERSION-$OS-$ARCH"
    say "The primary's Node.js does not run here; downloading $NAME from nodejs.org"
    command -v xz >/dev/null 2>&1 || die "xz is required to unpack Node.js (or install Node.js >= 24 yourself)"
    rm -rf "$DIR/runtime/$NAME"
    fetch "https://nodejs.org/dist/v$PRIMARY_NODE_VERSION/$NAME.tar.xz" | xz -dc | tar -xf - -C "$DIR/runtime"
    cp "$DIR/runtime/$NAME/bin/node" "$TMP_NODE"
    rm -rf "$DIR/runtime/$NAME"
    chmod 755 "$TMP_NODE"
  fi
  mv -f "$TMP_NODE" "$DIR/runtime/node"
  NODE="$DIR/runtime/node"
  say "Installed Node.js $("$NODE" --version) in $NODE"
fi

# --- Stop a node started by an earlier run of this script -----------------------------------------
PID_FILE="$DIR/omp-ui-node.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    say "Stopping the running node (pid $OLD_PID)"
    kill "$OLD_PID"
    i=0
    while kill -0 "$OLD_PID" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
  fi
  rm -f "$PID_FILE"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
  say "Stopping the running $UNIT service"
  systemctl --user stop "$UNIT"
fi

# --- App ----------------------------------------------------------------------------------------
say "Downloading omp-ui from the primary"
rm -rf "$DIR/app.new"
mkdir -p "$DIR/app.new"
fetch "$PRIMARY_URL/api/v1/cluster/bundle" | tar -xzf - -C "$DIR/app.new"
if [ ! -f "$DIR/app.new/server.js" ] || [ ! -f "$DIR/app.new/bin/supervisor.mjs" ]; then
  die "the app bundle from the primary is incomplete"
fi
rm -rf "$DIR/app.old"
if [ -d "$DIR/app" ]; then mv "$DIR/app" "$DIR/app.old"; fi
mv "$DIR/app.new" "$DIR/app"
rm -rf "$DIR/app.old"

# --- Configuration (read by the server; the token stays in this file, mode 600) -----------------
ENV_FILE="$DIR/omp-ui-node.env"
umask 077
{
  echo "NODE_ENV=production"
  echo "HOST=0.0.0.0"
  echo "PORT=$PORT"
  echo "DATA_DIR=$DIR/data"
  echo "OMP_UI_CLUSTER_JOIN=$PRIMARY_URL"
  echo "OMP_UI_CLUSTER_TOKEN=$TOKEN"
  if [ -n "$CLUSTER_PORT" ]; then echo "OMP_UI_CLUSTER_PORT=$CLUSTER_PORT"; fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
say "Wrote $ENV_FILE"

# --- Start: bin/supervisor.mjs <node> <server.js> restarts the server when it exits or hangs -----
SUPERVISOR="$DIR/app/bin/supervisor.mjs"
SERVER="$DIR/app/server.js"
cd "$DIR/app"
case "$MODE" in
  service)
    command -v systemctl >/dev/null 2>&1 || die "--service needs systemd (systemctl); use --background instead"
    UNIT_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/$UNIT.service" <<EOF
[Unit]
Description=omp-ui cluster node (primary: $PRIMARY_URL)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR/app
EnvironmentFile=$ENV_FILE
ExecStart=$NODE $SUPERVISOR $NODE $SERVER
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    say "Installed $UNIT_DIR/$UNIT.service"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT"
    say "Started. Status: systemctl --user status $UNIT   Logs: journalctl --user -u $UNIT -f"
    say "To keep it running after you log out: sudo loginctl enable-linger $(id -un)"
    ;;
  background)
    set -a
    . "$ENV_FILE"
    set +a
    LOG_FILE="$DIR/omp-ui-node.log"
    nohup "$NODE" "$SUPERVISOR" "$NODE" "$SERVER" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    say "Started in the background (pid $!). Log: $LOG_FILE   Stop: kill $!"
    ;;
  *)
    set -a
    . "$ENV_FILE"
    set +a
    say "Starting the node on port $PORT (Ctrl+C stops it)"
    exec "$NODE" "$SUPERVISOR" "$NODE" "$SERVER"
    ;;
esac
`;
}
