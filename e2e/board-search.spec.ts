import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  apiToken,
  cardButton,
  createProjectViaApi,
  createTaskViaApi,
  login,
  uniqueName,
} from "./helpers";

const LOGIN_FIX = "Fix login redirect";
const LOGIN_COPY = "Polish login copy";
const RELEASE_NOTES = "Write release notes";
const RENAMED = "Login audit notes";

function column(page: Page, name: "To do" | "In progress" | "Done") {
  return page.getByRole("region", { name, exact: true });
}

function searchbox(page: Page) {
  return page.getByRole("searchbox", { name: "Search cards" });
}

/** Opens a fresh board with three To do cards; resolves once they are rendered. */
async function openSeededBoard(page: Page, request: APIRequestContext) {
  const board = await createProjectViaApi(request, uniqueName("search"));
  const tasks = {
    fix: await createTaskViaApi(request, board.id, { title: LOGIN_FIX, status: "todo" }),
    copy: await createTaskViaApi(request, board.id, { title: LOGIN_COPY, status: "todo" }),
    notes: await createTaskViaApi(request, board.id, { title: RELEASE_NOTES, status: "todo" }),
  };
  await page.goto(`/b/${board.id}`);
  await expectAllCardsVisible(page);
  return { board, tasks };
}

async function expectAllCardsVisible(page: Page) {
  const todo = column(page, "To do");
  for (const title of [LOGIN_FIX, LOGIN_COPY, RELEASE_NOTES]) {
    await expect(cardButton(todo, title)).toBeVisible();
  }
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("board search filters cards by title, reports matches and clears with Escape or the clear button", async ({
  page,
  request,
}) => {
  await openSeededBoard(page, request);
  const input = searchbox(page);
  const todo = column(page, "To do");
  await expect(input).toBeVisible();

  // Plain `f` with nothing focused jumps to the search field.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("f");
  await expect(input).toBeFocused();

  // Case-insensitive title match across the board.
  await input.fill("LOGIN");
  await expect(cardButton(todo, LOGIN_FIX)).toBeVisible();
  await expect(cardButton(todo, LOGIN_COPY)).toBeVisible();
  await expect(cardButton(page, RELEASE_NOTES)).toHaveCount(0);
  await expect(page.getByText("2 of 3", { exact: true })).toBeVisible();

  // Nothing matches: the status says so and the columns explain why they are empty.
  await input.fill("zzz");
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
  await expect(todo.getByText("No matching cards", { exact: true })).toBeVisible();
  await expect(cardButton(page, LOGIN_FIX)).toHaveCount(0);

  // Escape in the field clears the query and brings every card back.
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await expectAllCardsVisible(page);
  await expect(todo.getByText("No matching cards", { exact: true })).toHaveCount(0);

  // The clear button does the same and keeps the field focused.
  await input.fill("release");
  await expect(cardButton(todo, RELEASE_NOTES)).toBeVisible();
  await expect(cardButton(page, LOGIN_FIX)).toHaveCount(0);
  await expect(page.getByText("1 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expectAllCardsVisible(page);
  await expect(page.getByRole("button", { name: "Clear search", exact: true })).toHaveCount(0);
});

test("fuzzy search tolerates typos and skipped letters and highlights matches", async ({ page, request }) => {
  await openSeededBoard(page, request);
  const input = searchbox(page);
  const todo = column(page, "To do");
  const fuzzyLabel = page.getByRole("search").getByText(/fuzzy/i);

  // A transposed letter still finds both login cards and flags the results as close matches.
  await input.fill("lgoin");
  await expect(cardButton(todo, LOGIN_FIX)).toBeVisible();
  await expect(cardButton(todo, LOGIN_COPY)).toBeVisible();
  await expect(cardButton(page, RELEASE_NOTES)).toHaveCount(0);
  await expect(page.getByText("2 of 3", { exact: true })).toBeVisible();
  await expect(fuzzyLabel).toBeVisible();

  // Skipped letters match as an in-order subsequence.
  await input.fill("wrn");
  await expect(cardButton(todo, RELEASE_NOTES)).toBeVisible();
  await expect(cardButton(page, LOGIN_FIX)).toHaveCount(0);
  await expect(cardButton(page, LOGIN_COPY)).toHaveCount(0);
  await expect(page.getByText("1 of 3", { exact: true })).toBeVisible();

  // An exact query is not labelled fuzzy and highlights the matched characters in the title.
  await input.fill("login");
  await expect(page.getByText("2 of 3", { exact: true })).toBeVisible();
  await expect(fuzzyLabel).toHaveCount(0);
  await expect(cardButton(todo, LOGIN_FIX).locator("mark")).toHaveText("login");
  await expect(cardButton(todo, LOGIN_FIX)).toHaveAccessibleName(new RegExp(LOGIN_FIX));

  // Clearing the query removes every highlight.
  await input.press("Escape");
  await expectAllCardsVisible(page);
  await expect(page.locator("mark")).toHaveCount(0);
});

test("an active search keeps filtering when a card changes live", async ({ page, request }) => {
  const { tasks } = await openSeededBoard(page, request);
  const input = searchbox(page);
  const todo = column(page, "To do");
  // The SSE stream must be up before the server-side change, or the update could be missed.
  await expect(page.getByRole("banner").getByRole("status")).toContainText("Live");

  await input.fill("login");
  await expect(page.getByText("2 of 3", { exact: true })).toBeVisible();
  await expect(cardButton(page, RELEASE_NOTES)).toHaveCount(0);

  const res = await request.patch(`/api/v1/tasks/${tasks.notes.id}`, {
    headers: { Authorization: `Bearer ${await apiToken(request)}` },
    data: { title: RENAMED },
  });
  expect(res.status(), await res.text()).toBe(200);

  // The renamed card now matches and shows up without touching the query.
  await expect(cardButton(todo, RENAMED)).toBeVisible();
  await expect(input).toHaveValue("login");
  await expect(page.getByText("3 of 3", { exact: true })).toBeVisible();
  await expect(cardButton(todo, LOGIN_FIX)).toBeVisible();
  await expect(cardButton(todo, LOGIN_COPY)).toBeVisible();
});
