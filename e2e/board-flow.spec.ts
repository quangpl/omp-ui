import { expect, test, type Page } from "@playwright/test";
import {
  AGENT_TIMEOUT,
  cardButton,
  FAKE_SUCCESS_SUMMARY,
  SLOW_MARKER,
  createProjectViaApi,
  createTaskViaApi,
  fakeOmpCallsIn,
  login,
  uniqueName,
} from "./helpers";

function column(page: Page, name: "To do" | "In progress" | "Done") {
  return page.getByRole("region", { name, exact: true });
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("card lifecycle: compose, edit, feedback, agent run to Done, log, reopen by comment", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const board = await createProjectViaApi(request, uniqueName("lifecycle"));
  const title = uniqueName("Add a health check");
  const feedback = "Please also return the version";
  const followUp = "Now add a test for it too";

  await page.goto(`/b/${board.id}`);
  const todo = column(page, "To do");
  await expect(todo.getByText("No cards yet.")).toBeVisible();

  // Inline composer: Enter adds the card and keeps the composer open for the next one.
  await todo.getByRole("button", { name: "Add a card" }).click();
  const composer = todo.getByLabel("Card title", { exact: true });
  await composer.fill(title);
  await composer.press("Enter");
  await expect(cardButton(todo, title)).toBeVisible();
  await expect(composer).toHaveValue("");
  await composer.press("Escape");
  await expect(todo.getByRole("button", { name: "Add a card" })).toBeVisible();

  // Open the detail panel: the URL carries the card id.
  await cardButton(todo, title).click();
  await expect(page).toHaveURL(/[?&]task=[^&]+/);
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail.getByLabel("Card title", { exact: true })).toHaveValue(title);

  // Edit the description; it persists across a reload of the deep link.
  const description = detail.getByLabel("Description", { exact: true });
  await description.fill("Expose GET /health\nReturn 200 with { ok: true }");
  await detail.getByRole("button", { name: "Save", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Save", exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("dialog", { name: title }).getByLabel("Description", { exact: true })).toHaveValue(
    "Expose GET /health\nReturn 200 with { ok: true }",
  );

  // Feedback on a To do card is stored as an open comment for the coming run.
  await expect(detail.getByText("Feedback will be included when the agent starts")).toBeVisible();
  await detail.getByRole("textbox", { name: "Feedback", exact: true }).fill(feedback);
  await detail.getByRole("button", { name: "Send feedback" }).click();
  const firstFeedback = detail.getByRole("listitem").filter({ hasText: feedback });
  await expect(firstFeedback.getByText("Open", { exact: true })).toBeVisible();
  await expect(detail.getByRole("textbox", { name: "Feedback", exact: true })).toHaveValue("");

  // Move to In progress with the status select: the fake agent runs and the card lands in Done.
  const status = detail.getByRole("combobox", { name: "Status" });
  await status.click();
  await page.getByRole("option", { name: "In progress" }).click();
  await expect(status).toHaveText(/Done/, { timeout: AGENT_TIMEOUT });

  const agentReply = detail.getByRole("listitem").filter({ hasText: FAKE_SUCCESS_SUMMARY });
  await expect(agentReply).toHaveCount(1);
  await expect(agentReply.getByText("Agent", { exact: true })).toBeVisible();
  await expect(firstFeedback.getByText(/^Resolved/)).toBeVisible();
  await expect(firstFeedback.getByText("Open", { exact: true })).toHaveCount(0);

  // The agent log shows the run and its streamed events.
  await detail.getByRole("tab", { name: /Agent log/ }).click();
  const log = detail.getByRole("tabpanel");
  await expect(log.getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(log.getByText(/^Starting agent in /)).toBeVisible();
  await expect(log.getByText("bash: npm test")).toBeVisible();
  await expect(log.getByText(FAKE_SUCCESS_SUMMARY)).toBeVisible();
  await expect(log.getByText("Agent finished")).toBeVisible();

  // Commenting on a Done card reopens it; the agent resumes its session and finishes again.
  await detail.getByRole("tab", { name: /Activity/ }).click();
  await expect(
    detail.getByText("Sending feedback reopens this card and the agent continues"),
  ).toBeVisible();
  await detail.getByRole("textbox", { name: "Feedback", exact: true }).fill(followUp);
  await detail.getByRole("button", { name: "Send feedback" }).click();
  const secondFeedback = detail.getByRole("listitem").filter({ hasText: followUp });
  await expect(secondFeedback.getByText(/^Resolved/)).toBeVisible({ timeout: AGENT_TIMEOUT });
  await expect(agentReply).toHaveCount(2);
  await expect(status).toHaveText(/Done/);

  await detail.getByRole("tab", { name: /Agent log/ }).click();
  await expect(log.getByText("Runs", { exact: true })).toBeVisible();
  await expect(log.locator("button[aria-pressed]")).toHaveText([/Succeeded/, /Succeeded/]);
  await expect(log.locator('button[aria-pressed="true"]')).toHaveCount(1);
  await expect(log.getByText(/^Resuming agent session in /)).toBeVisible();
  // The second omp process was started with --resume on the first run's session file.
  const argvs = fakeOmpCallsIn(board.workdir).filter((entry) => entry.kind === "argv");
  expect(argvs).toHaveLength(2);
  expect(argvs[0].argv).not.toContain("--resume");
  expect(argvs[1].argv).toContain("--resume");

  // Closing the panel drops ?task= and the board shows the card in Done with its preview.
  await detail.getByRole("button", { name: "Close", exact: true }).click();
  await expect(detail).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]task=/);
  const doneCard = cardButton(column(page, "Done"), title);
  await expect(doneCard).toContainText("Expose GET /health");
  await expect(cardButton(todo, title)).toHaveCount(0);
});

