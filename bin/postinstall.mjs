#!/usr/bin/env node
// After `npm i -g omp-ui`: make `omp-ui` runnable from the user's terminal right away.
// npm links the command into `<prefix>/bin`, which some setups (e.g. Homebrew's keg-only node@22)
// don't put on PATH. An install script can't change the parent shell's environment, so we link the
// command into a folder that is already on PATH; failing that, add the bin folder to the shell's rc file.
// Never fails the install.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./omp-ui.mjs", import.meta.url));
const MARK = "# added by omp-ui";

/** The terminal's PATH: npm only prepends node_modules/.bin folders and node-gyp-bin for scripts. */
export function userPath(envPath = process.env.PATH ?? "") {
  return envPath.split(path.delimiter).filter((p) => p && !/node_modules[\\/]\.bin$/.test(p) && !/node-gyp-bin$/.test(p));
}

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Link `omp-ui` into the first writable PATH folder (preferring the usual user bin folders). */
function linkIntoPath(dirs) {
  const home = os.homedir();
  const preferred = ["/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin"), path.join(home, "bin")];
  const candidates = [...preferred.filter((d) => dirs.includes(d)), ...dirs.filter((d) => d.startsWith(home))];
  for (const dir of candidates) {
    if (!writable(dir)) continue;
    const link = path.join(dir, "omp-ui");
    try {
      const existing = fs.lstatSync(link, { throwIfNoEntry: false });
      // Only replace our own (possibly stale) link, never someone else's file.
      if (existing && !(existing.isSymbolicLink() && fs.readlinkSync(link).includes("omp-ui"))) continue;
      if (existing) fs.unlinkSync(link);
      fs.symlinkSync(CLI, link);
      return link;
    } catch {
      // try the next folder
    }
  }
  return null;
}

/** The one-liner that adds the bin folder to the user's shell config and reloads it. */
export function pathCommand(binDir, shell = path.basename(process.env.SHELL ?? "")) {
  if (shell === "fish") return `fish_add_path ${binDir}`;
  const rc = shell === "bash" ? "~/.bashrc" : "~/.zshrc";
  return `echo 'export PATH="${binDir}:$PATH"  ${MARK}' >> ${rc} && source ${rc}`;
}

/** npm hides install-script output, so talk to the terminal directly when there is one. */
function tell(text) {
  try {
    const fd = fs.openSync("/dev/tty", "w");
    fs.writeSync(fd, `${text}\n`);
    fs.closeSync(fd);
  } catch {
    console.log(text);
  }
}

function main() {
  if (process.env.npm_config_global !== "true" || process.platform === "win32") return;
  const prefix = process.env.npm_config_prefix;
  if (!prefix) return;
  const binDir = path.join(prefix, "bin");
  const dirs = userPath();
  if (dirs.includes(binDir)) return;

  const link = linkIntoPath(dirs);
  const lines = [
    "",
    "  omp-ui is installed, but npm's global bin folder is not on your PATH:",
    `    ${binDir}`,
    "",
    link ? `  We linked ${link}, so ${"`omp-ui`"} should already work. To add the folder for good, run:` : "  Run this once to add it and reload your shell:",
    "",
    `    ${pathCommand(binDir)}`,
    "",
    "  Then start OMP-UI:  omp-ui",
    "",
  ];
  tell(lines.join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.warn(`omp-ui: could not add the command to PATH (${err.message}). Add "$(npm prefix -g)/bin" to PATH yourself.`);
  }
}
