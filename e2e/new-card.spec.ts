import { expect, test, type Page } from "@playwright/test";
import { AGENT_TIMEOUT, cardButton, createProjectViaApi, login, uniqueName } from "./helpers";

// A new card from free text is titled with its first line, keeps the text as typed as its
// description and starts its run at once.

function column(page: Page, name: "To do" | "In progress" | "Done") {
  return page.getByRole("region", { name, exact: true });
}

async function openNewCard(page: Page) {
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  return page.getByRole("dialog", { name: "New task" });
}

/** Opens the card in Done once its run finished and returns its detail dialog. */
async function openDoneCard(page: Page, title: string) {
  const done = column(page, "Done");
  await expect(cardButton(done, title)).toBeVisible({ timeout: AGENT_TIMEOUT });
  await cardButton(done, title).click();
  return page.getByRole("dialog", { name: title });
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("Create task starts the card as typed", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("new-card"));
  const title = uniqueName("Cache the avatar thumbnails");
  const text = `${title}\nThey are fetched again on every page view.\n- keep the old sizes`;

  await page.goto(`/b/${board.id}`);
  const newCard = await openNewCard(page);
  await expect(newCard.getByRole("switch", { name: "Ignore memory" })).not.toBeChecked();
  await newCard.getByLabel("What should the agent do?", { exact: true }).fill(text);
  await newCard.getByRole("button", { name: "Create task" }).click();
  await expect(newCard).toBeHidden();

  // In progress (or already Done) at once, titled with the first line; nothing rewrites it.
  await expect(cardButton(page.getByRole("region", { name: /^(In progress|Done)$/ }), title)).toBeVisible();

  const detail = await openDoneCard(page, title);
  await detail.getByRole("button", { name: "Edit description", exact: true }).click();
  await expect(detail.getByLabel("Description", { exact: true })).toHaveValue(text);
});

test("the column composer keeps longer text as typed", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("composer"));
  const title = uniqueName("Group the settings toggles");
  const text = `${title}\nPut the notification ones under their own heading.`;

  await page.goto(`/b/${board.id}`);
  const todo = column(page, "To do");
  await todo.getByRole("button", { name: "Add a task", exact: true }).click();
  const composer = todo.getByLabel("Card title", { exact: true });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");

  // The first line is the title; the fake run lands the card in Done.
  const detail = await openDoneCard(page, title);
  await detail.getByRole("button", { name: "Edit description", exact: true }).click();
  await expect(detail.getByLabel("Description", { exact: true })).toHaveValue(text);
});
