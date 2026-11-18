import { describe, expect, it } from "vitest";

import { isSoftwareTask } from "@/lib/task-kind";
import type { Task } from "@/lib/types";

function task(title: string, description = ""): Pick<Task, "title" | "description"> {
  return { title, description };
}

describe("isSoftwareTask", () => {
  it("treats coding and repository work as software", () => {
    const software = [
      task("Add a cart page", "Show the items in the cart."),
      task("Fix the checkout bug"),
      task("Refactor the auth module"),
      task("Implement the search endpoint"),
      task("Update all components to the new design system"),
      task("Migrate the database schema"),
      task("Deploy the app to production"),
      task("Write unit tests for the parser"),
    ];
    for (const t of software) expect(isSoftwareTask(t), t.title).toBe(true);
  });

  it("treats content, research and planning tasks as non-software", () => {
    const direct = [
      task("Write a poem about the ocean"),
      task("Summarize this article", "Condense the key points into bullet points."),
      task("Translate this document to Spanish"),
      task("Draft an email to the team"),
      task("Write a cover letter", "For a product manager role."),
      task("Plan a one-week itinerary for Tokyo"),
      task("Write a recipe for a weeknight pasta"),
      task("Research the market for electric bikes"),
    ];
    for (const t of direct) expect(isSoftwareTask(t), t.title).toBe(false);
  });

  it("keeps a task in the SDLC workflow when a non-software word coexists with code", () => {
    expect(isSoftwareTask(task("Add email notifications to the app"))).toBe(true);
    expect(isSoftwareTask(task("Write an article about our new API"))).toBe(true);
    expect(isSoftwareTask(task("Translate the UI to Spanish"))).toBe(true);
  });

  it("defaults ambiguous text to software work", () => {
    expect(isSoftwareTask(task("Improve the onboarding"))).toBe(true);
    expect(isSoftwareTask(task("Make it faster"))).toBe(true);
    expect(isSoftwareTask(task("", ""))).toBe(true);
  });
});
