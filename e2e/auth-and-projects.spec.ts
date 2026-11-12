import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  FAKE_OMP_PATH,
  WORKSPACE_DIR,
  createProjectViaApi,
  gotoProjects,
  login,
  uniqueName,
} from "./helpers";

test.describe("authentication", () => {
  test("an unauthenticated visit to / redirects to the login page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in to AgentMan" })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  });

  test("a wrong password shows an error and stays on the login page", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Password", { exact: true }).fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("#auth-error")).toHaveText("Invalid password");
    await expect(page).toHaveURL(/\/login$/);
    // The field stays usable for another attempt.
    await expect(page.getByLabel("Password", { exact: true })).toBeEnabled();
  });

  test("the correct password lands on Projects", async ({ page }) => {
    await login(page);
    await expect(page).toHaveTitle(/AgentMan/);
    await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeAttached();
    await expect(
      page.getByRole("banner").getByRole("button", { name: "New project" }),
    ).toBeVisible();
  });

  test("a deep link survives the login redirect", async ({ page }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname === "/settings");
  });

  test("logging out returns to /login and revokes access to the app", async ({ page }) => {
    await login(page);
    await gotoProjects(page);

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await page.waitForURL((url) => url.pathname === "/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    // The session cookie is gone: the app redirects back to the login page.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("projects", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("create a project with the folder picker, then open its board", async ({ page }) => {
    const folder = uniqueName("picked");
    mkdirSync(path.join(WORKSPACE_DIR, folder), { recursive: true });

    await gotoProjects(page);
    await page.getByRole("banner").getByRole("button", { name: "New project" }).click();

    const form = page.getByRole("dialog", { name: "New project" });
    await form.getByRole("button", { name: /Use a folder on the server/ }).click();

    const picker = page.getByRole("dialog", { name: "Choose the project folder" });
    await picker.getByRole("button", { name: folder, exact: true }).click();
    await expect(
      picker.getByRole("navigation", { name: "Current folder" }).locator('[aria-current="location"]'),
    ).toHaveText(folder);
    await expect(picker.getByText("No folders inside")).toBeVisible();
    await picker.getByRole("button", { name: /Use this folder/ }).click();
    await expect(picker).toBeHidden();

    // The name is taken from the folder; the chosen path is shown.
    await expect(form.getByLabel("Project name", { exact: true })).toHaveValue(folder);
    await expect(form).toContainText(`${path.sep}${folder}`);
    await form.getByRole("button", { name: "Create project" }).click();

    await page.waitForURL(/\/b\/[^/?]+$/);
    await expect(page.getByRole("heading", { name: folder, level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "To do", exact: true })).toBeVisible();

    // The project is listed on Projects and its card opens the board.
    await page.getByRole("link", { name: "Back" }).click();
    await page.waitForURL((url) => url.pathname === "/");
    const card = page.getByRole("link", { name: folder, exact: true });
    await expect(card).toBeVisible();
    await card.click();
    await page.waitForURL(/\/b\/[^/?]+$/);
    await expect(page.getByRole("heading", { name: folder, level: 1 })).toBeVisible();
  });

  test("rename a project from its menu", async ({ page, request }) => {
    const name = uniqueName("rename-me");
    const renamed = uniqueName("renamed");
    await createProjectViaApi(request, name);

    await gotoProjects(page);
    await page.getByRole("button", { name: `Project options for ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    const dialog = page.getByRole("dialog", { name: "Edit project" });
    await expect(dialog.getByLabel("Project name", { exact: true })).toHaveValue(name);
    await dialog.getByLabel("Project name", { exact: true }).fill(renamed);
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByRole("link", { name: renamed, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("link", { name: renamed, exact: true })).toBeVisible();
  });

  test("delete a project after confirming", async ({ page, request }) => {
    const name = uniqueName("delete-me");
    await createProjectViaApi(request, name);

    await gotoProjects(page);
    await page.getByRole("button", { name: `Project options for ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();

    const confirm = page.getByRole("alertdialog", { name: `Delete “${name}”?` });
    await expect(confirm).toContainText("Files in the project folder are not touched.");
    // Cancelling keeps the project.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();

    await page.getByRole("button", { name: `Project options for ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await confirm.getByRole("button", { name: "Delete project" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(/tap one to open its board|Create your first project/)).toBeVisible();
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  });
});

test.describe("settings and stats", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await gotoProjects(page);
  });

  test("settings page shows system info", async ({ page }) => {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
    await page.waitForURL((url) => url.pathname === "/settings");

    // The omp probe can take up to its 5 s timeout against the fake binary.
    await expect(page.getByText("AgentMan version")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("SQLite", { exact: true })).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: FAKE_OMP_PATH })).toBeVisible();
    // Agent settings reflect the server's omp path too.
    await expect(page.getByLabel("omp path", { exact: true })).toHaveValue(FAKE_OMP_PATH);
  });

  test("Stats is reachable from the header and shows AI quota and System", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("link", { name: "Stats" }).click();
    await page.waitForURL((url) => url.pathname === "/stats");
    await expect(nav.getByRole("link", { name: "Stats" })).toHaveAttribute("aria-current", "page");

    await expect(page.getByRole("region", { name: "AI quota" })).toBeVisible();
    const system = page.getByRole("region", { name: "System", exact: true });
    await expect(system).toBeVisible();
    await expect(system.getByRole("progressbar", { name: "Memory usage", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(system.getByRole("progressbar", { name: "CPU usage", exact: true })).toBeVisible();
  });
});
