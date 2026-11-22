import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { pathCommand, userPath } from "../../bin/postinstall.mjs";

describe("postinstall userPath", () => {
  it("drops the folders npm prepends for install scripts and keeps the terminal's PATH", () => {
    const npmPath = [
      "/usr/local/lib/node_modules/omp-ui/node_modules/.bin",
      "/usr/local/lib/node_modules/.bin",
      "/usr/local/node/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
      "/usr/local/bin",
      "/Users/me/.local/bin",
      "",
      "/usr/bin",
    ].join(":");
    expect(userPath(npmPath)).toEqual(["/usr/local/bin", "/Users/me/.local/bin", "/usr/bin"]);
  });

  it("builds a paste-ready command that adds the folder to the shell config and reloads it", () => {
    expect(pathCommand("/opt/node/bin", "zsh")).toBe(
      `echo 'export PATH="/opt/node/bin:$PATH"  # added by omp-ui' >> ~/.zshrc && source ~/.zshrc`,
    );
    expect(pathCommand("/opt/node/bin", "bash")).toContain(">> ~/.bashrc && source ~/.bashrc");
    expect(pathCommand("/opt/node/bin", "fish")).toBe("fish_add_path /opt/node/bin");
  });
});
