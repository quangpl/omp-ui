import { expect, test, type Page } from "@playwright/test";
import { AGENT_TIMEOUT, cardButton, createProjectViaApi, login, uniqueName } from "./helpers";

// The card writer is the fake omp's helper: it titles the card with the request's first line,
// writes "## Goal\n\n<request>" as the brief, and obeys [fake-draft:<mode>] markers.

function column(page: Page, name: "To do" | "In progress" | "Done") {
  return page.getByRole("region", { name, exact: true });
}

async function openNewCard(page: Page) {
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  return page.getByRole("dialog", { name: "New task" });
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("Create task never waits for the card agent: the card is written in the background", async ({
  page,
  request,
}) => {
  const board = await createProjectViaApi(request, uniqueName("background"));
  // The slow fake reports one step, then never answers: the card stays with its writer.
  const slowLine = `[fake-draft:slow] ${uniqueName("Rework the CSV importer")}`;
  const title = uniqueName("Cache the avatar thumbnails");
  const detailLine = "They are fetched again on every page view.";

  await page.goto(`/b/${board.id}`);
  let newCard = await openNewCard(page);
  await newCard.getByLabel("What should the agent do?", { exact: true }).fill(`${slowLine}\nKeep the old column order working.`);
  await newCard.getByRole("button", { name: "Create task" }).click();
  await expect(newCard).toBeHidden();

  // In progress right away, titled as typed, while the card agent works on it.
  const inProgress = column(page, "In progress");
  const writing = cardButton(inProgress, slowLine);
  await expect(writing).toContainText("Writing card");
  await expect(writing).toContainText("Finding the files involved", { timeout: AGENT_TIMEOUT });

  // Meanwhile the next card can be added; it is written and run to Done on its own.
  newCard = await openNewCard(page);
  await newCard.getByLabel("What should the agent do?", { exact: true }).fill(`${title}\n${detailLine}`);
  await newCard.getByRole("button", { name: "Create task" }).click();
  await expect(newCard).toBeHidden();
  const done = column(page, "Done");
  await expect(cardButton(done, title)).toBeVisible({ timeout: AGENT_TIMEOUT });
  // The first card is still being written: its run waits.
  await expect(writing).toContainText("Writing card");
  await cardButton(done, title).click();
  const detail = page.getByRole("dialog", { name: title });
  await detail.getByRole("button", { name: "Edit description", exact: true }).click();
  await expect(detail.getByLabel("Description", { exact: true })).toHaveValue(`## Goal\n\n${title}\n${detailLine}`);
});

test("the column composer sends longer text through the card agent", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("composer"));
  const title = uniqueName("Group the settings toggles");
  const detailLine = "Put the notification ones under their own heading.";

  await page.goto(`/b/${board.id}`);
  const todo = column(page, "To do");
  await todo.getByRole("button", { name: "Add a task", exact: true }).click();
  const composer = todo.getByLabel("Card title", { exact: true });
  await composer.fill(`${title}\n${detailLine}`);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");

  // The agent's title is the first line; the fake run lands the card in Done.
  const done = column(page, "Done");
  await expect(cardButton(done, title)).toBeVisible({ timeout: AGENT_TIMEOUT });
  await cardButton(done, title).click();
  const detail = page.getByRole("dialog", { name: title });
  await detail.getByRole("button", { name: "Edit description", exact: true }).click();
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
  await newCard.getByRole("button", { name: "Create task" }).click();
  await expect(newCard).toBeHidden();

  const done = column(page, "Done");
  await expect(cardButton(done, title)).toBeVisible({ timeout: AGENT_TIMEOUT });
  await cardButton(done, title).click();
  const detail = page.getByRole("dialog", { name: title });
  await detail.getByRole("button", { name: "Edit description", exact: true }).click();
  await expect(detail.getByLabel("Description", { exact: true })).toHaveValue(
    /The user's full original request, word for word, is in brief\.md among this card's files\./,
  );
  await expect(
    detail.getByRole("region", { name: "Files", exact: true }).getByRole("link", { name: "Download brief.md" }),
  ).toBeVisible();
});
