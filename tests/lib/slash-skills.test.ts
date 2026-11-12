import { describe, expect, it } from "vitest";

import {
  OMP_SHORTCUTS,
  applySlashItem,
  filterSlashItems,
  slashItems,
  slashTokenAt,
} from "@/lib/slash-skills";
import type { OmpSkill } from "@/lib/types";

const skills: OmpSkill[] = [
  { name: "minimalist-ui", description: "Clean editorial-style interfaces.", source: "native:user" },
  { name: "brandkit", description: "Brand-kit image generation for logo systems.", source: "native:user" },
];

describe("slashTokenAt", () => {
  it("matches / at the start of the text", () => {
    expect(slashTokenAt("/min", 4)).toEqual({ start: 0, end: 4, query: "min" });
  });

  it("matches / after whitespace, mid-text, at the caret", () => {
    const text = "Redesign the page /bran and keep the logo";
    expect(slashTokenAt(text, 23)).toEqual({ start: 18, end: 23, query: "bran" });
  });

  it("matches a bare / with an empty query", () => {
    expect(slashTokenAt("do it\n/", 7)).toEqual({ start: 6, end: 7, query: "" });
  });

  it("ignores slashes inside URLs and paths", () => {
    const url = "see https://example.com";
    expect(slashTokenAt(url, url.length)).toBeNull();
    const path = "fix lib/utils";
    expect(slashTokenAt(path, path.length)).toBeNull();
  });

  it("closes once the token is left behind", () => {
    expect(slashTokenAt("/min done", 9)).toBeNull();
  });
});

describe("slashItems + filterSlashItems", () => {
  it("exposes every skill and every OMP shortcut", () => {
    const items = slashItems(skills);
    expect(items.map((i) => i.name)).toEqual([
      ...OMP_SHORTCUTS.map((s) => s.name),
      "minimalist-ui",
      "brandkit",
    ]);
    expect(items.find((i) => i.name === "brandkit")?.insert).toBe("skill://brandkit");
  });

  it("returns everything for an empty query", () => {
    const items = slashItems(skills);
    expect(filterSlashItems(items, "")).toEqual(items);
  });

  it("ranks name prefixes before substring and description matches", () => {
    const items = slashItems(skills);
    expect(filterSlashItems(items, "brand").map((i) => i.name)).toEqual(["brandkit"]);
    expect(filterSlashItems(items, "ui").map((i) => i.name)).toEqual(["minimalist-ui"]);
    expect(filterSlashItems(items, "logo").map((i) => i.name)).toEqual(["brandkit"]);
    expect(filterSlashItems(items, "zzz")).toEqual([]);
  });
});

describe("applySlashItem", () => {
  it("replaces the token with the insert text and places the caret after it", () => {
    const text = "Build the page /min please";
    const token = slashTokenAt(text, 19)!;
    const item = slashItems(skills).find((i) => i.name === "minimalist-ui")!;
    const next = applySlashItem(text, token, item);
    expect(next.text).toBe("Build the page skill://minimalist-ui  please");
    expect(next.text.slice(0, next.caret)).toBe("Build the page skill://minimalist-ui ");
  });

  it("inserts the orchestrate shortcut as the bare keyword", () => {
    const next = applySlashItem("/orch", slashTokenAt("/orch", 5)!, OMP_SHORTCUTS[0]);
    expect(next.text).toBe("orchestrate ");
    expect(next.caret).toBe(12);
  });
});
