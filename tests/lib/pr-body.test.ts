import { describe, expect, it } from "vitest";

import { buildPrBody } from "@/lib/pr-body";

const FOOTER = "---\nCreated from AgentMan";

describe("buildPrBody", () => {
  it("keeps the prose, turns the report into verification bullets and collapses the task", () => {
    const summary = [
      "Added retry with backoff to the sync worker.",
      "",
      "![shot](/api/v1/tasks/x/files/a.png)",
      "",
      "## Report",
      "",
      "- Outcome: done",
      "- Tests: 42 passed, 0 failed",
      "- Changes: 3 files changed, 40 insertions(+)",
      "- Model: anthropic/claude",
    ].join("\n");
    const body = buildPrBody("Make the sync worker retry.", summary);

    expect(body).toBe(
      [
        "Added retry with backoff to the sync worker.",
        "**Verification**\n- **Outcome:** done\n- **Tests:** 42 passed, 0 failed\n- **Changes:** 3 files changed, 40 insertions(+)",
        "<details>\n<summary>Task</summary>\n\nMake the sync worker retry.\n\n</details>",
        FOOTER,
      ].join("\n\n"),
    );
    expect(body).not.toContain("Model");
    expect(body).not.toContain("/api/v1/");
    expect(body).not.toContain("## Report");
  });

  it("emits the description plainly when there is no summary", () => {
    const body = buildPrBody("  Fix the login bug.  ", null);

    expect(body).toBe(`Fix the login bug.\n\n${FOOTER}`);
    expect(body).not.toContain("<details>");
  });

  it("replaces AgentMan-relative links with their text and keeps absolute links", () => {
    const body = buildPrBody(
      "Task",
      "See [log](/api/v1/tasks/x/files/log.txt) and [docs](https://example.com/docs).",
    );

    expect(body.split("\n\n")[0]).toBe("See log and [docs](https://example.com/docs).");
  });

  it("keeps code spans and fenced code verbatim", () => {
    const summary = "Use `[x](/a)` here.\n\n```md\n[Home](/)\n```";
    const body = buildPrBody("Task", summary);

    expect(body.startsWith(`${summary}\n\n`)).toBe(true);
  });

  it("handles nested brackets in link text and parens in the URL", () => {
    const body = buildPrBody("Task", "Shot: ![a [b] c](/api/x.png)\nFile: [f](/files/cart(1).png)");

    expect(body.split("\n\n")[0]).toBe("Shot: \nFile: f");
  });

  it("clips a long summary at a line boundary", () => {
    const summary = Array.from({ length: 250 }, (_, i) => `Line ${String(i).padStart(3, "0")} of the summary.`).join(
      "\n",
    );
    expect(summary.length).toBeGreaterThan(5000);
    const prose = buildPrBody("Task", summary).split("\n\n")[0];

    expect(prose.length).toBeLessThanOrEqual(1501);
    expect(prose.endsWith("…")).toBe(true);
    expect(prose).toContain("Line 000 of the summary.");
  });

  it("clips a long single-line summary at a word boundary", () => {
    const prose = buildPrBody("Task", "word ".repeat(1000)).split("\n\n")[0];

    expect(prose.length).toBeLessThanOrEqual(1501);
    expect(prose.endsWith("…")).toBe(true);
  });

  it("closes a code fence the clip cut through, keeping the details and footer outside it", () => {
    const code = Array.from({ length: 300 }, (_, i) => `  const value${i} = ${i};`).join("\n");
    const body = buildPrBody(`- Step one:\n\n  \`\`\`ts\n${code}\n  \`\`\``, "Done.");
    const fenceLines = body.split("\n").filter((line) => /^\s*```/.test(line));

    expect(fenceLines).toEqual(["  ```ts", "  ```"]);
    expect(body.lastIndexOf("```")).toBeLessThan(body.indexOf("</details>"));
    expect(body.endsWith(FOOTER)).toBe(true);
  });
});
