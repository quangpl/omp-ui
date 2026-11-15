import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  AGENT_TIMEOUT,
  PROJECTS_DIR,
  SLOW_MARKER,
  cardButton,
  columnTabName,
  createProjectViaApi,
  createTaskViaApi,
  expectNoHorizontalScroll,
  expectTouchTarget,
  fakeOmpCallsIn,
  gotoProjects,
  login,
  uniqueName,
} from "./helpers";

// Runs only in the "mobile" project (Pixel 7: 412px wide, touch, mobile UA).

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("no horizontal scrolling on Projects, Stats, Settings and a board", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("a-rather-long-project-name-for-a-phone"));
  // A long unbroken word is the classic way a card blows out a narrow layout.
  await createTaskViaApi(request, board.id, {
    title: `Refactor ${"Supercalifragilistic".repeat(4)} module`,
    description: "https://example.com/a/very/long/link/that/should/wrap/instead/of/overflowing/the/card",
  });

  await gotoProjects(page);
  await expect(page.getByRole("link", { name: board.name, exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto("/stats");
  await expect(
    page.getByRole("region", { name: "System", exact: true }).getByRole("progressbar", { name: "Memory usage", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalScroll(page);

  await page.goto("/settings");
  await expect(page.getByText("AgentMan version")).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalScroll(page);

  await page.goto(`/b/${board.id}`);
  await expect(page.getByRole("tab", { name: columnTabName("To do", 1) })).toBeVisible();
  await expect(page.getByRole("tabpanel").getByRole("button", { name: /^(?!More actions).*Refactor/ })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("bottom tabs navigate the top-level sections and are hidden on a board", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("tabs"));
  const tabs = page.getByRole("navigation", { name: "Main" });

  await gotoProjects(page);
  await expect(tabs).toBeVisible();
  // Pinned to the bottom of the screen.
  const viewport = page.viewportSize()!;
  const bar = await tabs.boundingBox();
  expect(bar).not.toBeNull();
  expect(Math.round(bar!.y + bar!.height)).toBe(viewport.height);

  for (const label of ["Projects", "Stats", "Settings"]) {
    await expectTouchTarget(tabs.getByRole("link", { name: label }), `${label} tab`);
  }
  await expect(tabs.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");

  await tabs.getByRole("link", { name: "Stats" }).click();
  await page.waitForURL((url) => url.pathname === "/stats");
  await expect(tabs.getByRole("link", { name: "Stats" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "AI quota" })).toBeVisible();

  await tabs.getByRole("link", { name: "Settings" }).click();
  await page.waitForURL((url) => url.pathname === "/settings");
  await expect(tabs.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("AgentMan version")).toBeVisible({ timeout: 15_000 });

  await tabs.getByRole("link", { name: "Projects" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByRole("link", { name: board.name, exact: true })).toBeVisible();

  // A board is a sub-page: no bottom tabs, a Back button instead.
  await page.getByRole("link", { name: board.name, exact: true }).click();
  await page.waitForURL(/\/b\/[^/?]+$/);
  await expect(page.getByRole("tab", { name: columnTabName("To do", 0) })).toBeVisible();
  await expect(tabs).toHaveCount(0);

  await page.getByRole("link", { name: "Back" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(tabs).toBeVisible();
});

test("board: FAB adds a card that starts on its own, the detail drawer steers the agent to Done", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const board = await createProjectViaApi(request, uniqueName("phone"));
  // The slow fake keeps the agent working until feedback is steered in, so every state is observable.
  const title = `${SLOW_MARKER} ${uniqueName("Phone task")}`;
  const feedback = "Use the existing logger please";

  await page.goto(`/b/${board.id}`);

  // Column tabs with counts replace the three desktop columns.
  const todoTab = page.getByRole("tab", { name: columnTabName("To do", 0) });
  await expect(todoTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: columnTabName("In progress", 0) })).toBeVisible();
  await expect(page.getByRole("tab", { name: columnTabName("Done", 0) })).toBeVisible();
  await expect(page.getByRole("region", { name: "To do", exact: true })).toHaveCount(0);
  for (const tab of await page.getByRole("tab").all()) {
    await expectTouchTarget(tab, `column tab ${await tab.textContent()}`);
  }

  // FAB → the dedicated new-card page (a keyboard plus a bottom sheet leaves no room on a phone).
  const fab = page.getByRole("button", { name: "New task" });
  await expectTouchTarget(fab, "New task FAB");
  await fab.click();
  await expect(page).toHaveURL(/\/b\/[^/]+\/new\?from=board$/);
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  const prompt = page.getByLabel("What should the agent do?", { exact: true });
  const create = page.getByRole("button", { name: "Create task" });
  await expect(prompt).toBeVisible();
  await expect(create).toBeDisabled();
  // The whole form fits on screen: no vertical page scroll, Create task reachable without scrolling.
  const viewport = page.viewportSize()!;
  const { scrollHeight, innerHeight } = await page.evaluate(() => ({
    scrollHeight: document.scrollingElement!.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  expect(scrollHeight).toBeLessThanOrEqual(innerHeight + 1);
  const createBox = await create.boundingBox();
  expect(createBox, "Create task has no layout box").not.toBeNull();
  expect(createBox!.y + createBox!.height).toBeLessThanOrEqual(viewport.height);
  await expectTouchTarget(create, "Create task");
  await prompt.fill(title);
  await expect(create).toBeEnabled();
  await create.click();

  // Back on the board, which opens on In progress: a new card skips To do and its agent starts by itself.
  await expect(page).toHaveURL(/\/b\/[^/?]+$/, { timeout: AGENT_TIMEOUT });
  // The "Card added" confirmation follows onto the board; dismiss it, it sits over the column tabs.
  const added = page.getByRole("status").filter({ hasText: "Card added" });
  await expect(added).toContainText(title);
  await added.getByRole("button", { name: "Dismiss" }).click();
  await expect(added).toBeHidden();
  await expect(page.getByRole("tab", { name: columnTabName("To do", 0) })).toBeVisible();
  const panel = page.getByRole("tabpanel");
  const inProgressTab = page.getByRole("tab", { name: columnTabName("In progress", 1) });
  await expect(inProgressTab).toHaveAttribute("aria-selected", "true");
  const card = cardButton(panel, title);
  await expect(card).toContainText("Working", { timeout: AGENT_TIMEOUT });
  // While the agent works, the primary quick action is Stop; quick actions are thumb-sized.
  const stop = panel.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await expectTouchTarget(stop, "Stop quick action");
  await expectTouchTarget(panel.getByRole("button", { name: `More actions for ${title}` }), "More actions");

  // Card detail opens as a bottom drawer.
  await card.click();
  await expect(page).toHaveURL(/[?&]task=[^&]+/);
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail).toHaveAttribute("data-vaul-drawer-direction", "bottom");
  // Wait for the slide-in animation to settle at the bottom edge.
  await expect
    .poll(async () => {
      const box = await detail.boundingBox();
      return box ? Math.round(box.y + box.height) : null;
    })
    .toBe(viewport.height);
  const box = (await detail.boundingBox())!;
  expect(box.y).toBeGreaterThan(0);
  expect(Math.round(box.width)).toBe(viewport.width);

  // The comment composer is usable: feedback goes to the running agent, which then finishes.
  await expect(detail.getByText("Feedback is sent to the running agent")).toBeVisible();
  const send = detail.getByRole("button", { name: "Send feedback" });
  await expectTouchTarget(send, "Send feedback");
  await expect(send).toBeDisabled();
  await detail.getByRole("textbox", { name: "Feedback", exact: true }).fill(feedback);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(detail.getByRole("textbox", { name: "Feedback", exact: true })).toHaveValue("");

  const item = detail.getByRole("listitem").filter({ hasText: feedback });
  await expect(item.getByText(/^Resolved/)).toBeVisible({ timeout: AGENT_TIMEOUT });
  await expect(detail.getByRole("tabpanel", { name: /Activity/ }).getByText("Fake summary: addressed 1 steered message(s).")).toBeVisible();
  await expect(detail.getByRole("status", { name: "Status" })).toHaveText(/Done/);
  expect(
    fakeOmpCallsIn(board.workdir).some((entry) => entry.kind === "steer" && entry.message?.includes(feedback)),
  ).toBe(true);

  await detail.getByRole("button", { name: "Close", exact: true }).click();
  await expect(detail).toBeHidden();
  await expect(page.getByRole("tab", { name: columnTabName("In progress", 0) })).toBeVisible();
  const doneTab = page.getByRole("tab", { name: columnTabName("Done", 1) });
  await doneTab.click();
  await expect(cardButton(panel, title)).toBeVisible();
});

test("board: Cancel on the new-card page returns to the board without creating a card", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("phone-cancel"));

  await page.goto(`/b/${board.id}`);
  await expect(page.getByRole("tab", { name: columnTabName("To do", 0) })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "New task" }).click();
  await expect(page).toHaveURL(/\/b\/[^/]+\/new\?from=board$/);
  await page.getByLabel("What should the agent do?", { exact: true }).fill(uniqueName("Never created"));
  await page.getByRole("button", { name: /cancel/i }).click();

  // Straight back to the board (no `/new`), still on To do, and every column is empty.
  await expect(page).toHaveURL(new RegExp(`/b/${board.id}$`));
  await expect(page.getByRole("tab", { name: columnTabName("To do", 0) })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: columnTabName("In progress", 0) })).toBeVisible();
  await expect(page.getByRole("tab", { name: columnTabName("Done", 0) })).toBeVisible();
});

test("projects: New project clones a Git repository from the bottom sheet", async ({ page }) => {
  mkdirSync(PROJECTS_DIR, { recursive: true });
  const source = path.join(PROJECTS_DIR, `${uniqueName("upstream")}.git`);
  execFileSync("git", ["init", "--bare", "--quiet", source]);
  const folder = uniqueName("cloned");

  await gotoProjects(page);
  await page.getByRole("banner").getByRole("button", { name: "New project" }).click();
  const chooseClone = page
    .getByRole("dialog", { name: "New project" })
    .getByRole("button", { name: /Clone a Git repository/ });
  await chooseClone.click();

  const sheet = page.getByRole("dialog", { name: "Clone a Git repository" });
  const back = sheet.getByRole("button", { name: "Back" });
  const url = sheet.getByLabel("Repository URL");
  const name = sheet.getByLabel(/^Folder name/);
  const submit = sheet.getByRole("button", { name: "Clone repository" });
  await expectTouchTarget(back, "Back");
  await expectTouchTarget(url, "Repository URL");
  await expectTouchTarget(name, "Folder name");
  await expectTouchTarget(submit, "Clone repository");
  await expectNoHorizontalScroll(page);

  // Back returns to the source choice.
  await back.click();
  await chooseClone.click();

  await url.fill(source);
  await expect(name).toHaveAttribute("placeholder", path.basename(source, ".git"));
  await name.fill(folder);
  await submit.click();

  // The clone becomes the project folder and names the project.
  const form = page.getByRole("dialog", { name: "New project" });
  await expect(form.getByLabel("Project name", { exact: true })).toHaveValue(folder);
  await expect(form).toContainText(`${path.sep}${folder}`);
  await expectNoHorizontalScroll(page);
  await form.getByRole("button", { name: "Create project" }).click();

  await page.waitForURL(/\/b\/[^/?]+$/);
  await expect(page.getByRole("heading", { name: folder, level: 1 })).toBeVisible();
});
