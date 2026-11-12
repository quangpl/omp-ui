// PM2 config for OMP UI — works on a fresh clone:
//   pm2 start ecosystem.config.cjs        (or: omp-ui pm2 start)
//
// The app is `omp-ui up --foreground`: first run creates .env (prints a generated
// admin password to data/pm2-out.log unless ADMIN_PASSWORD is set), installs
// dependencies, builds when sources changed, then runs the server attached so
// pm2 supervises it. The server inherits the full environment; .env overrides it.
const fs = require("node:fs");
const path = require("node:path");

const logDir = path.join(__dirname, "data");
fs.mkdirSync(logDir, { recursive: true });

module.exports = {
  apps: [
    {
      name: "omp-ui",
      cwd: __dirname,
      script: "bin/omp-ui.mjs",
      args: "up --foreground",
      interpreter: "node",
      // Single process: agents and their state live in-process.
      exec_mode: "fork",
      // pm2 restarts the CLI if it dies; inside it, bin/supervisor.mjs restarts a server that
      // crashes or stops answering /api/v1/health, which pm2 cannot see.
      autorestart: true,
      max_restarts: 50,
      min_uptime: "30s",
      // 1 s, then doubling up to 15 s while it keeps failing; reset once it stays up.
      exp_backoff_restart_delay: 1000,
      // The CLI forwards SIGTERM to the server and waits for its graceful drain.
      kill_signal: "SIGTERM",
      kill_timeout: 15000,
      treekill: false,
      time: true,
      // One file per stream (no "-<id>" suffix), so the paths below are exact.
      merge_logs: true,
      out_file: path.join(logDir, "pm2-out.log"),
      error_file: path.join(logDir, "pm2-error.log"),
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
