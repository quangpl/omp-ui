import { describe, expect, it } from "vitest";

import { OMP_SHORTCUTS, filterSlashItems, slashItems } from "@/lib/slash-skills";
import type { OmpSkill } from "@/lib/types";

const skills: OmpSkill[] = [
  { name: "minimalist-ui", description: "Clean editorial-style interfaces.", source: "native:user" },
  { name: "brandkit", description: "Brand-kit image generation for logo systems.", source: "native:user" },
];

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
