import { expect, test, type Page } from "@playwright/test";
import { AGENT_TIMEOUT, cardButton, createProjectViaApi, login, uniqueName } from "./helpers";

// The card writer is the fake omp's print mode: it titles the card with the request's first line,
// writes "## Goal\n\n<request>" as the brief, and obeys [fake-draft:<mode>] markers.

function column(page: Page, name: "To do" | "In progress" | "Done") {
  return page.getByRole("region", { name, exact: true });
}

/** Opens the header "New card" dialog with "Start agent now" off, so cards park in To do. */
async function openNewCard(page: Page) {
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  const newCard = page.getByRole("dialog", { name: "New card" });
  const startNow = newCard.getByRole("switch", { name: /Start agent now/ });
  // Auto-run boards start new cards right away.
  await expect(startNow).toBeChecked();
  await startNow.click();
  await expect(startNow).not.toBeChecked();
  return newCard;
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("Create card goes straight through the card agent, without a review step", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("straight"));
  const title = uniqueName("Cache the avatar thumbnails");
  const detailLine = "They are fetched again on every page view.";

  await page.goto(`/b/${board.id}`);
  const newCard = await openNewCard(page);
  await newCard.getByLabel("What should the agent do?", { exact: true }).fill(`${title}\n${detailLine}`);
  await newCard.getByRole("button", { name: "Create card" }).click();
  await expect(newCard).toBeHidden({ timeout: AGENT_TIMEOUT });

  const todo = column(page, "To do");
  await cardButton(todo, title).click();
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail.getByLabel("Description", { exact: true })).toHaveValue(`## Goal\n\n${title}\n${detailLine}`);
});

test("the card agent can be stopped: use the text as typed, or go back and edit it", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("draftstop"));
  // The slow fake reports one step, then never answers.
  const firstLine = `[fake-draft:slow] ${uniqueName("Rework the CSV importer")}`;
  const text = `${firstLine}\nKeep the old column order working.`;

  await page.goto(`/b/${board.id}`);
  const newCard = await openNewCard(page);
  const compose = newCard.getByLabel("What should the agent do?", { exact: true });
  await compose.fill(text);
  await newCard.getByRole("button", { name: "Review first" }).click();

  const writing = newCard.getByRole("status");
  await expect(writing).toContainText("Writing the card…");
  await expect(writing).toContainText("Finding the files involved", { timeout: AGENT_TIMEOUT });
  await newCard.getByRole("button", { name: "Use my text as typed" }).click();

  // Review step with the text as typed: first line as title, the whole text as description.
  await expect(writing).toBeHidden();
  await expect(newCard.getByLabel("Title", { exact: true })).toHaveValue(firstLine);
  await expect(newCard.getByLabel("Description", { exact: true })).toHaveValue(text);
  await expect(newCard.getByText("The card agent couldn't write this card")).toHaveCount(0);

  await newCard.getByRole("button", { name: "Edit text" }).click();
  await expect(compose).toHaveValue(text);
  await expect(newCard.getByLabel("Title", { exact: true })).toHaveCount(0);

  // Stop drops back to the text, ready to try again.
  await newCard.getByRole("button", { name: "Create card" }).click();
  await expect(writing).toContainText("Writing the card…");
  await newCard.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(writing).toBeHidden();
  await expect(compose).toHaveValue(text);
  await expect(compose).toBeEditable();
  await expect(newCard.getByRole("button", { name: "Review first" })).toBeEnabled();

  await newCard.getByRole("button", { name: "Cancel" }).click();
  await expect(newCard).toBeHidden();
  await expect(cardButton(page, firstLine)).toHaveCount(0);
});

test("the column composer sends longer text through the card agent", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("composer"));
  const title = uniqueName("Group the settings toggles");
  const detailLine = "Put the notification ones under their own heading.";

  await page.goto(`/b/${board.id}`);
  const todo = column(page, "To do");
  await todo.getByRole("button", { name: "Add a card", exact: true }).click();
  const composer = todo.getByLabel("Card title", { exact: true });
  await composer.fill(`${title}\n${detailLine}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("", { timeout: AGENT_TIMEOUT });

  // The agent's title is the first line; on an auto-run board the fake run lands the card in Done.
  const done = column(page, "Done");
  await expect(cardButton(done, title)).toBeVisible({ timeout: AGENT_TIMEOUT });
  await cardButton(done, title).click();
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail.getByLabel("Description", { exact: true })).toHaveValue(`## Goal\n\n${title}\n${detailLine}`);
});

test("a long request is attached to the card as brief.md", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("brief"));
  const title = uniqueName("Fix the monthly report exports");
  const steps = Array.from(
    { length: 40 },
    (_, index) => `- Report ${index + 1}: keep its columns and totals exactly as they are today.`,
  );
  const text = [title, ...steps].join("\n");
  expect(text.length).toBeGreaterThanOrEqual(2_000);

  await page.goto(`/b/${board.id}`);
  const newCard = await openNewCard(page);
  await newCard.getByLabel("What should the agent do?", { exact: true }).fill(text);
  await newCard.getByRole("button", { name: "Review first" }).click();
  await expect(newCard.getByLabel("Title", { exact: true })).toHaveValue(title, { timeout: AGENT_TIMEOUT });
  await expect(newCard.getByText(/Your full text is attached to the card as brief\.md/)).toBeVisible();
  await newCard.getByRole("button", { name: "Create card" }).click();
  await expect(newCard).toBeHidden();

  await cardButton(column(page, "To do"), title).click();
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail.getByLabel("Description", { exact: true })).toHaveValue(
    /The user's full original request, word for word, is in brief\.md among this card's files\./,
  );
  await expect(
    detail.getByRole("region", { name: "Files", exact: true }).getByRole("link", { name: "Download brief.md" }),
  ).toBeVisible();
});
