// Cluster folder sync (lib/cluster/sync.ts): path mapping, manifests, down/up pushes between two
// SyncEndpoints over an in-memory channel, the receiver's safety rules (deny-list, path
// validation, symlinked parents), worktree pointer rewriting, and SQLite snapshots.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { channelPair, type FakeChannel } from "./fake-channel";

import { mirrorPath } from "@/lib/cluster/paths";
import { gitCommonDirs, PathMap, scanFolder, snapshotSqlite, SyncEndpoint } from "@/lib/cluster/sync";
import type { SyncFolderSpec, WireMessage } from "@/lib/cluster/types";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "omp-ui-sync-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).trim();
}

/** Write `content` at `root/rel` (parents created), optionally with a fixed mtime. */
function put(root: string, rel: string, content: string | Buffer, mtimeMs?: number): string {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

interface Cluster {
  /** Primary end of the channel (counts what the primary sent). */
  a: FakeChannel;
  /** Node end of the channel. */
  b: FakeChannel;
  primary: SyncEndpoint;
  node: SyncEndpoint;
}

/** A primary and a node endpoint that both accept `run:` pushes of `specs`. */
function cluster(specs: SyncFolderSpec[]): Cluster {
  const [a, b] = channelPair();
  const primary = new SyncEndpoint(a, "primary");
  const node = new SyncEndpoint(b, "node");
  primary.receive("run:", { folders: () => specs });
  node.receive("run:", { folders: () => specs });
  cleanups.push(() => {
    primary.close();
    node.close();
    a.close();
  });
  return { a, b, primary, node };
}

function rawSpec(id: string, primaryPath: string, nodePath: string): SyncFolderSpec {
  return { id, primaryPath, nodePath, kind: "raw", upstream: true };
}

function mapOf(specs: SyncFolderSpec[]): PathMap {
  return new PathMap(specs.map((spec) => [spec.primaryPath, spec.nodePath]));
}

describe("PathMap", () => {
  const map = new PathMap([
    ["/a/b", "/n/a/b"],
    ["/a/b/deep", "/d"],
  ]);

  it("maps single paths by longest prefix, in both directions", () => {
    expect(map.pathToNode("/a/b")).toBe("/n/a/b");
    expect(map.pathToNode("/a/b/x/y")).toBe("/n/a/b/x/y");
    expect(map.pathToNode("/a/b/deep/f")).toBe("/d/f");
    expect(map.pathToNode("/a/bc")).toBe("/a/bc");
    expect(map.pathToNode("/other")).toBe("/other");
    expect(map.pathToPrimary("/n/a/b/x")).toBe("/a/b/x");
    expect(map.pathToPrimary("/d")).toBe("/a/b/deep");
    expect(map.pathToPrimary("/a/b/x")).toBe("/a/b/x");
  });

  it("rewrites free text only at path boundaries", () => {
    expect(map.toNode("cd /a/b && ls /a/bc /a/b.txt /x/a/b /a/b/src:12 '/a/b' /a/bé")).toBe(
      "cd /n/a/b && ls /a/bc /a/b.txt /x/a/b /n/a/b/src:12 '/n/a/b' /a/bé",
    );
    expect(map.toNode("/a/b")).toBe("/n/a/b");
    expect(map.toNode("no paths here")).toBe("no paths here");
  });

  it("rewrites paths inside JSON strings and back", () => {
    const line = JSON.stringify({ cwd: "/a/b", files: ["/a/b/deep/x.ts", "/a/bc/y"], url: "file:///a/b/z" });
    const mapped = map.toNode(line);
    expect(JSON.parse(mapped)).toEqual({ cwd: "/n/a/b", files: ["/d/x.ts", "/a/bc/y"], url: "file:///n/a/b/z" });
    expect(map.toPrimary(mapped)).toBe(line);
  });

  it("never maps a path twice", () => {
    const mirror = new PathMap([["/home/u/proj", "/data/mirror/home/u/proj"]]);
    const once = mirror.toNode("open /home/u/proj/a.ts");
    expect(once).toBe("open /data/mirror/home/u/proj/a.ts");
    expect(mirror.toNode(once)).toBe(once);
    expect(mirror.toPrimary(once)).toBe("open /home/u/proj/a.ts");

    // The node's mirror lies below the mapped primary folder itself.
    const nested = new PathMap([["/w", "/w/omp-ui/data/cluster/mirror/w"]]);
    const mapped = nested.toNode("edit /w/x.ts");
    expect(mapped).toBe("edit /w/omp-ui/data/cluster/mirror/w/x.ts");
    expect(nested.toNode(mapped)).toBe(mapped);
    expect(nested.pathToNode("/w/omp-ui/data/cluster/mirror/w/x.ts")).toBe("/w/omp-ui/data/cluster/mirror/w/x.ts");
    expect(nested.toPrimary(mapped)).toBe("edit /w/x.ts");
  });

  it("identity maps nothing", () => {
    expect(PathMap.identity().pairs).toEqual([]);
    expect(PathMap.identity().toNode("/a/b")).toBe("/a/b");
    expect(new PathMap([["/same", "/same/"]]).pairs).toEqual([]);
  });
});

describe("scanFolder", () => {
  it("lists a git work tree: tracked + untracked, not ignored, plus .git without locks", async () => {
    const root = await tempDir();
    git(root, "init", "-b", "main");
    put(root, ".gitignore", "ignored.log\nnode_modules/\n");
    put(root, "tracked.txt", "tracked");
    chmodSync(put(root, "run.sh", "#!/bin/sh\n"), 0o755);
    git(root, "add", ".");
    git(root, "commit", "-m", "init");
    put(root, "untracked.txt", "new");
    put(root, "ignored.log", "noise");
    put(root, "node_modules/pkg/index.js", "module.exports = 1;");
    put(root, ".git/index.lock", "");
    symlinkSync("tracked.txt", path.join(root, "link"));

    const entries = await scanFolder(root, "tree");
    const paths = entries.map((entry) => entry.p);
    expect(paths).toEqual([...paths].sort());
    for (const rel of [".gitignore", "tracked.txt", "run.sh", "untracked.txt", "link", ".git/HEAD"]) {
      expect(paths).toContain(rel);
    }
    for (const rel of ["ignored.log", "node_modules/pkg/index.js", ".git/index.lock"]) expect(paths).not.toContain(rel);
    const byPath = new Map(entries.map((entry) => [entry.p, entry]));
    expect(byPath.get("link")?.l).toBe("tracked.txt");
    expect(byPath.get("run.sh")?.x).toBe(true);
    expect(byPath.get("tracked.txt")).toMatchObject({ s: 7 });
    expect(byPath.get("tracked.txt")?.x).toBeUndefined();

    const raw = (await scanFolder(root, "raw")).map((entry) => entry.p);
    for (const rel of ["ignored.log", "node_modules/pkg/index.js", ".git/HEAD", "link"]) expect(raw).toContain(rel);
    expect(raw).not.toContain(".git/index.lock");
  });

  it("walks a tree without git, skipping dependency folders", async () => {
    const root = await tempDir();
    put(root, "src/a.ts", "a");
    put(root, "node_modules/x/index.js", "x");
    put(root, ".venv/lib/y.py", "y");
    put(root, "pkg/__pycache__/z.pyc", "z");
    expect((await scanFolder(root, "tree")).map((entry) => entry.p)).toEqual(["src/a.ts"]);
    expect(await scanFolder(path.join(root, "missing"), "raw")).toEqual([]);
  });
});

describe("SyncEndpoint down push", () => {
  it("creates, updates and deletes files, keeping mtime, exec bit and in-folder symlinks", async () => {
    const primaryRoot = await tempDir();
    const nodeRoot = path.join(await tempDir(), "mirror");
    const spec = rawSpec("w", primaryRoot, nodeRoot);
    const old = Date.parse("2020-01-02T03:04:05.678Z");
    put(primaryRoot, "a.txt", "hello", old);
    put(primaryRoot, "sub/deep/b.txt", "bee");
    chmodSync(put(primaryRoot, "bin/tool", "#!/bin/sh\necho hi\n"), 0o755);
    put(primaryRoot, "big.bin", randomBytes(2.5 * 1024 * 1024));
    put(primaryRoot, "text.log", "a line of very compressible text\n".repeat(100_000));
    symlinkSync("a.txt", path.join(primaryRoot, "ln"));
    symlinkSync(path.join(primaryRoot, "sub"), path.join(primaryRoot, "abs"));
    symlinkSync("../../etc", path.join(primaryRoot, "escape"));
    put(nodeRoot, "a.txt", "outdated content");
    put(nodeRoot, "stale.txt", "old");

    const { a, primary } = cluster([spec]);
    const stats = await primary.push("run:1", [spec], mapOf([spec]));

    for (const rel of ["a.txt", "sub/deep/b.txt", "bin/tool", "big.bin", "text.log"]) {
      expect(readFileSync(path.join(nodeRoot, rel)).equals(readFileSync(path.join(primaryRoot, rel)))).toBe(true);
    }
    expect(Math.abs(statSync(path.join(nodeRoot, "a.txt")).mtimeMs - old)).toBeLessThan(2);
    expect(statSync(path.join(nodeRoot, "bin/tool")).mode & 0o111).not.toBe(0);
    expect(statSync(path.join(nodeRoot, "a.txt")).mode & 0o111).toBe(0);
    expect(readlinkSync(path.join(nodeRoot, "ln"))).toBe("a.txt");
    expect(readlinkSync(path.join(nodeRoot, "abs"))).toBe(path.join(nodeRoot, "sub"));
    expect(existsSync(path.join(nodeRoot, "escape"))).toBe(false);
    expect(existsSync(path.join(nodeRoot, "stale.txt"))).toBe(false);
    expect(stats).toMatchObject({ files: 7, deleted: 1, skipped: 1 });
    const total = ["a.txt", "sub/deep/b.txt", "bin/tool", "big.bin", "text.log"]
      .map((rel) => statSync(path.join(primaryRoot, rel)).size)
      .reduce((sum, size) => sum + size, 0);
    expect(stats.bytes).toBe(total);
    expect(a.sentBytes).toBeLessThan(total); // text.log travelled deflated

    const frames = a.sentBinary;
    const again = await primary.push("run:1", [spec], mapOf([spec]));
    expect(again).toMatchObject({ files: 0, bytes: 0, deleted: 0 });
    expect(a.sentBinary).toBe(frames);
  });

  it("refuses symlinks that climb out through another symlink", async () => {
    const primaryRoot = await tempDir();
    const nodeRoot = path.join(await tempDir(), "a", "b", "w");
    const spec = rawSpec("w", primaryRoot, nodeRoot);
    symlinkSync(".", path.join(primaryRoot, "s"));
    // Lexically s/s/s/s/../../../.. is the root; on disk s is the root, so it climbs four levels out.
    symlinkSync("s/s/s/s/../../../../etc", path.join(primaryRoot, "e"));

    const { primary } = cluster([spec]);
    const stats = await primary.push("run:1", [spec], mapOf([spec]));
    expect(readlinkSync(path.join(nodeRoot, "s"))).toBe(".");
    expect(existsSync(path.join(nodeRoot, "e"))).toBe(false);
    expect(lstatSync(path.join(nodeRoot, "s")).isSymbolicLink()).toBe(true);
    expect(stats).toMatchObject({ files: 1, skipped: 1 });
  });

  it("keeps extra node files with deleteExtras: false and serializes pushes of one scope", async () => {
    const primaryRoot = await tempDir();
    const nodeRoot = await tempDir();
    const spec = rawSpec("w", primaryRoot, nodeRoot);
    put(primaryRoot, "a.txt", "a");
    put(nodeRoot, "extra.txt", "mine");

    const { primary } = cluster([spec]);
    const [first, second] = await Promise.all([
      primary.push("run:1", [spec], mapOf([spec]), { deleteExtras: false }),
      primary.push("run:1", [spec], mapOf([spec]), { deleteExtras: false }),
    ]);
    expect(first.files).toBe(1);
    expect(second.files).toBe(0);
    expect(readFileSync(path.join(nodeRoot, "extra.txt"), "utf8")).toBe("mine");
  });
});

describe("SyncEndpoint up push", () => {
  it("sends only the changes since the last sync, including deletions", async () => {
    const primaryRoot = await tempDir();
    const nodeRoot = await tempDir();
    const spec = rawSpec("w", primaryRoot, nodeRoot);
    const readOnly: SyncFolderSpec = { ...rawSpec("ro", await tempDir(), await tempDir()), upstream: false };
    put(primaryRoot, "a.txt", "one");
    put(primaryRoot, "keep.txt", "same");
    put(primaryRoot, "sub/deep/b.txt", "bee");
    put(readOnly.primaryPath, "r.txt", "primary");

    const { b, primary, node } = cluster([spec, readOnly]);
    await primary.push("run:1", [spec, readOnly], mapOf([spec, readOnly]));
    expect(b.sentBinary).toBe(0);

    put(nodeRoot, "a.txt", "changed on the node");
    put(nodeRoot, "new.txt", "new");
    rmSync(path.join(nodeRoot, "sub"), { recursive: true });
    put(readOnly.nodePath, "r.txt", "node edit");

    const stats = await node.push("run:1", [spec, readOnly], mapOf([spec, readOnly]));
    expect(stats).toMatchObject({ files: 2, deleted: 1, skipped: 0 });
    expect(b.sentBinary).toBe(2);
    expect(readFileSync(path.join(primaryRoot, "a.txt"), "utf8")).toBe("changed on the node");
    expect(readFileSync(path.join(primaryRoot, "new.txt"), "utf8")).toBe("new");
    expect(existsSync(path.join(primaryRoot, "sub"))).toBe(false);
    expect(readFileSync(path.join(primaryRoot, "keep.txt"), "utf8")).toBe("same");
    expect(readFileSync(path.join(readOnly.primaryPath, "r.txt"), "utf8")).toBe("primary");

    const again = await node.push("run:1", [spec, readOnly], mapOf([spec, readOnly]));
    expect(again).toMatchObject({ files: 0, deleted: 0 });
    expect(b.sentBinary).toBe(2);
  });

  it("never applies git config, hooks or pointer files on the primary", async () => {
    const primaryRoot = await tempDir();
    const nodeRoot = await tempDir();
    const commonPrimary = path.join(await tempDir(), ".git");
    const commonNode = path.join(await tempDir(), ".git");
    const spec = rawSpec("w", primaryRoot, nodeRoot);
    const common = rawSpec("git0", commonPrimary, commonNode);
    put(primaryRoot, ".git/config", "[core]\n");
    put(primaryRoot, ".git/HEAD", "ref: refs/heads/main\n");
    put(primaryRoot, "wt/.git", "gitdir: /primary/repo/.git/worktrees/wt\n");
    put(primaryRoot, "file.txt", "v1");
    put(commonPrimary, "config", "[core]\n");
    put(commonPrimary, "worktrees/x/gitdir", "/primary/wt/.git\n");

    const { primary, node } = cluster([spec, common]);
    await primary.push("run:1", [spec, common], mapOf([spec, common]));

    // Deleting .git/config and writing .git/config/x would replace the file by a directory.
    rmSync(path.join(nodeRoot, ".git/config"));
    put(nodeRoot, ".git/config/x", "[core]\n\thooksPath = /tmp/evil\n");
    put(nodeRoot, ".git/hooks/pre-commit", "#!/bin/sh\necho pwned\n");
    put(nodeRoot, ".git/worktrees/x/config.worktree", "[core]\n\tfsmonitor = evil\n");
    put(nodeRoot, ".git/config.worktree", "[core]\n\tfsmonitor = evil\n");
    put(nodeRoot, ".git/commondir", "/tmp/evil\n");
    put(nodeRoot, ".GIT/hooks/post-checkout", "#!/bin/sh\n");
    put(nodeRoot, "wt/.git", "gitdir: /tmp/evil\n", Date.now() + 5_000);
    put(nodeRoot, "file.txt", "v2");
    put(commonNode, "config", "[core]\n\tfsmonitor = evil\n");
    put(commonNode, "hooks/post-merge", "#!/bin/sh\n");
    put(commonNode, "commondir", "/tmp/evil\n");
    put(commonNode, "worktrees/x/gitdir", "/tmp/evil/.git\n", Date.now() + 5_000);
    put(commonNode, "refs/heads/feature", "0123456789012345678901234567890123456789\n");

    const stats = await node.push("run:1", [spec, common], mapOf([spec, common]));
    expect(stats.skipped).toBe(12);
    expect(readFileSync(path.join(primaryRoot, ".git/config"), "utf8")).toBe("[core]\n");
    expect(existsSync(path.join(primaryRoot, ".git/hooks"))).toBe(false);
    expect(existsSync(path.join(primaryRoot, ".git/worktrees"))).toBe(false);
    expect(existsSync(path.join(primaryRoot, ".git/config.worktree"))).toBe(false);
    expect(existsSync(path.join(primaryRoot, ".git/commondir"))).toBe(false);
    expect(existsSync(path.join(primaryRoot, ".GIT"))).toBe(false);
    expect(readFileSync(path.join(primaryRoot, "wt/.git"), "utf8")).toBe("gitdir: /primary/repo/.git/worktrees/wt\n");
    expect(readFileSync(path.join(primaryRoot, "file.txt"), "utf8")).toBe("v2");
    expect(readFileSync(path.join(commonPrimary, "config"), "utf8")).toBe("[core]\n");
    expect(existsSync(path.join(commonPrimary, "hooks"))).toBe(false);
    expect(existsSync(path.join(commonPrimary, "commondir"))).toBe(false);
    expect(readFileSync(path.join(commonPrimary, "worktrees/x/gitdir"), "utf8")).toBe("/primary/wt/.git\n");
    expect(existsSync(path.join(commonPrimary, "refs/heads/feature"))).toBe(true);
  });
});

describe("SyncEndpoint receiver safety", () => {
  async function receiver(): Promise<{ a: FakeChannel; nodeRoot: string; outside: string }> {
    const nodeRoot = path.join(await tempDir(), "w");
    const outside = await tempDir();
    const spec = rawSpec("w", "/primary/w", nodeRoot);
    const [a, b] = channelPair();
    const node = new SyncEndpoint(b, "node");
    node.receive("run:", { folders: (scope) => (scope === "run:x" ? [spec] : null) });
    cleanups.push(() => {
      node.close();
      a.close();
    });
    return { a, nodeRoot, outside };
  }

  function begin(a: FakeChannel, push: string, extra: Partial<WireMessage> = {}): Promise<WireMessage> {
    return a.request({
      t: "sync.begin",
      scope: "run:x",
      push,
      dir: "down",
      deleteExtras: false,
      folders: ["w"],
      map: [],
      ...extra,
    });
  }

  function chunk(a: FakeChannel, push: string, rel: string, data: string): void {
    a.sendBinary({ t: "sync.file", push, f: "w", p: rel, o: 0, last: true, m: Date.now(), mode: 0o644 }, Buffer.from(data));
  }

  it("rejects offers with paths leaving the folder", async () => {
    const { a, nodeRoot } = await receiver();
    for (const bad of ["../evil.txt", "/etc/evil.txt", "a/../../evil.txt", "a\\..\\evil.txt", "a\0b", "./a", "a//b"]) {
      const push = randomUUID();
      expect((await begin(a, push)).t).toBe("sync.ok");
      a.send({ t: "sync.list", push, f: "w", entries: [{ p: bad, s: 4, m: Date.now() }], deleted: [] });
      const reply = await a.request({ t: "sync.listed", push });
      expect(reply.t).toBe("sync.reject");
    }
    expect(existsSync(path.join(path.dirname(nodeRoot), "evil.txt"))).toBe(false);
  });

  it("rejects unknown scopes and directions", async () => {
    const { a } = await receiver();
    expect((await begin(a, randomUUID(), { scope: "run:other" })).t).toBe("sync.reject");
    expect((await begin(a, randomUUID(), { scope: "repl" })).t).toBe("sync.reject");
    expect((await begin(a, randomUUID(), { dir: "up" })).t).toBe("sync.reject");
    expect((await begin(a, randomUUID(), { folders: "w" })).t).toBe("sync.reject");
  });

  it("ignores folders it does not accept (only its own specs are ever written)", async () => {
    const { a, nodeRoot } = await receiver();
    const push = randomUUID();
    expect((await begin(a, push, { folders: ["nope"] })).t).toBe("sync.ok");
    a.send({ t: "sync.list", push, f: "nope", entries: [{ p: "x.txt", s: 1, m: Date.now() }], deleted: [] });
    expect((await a.request({ t: "sync.listed", push })).t).toBe("sync.ok");
    expect(await a.request({ t: "sync.done", push })).toMatchObject({ t: "sync.ok", stats: { files: 0 } });
    expect(existsSync(nodeRoot)).toBe(false);
  });

  it("refuses files it did not ask for and writes through symlinks leaving the folder", async () => {
    const { a, nodeRoot, outside } = await receiver();
    const unwanted = randomUUID();
    expect((await begin(a, unwanted)).t).toBe("sync.ok");
    a.send({ t: "sync.list", push: unwanted, f: "w", entries: [{ p: "ok.txt", s: 2, m: Date.now() }], deleted: [] });
    expect((await a.request({ t: "sync.listed", push: unwanted })).t).toBe("sync.ok");
    chunk(a, unwanted, "../evil.txt", "evil");
    expect((await a.request({ t: "sync.done", push: unwanted })).t).toBe("sync.reject");
    expect(existsSync(path.join(path.dirname(nodeRoot), "evil.txt"))).toBe(false);

    symlinkSync(outside, path.join(nodeRoot, "esc"));
    const escape = randomUUID();
    expect((await begin(a, escape)).t).toBe("sync.ok");
    a.send({ t: "sync.list", push: escape, f: "w", entries: [{ p: "esc/pwn.txt", s: 3, m: Date.now() }], deleted: [] });
    expect((await a.request({ t: "sync.listed", push: escape })).t).toBe("sync.ok");
    chunk(a, escape, "esc/pwn.txt", "pwn");
    const done = await a.request({ t: "sync.done", push: escape });
    expect(done).toMatchObject({ t: "sync.ok", stats: { files: 0, skipped: 1 } });
    expect(existsSync(path.join(outside, "pwn.txt"))).toBe(false);
  });
});

describe("worktree pointer files", () => {
  it("rewrite to node paths going down and back to primary paths going up", async () => {
    const primaryBase = await tempDir();
    const mirror = path.join(await tempDir(), "mirror");
    const repo = path.join(primaryBase, "repo");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    put(repo, "README.md", "hello\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "init");
    const wt = path.join(primaryBase, "wt");
    git(repo, "worktree", "add", "-b", "feature", wt);

    const commonDirs = await gitCommonDirs([wt]);
    expect(commonDirs).toEqual([path.join(repo, ".git")]);
    expect(await gitCommonDirs([wt, repo])).toEqual([]);

    const specs: SyncFolderSpec[] = [
      { id: "wt", primaryPath: wt, nodePath: mirrorPath(wt, mirror), kind: "tree", upstream: true },
      rawSpec("git0", commonDirs[0], mirrorPath(commonDirs[0], mirror)),
    ];
    const map = mapOf(specs);
    const nodeWt = specs[0].nodePath;
    const nodeCommon = specs[1].nodePath;
    const primaryPointer = readFileSync(path.join(wt, ".git"), "utf8");
    const primaryGitdir = readFileSync(path.join(repo, ".git/worktrees/wt/gitdir"), "utf8");

    const { a, primary, node } = cluster(specs);
    await primary.push("run:wt", specs, map);
    expect(readFileSync(path.join(nodeWt, ".git"), "utf8").trim()).toBe(
      `gitdir: ${path.join(nodeCommon, "worktrees", "wt")}`,
    );
    expect(readFileSync(path.join(nodeCommon, "worktrees/wt/gitdir"), "utf8").trim()).toBe(path.join(nodeWt, ".git"));
    expect(git(nodeWt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");

    const frames = a.sentBinary;
    expect((await primary.push("run:wt", specs, map)).files).toBe(0);
    expect(a.sentBinary).toBe(frames);
    expect((await node.push("run:wt", specs, map)).files).toBe(0);

    put(nodeWt, "NODE.md", "from the node\n");
    git(nodeWt, "add", "NODE.md");
    git(nodeWt, "commit", "-m", "node commit");
    const later = (Date.now() + 5_000) / 1000;
    utimesSync(path.join(nodeWt, ".git"), later, later);
    utimesSync(path.join(nodeCommon, "worktrees/wt/gitdir"), later, later);

    const stats = await node.push("run:wt", specs, map);
    expect(stats.files).toBeGreaterThan(2);
    // Both pointer files changed (mtime) on the node; the primary never takes them.
    expect(stats.skipped).toBe(2);
    expect(git(wt, "log", "-1", "--format=%s")).toBe("node commit");
    expect(readFileSync(path.join(wt, "NODE.md"), "utf8")).toBe("from the node\n");
    expect(readFileSync(path.join(wt, ".git"), "utf8")).toBe(primaryPointer);
    expect(readFileSync(path.join(repo, ".git/worktrees/wt/gitdir"), "utf8")).toBe(primaryGitdir);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });
});

describe("snapshotSqlite", () => {
  it("writes a readable, consistent copy and replaces an older one", async () => {
    const dir = await tempDir();
    const source = path.join(dir, "source.db");
    const target = path.join(dir, "snap", "copy.db");
    const db = new DatabaseSync(source);
    cleanups.push(() => db.isOpen && db.close());
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('a'), ('b');");

    await snapshotSqlite(source, target);
    db.exec("INSERT INTO t VALUES ('c')");
    await snapshotSqlite(source, target);

    const copy = new DatabaseSync(target, { readOnly: true });
    const row = copy.prepare("SELECT count(*) AS n FROM t").get() as { n: number };
    copy.close();
    expect(row.n).toBe(3);
    expect(readdirSync(path.dirname(target))).toEqual(["copy.db"]);
    expect(lstatSync(target).isFile()).toBe(true);
  });
});
