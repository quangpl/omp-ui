import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { userPath } from "../../bin/postinstall.mjs";

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
});