test("dragging a card to In progress starts the agent and it ends in Done", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("drag"));
  const title = uniqueName("Drag me");
  await createTaskViaApi(request, board.id, { title });

  await page.goto(`/b/${board.id}`);
  const card = cardButton(column(page, "To do"), title);
  const target = column(page, "In progress");
  await expect(card).toBeVisible();
  await expect(target.getByText("Nothing in progress.", { exact: false })).toBeVisible();

  const from = await card.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("card or column has no layout box");
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Pass the 6px activation distance, then travel to the middle of the In progress column.
  await page.mouse.move(startX + 12, startY + 4, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 3, { steps: 25 });
  // While hovering, the placeholder already sits in the target column.
  await expect(cardButton(target, title)).toBeVisible();
  await page.mouse.up();

  await expect(cardButton(column(page, "Done"), title)).toBeVisible({
    timeout: AGENT_TIMEOUT,
  });
  await expect(cardButton(column(page, "To do"), title)).toHaveCount(0);
  await expect(cardButton(column(page, "In progress"), title)).toHaveCount(0);

  // The run happened in the board's folder.
  expect(fakeOmpCallsIn(board.workdir).filter((entry) => entry.kind === "argv")).toHaveLength(1);
});

test("Stop aborts a slow run and leaves the card in In progress", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("stop"));
  const task = await createTaskViaApi(request, board.id, {
    title: `${SLOW_MARKER} ${uniqueName("Long job")}`,
  });

  await page.goto(`/b/${board.id}?task=${task.id}`);
  const detail = page.getByRole("dialog", { name: task.title });
  const status = detail.getByRole("combobox", { name: "Status" });
  await expect(status).toHaveText(/To do/);

  await detail.getByRole("button", { name: "Run agent" }).click();
  await expect(detail.getByText("Working", { exact: true })).toBeVisible({ timeout: AGENT_TIMEOUT });
  await expect(status).toHaveText(/In progress/);

  // Wait until omp actually received the prompt, so Stop interrupts a working agent.
  await detail.getByRole("tab", { name: /Agent log/ }).click();
  const log = detail.getByRole("tabpanel");
  await expect(log.getByText("Prompt sent to agent")).toBeVisible({ timeout: AGENT_TIMEOUT });
  await expect(log.getByText("Running", { exact: true })).toBeVisible();

  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Run agent" })).toBeVisible({ timeout: AGENT_TIMEOUT });
  await expect(detail.getByText("Working", { exact: true })).toHaveCount(0);
  await expect(status).toHaveText(/In progress/);
  await expect(log.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(log.getByText("Stopped by user")).toBeVisible();

  // omp was asked to abort, and no summary was posted.
  await expect
    .poll(() => fakeOmpCallsIn(board.workdir).some((e) => e.kind === "command" && e.command?.type === "abort"))
    .toBe(true);
  await detail.getByRole("tab", { name: /Activity/ }).click();
  await expect(detail.getByText(/Fake summary/)).toHaveCount(0);

  await detail.getByRole("button", { name: "Close", exact: true }).click();
  await expect(cardButton(column(page, "In progress"), task.title)).toBeVisible();
});

test("a failing agent keeps the card in In progress and explains the error", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("fail"));
  const task = await createTaskViaApi(request, board.id, {
    title: `[fake:error] ${uniqueName("Doomed")}`,
  });

  await page.goto(`/b/${board.id}?task=${task.id}`);
  const detail = page.getByRole("dialog", { name: task.title });
  await detail.getByRole("button", { name: "Run agent" }).click();

  await expect(detail.getByText("Agent failed", { exact: true })).toBeVisible({ timeout: AGENT_TIMEOUT });
  await expect(detail.getByRole("alert").filter({ hasText: "Agent failed" })).toContainText(
    "Fake model error: rate limited",
  );
  await expect(detail.getByRole("combobox", { name: "Status" })).toHaveText(/In progress/);
  await expect(detail.getByRole("button", { name: "Retry" })).toBeVisible();

  await detail.getByRole("button", { name: "Close", exact: true }).click();
  const card = cardButton(column(page, "In progress"), task.title);
  await expect(card).toContainText("Failed");
});
