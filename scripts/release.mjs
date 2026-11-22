#!/usr/bin/env node
// Bump the version, date the CHANGELOG's Unreleased section, commit and push to main.
// The push runs .github/workflows/release.yml, which creates the GitHub release and publishes to npm.
// Usage: pnpm release [patch|minor|major|<x.y.z>]   (default: patch)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const sh = (cmd, ...args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const bump = process.argv[2] ?? "patch";

if (sh("git", "rev-parse", "--abbrev-ref", "HEAD") !== "main") throw new Error("Release from main.");
if (sh("git", "status", "--porcelain", "--untracked-files=no")) throw new Error("Commit or stash your changes first.");
sh("git", "pull", "--ff-only", "origin", "main");

const version = sh("npm", "version", bump, "--no-git-tag-version").replace(/^v/, "");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const date = new Date().toISOString().slice(0, 10);
writeFileSync("CHANGELOG.md", changelog.replace("## [Unreleased]", `## [Unreleased]\n\n## [${version}] - ${date}`));

// `npm version` also bumps package-lock.json when the repo tracks one.
sh("git", "add", "package.json", "CHANGELOG.md", ...(sh("git", "ls-files", "package-lock.json") ? ["package-lock.json"] : []));
sh("git", "commit", "-m", `Release ${version}`);
sh("git", "push", "origin", "main");
console.log(`Pushed ${version}. Follow the release: gh run watch --repo quangpl/omp-ui`);
