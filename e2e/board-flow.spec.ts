import { expect, test, type Page } from "@playwright/test";
import type { Task } from "@/lib/types";
import {
  AGENT_TIMEOUT,
  apiToken,
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

test("a card added in To do on an auto-run board moves to In progress and its agent runs", async ({
  page,
  request,
}) => {
  const board = await createProjectViaApi(request, uniqueName("autostart"));
  const title = uniqueName("Add a status page");

  await page.goto(`/b/${board.id}`);
  const todo = column(page, "To do");
  await expect(todo.getByText("No cards yet.")).toBeVisible();

  // Inline composer: Enter adds the card and keeps the composer open for the next one. A short
  // line is the title as typed (no card agent).
  await todo.getByRole("button", { name: "Add a task", exact: true }).click();
  const composer = todo.getByLabel("Card title", { exact: true });
  await composer.fill(title);
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await composer.press("Escape");
  await expect(todo.getByRole("button", { name: "Add a task", exact: true })).toBeVisible();

  // The card skips To do: its agent starts right away and the fake run lands it in Done.
  await expect(cardButton(column(page, "Done"), title)).toBeVisible({ timeout: AGENT_TIMEOUT });
  await expect(cardButton(todo, title)).toHaveCount(0);
  await expect(todo.getByText("No cards yet.")).toBeVisible();
});

test("new card from free text: it lands in In progress at once, the card agent writes it in the background", async ({
  page,
  request,
}) => {
  const board = await createProjectViaApi(request, uniqueName("writer"));
  const blocker = await createTaskViaApi(request, board.id, { title: uniqueName("Build the API"), status: "todo" });
  const firstLine = uniqueName("the stats page overflows on phones");
  const text = [
    firstLine,
    "and the numbers don't refresh until I reload.",
    `Do it after ${blocker.title} (${blocker.id}) is finished.`,
    "Split it in parallel if useful.",
  ].join("\n");

  await page.goto(`/b/${board.id}`);
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  const newCard = page.getByRole("dialog", { name: "New task" });
  // No switches to set: every new card starts, and the card agent decides on parallel subagents.
  await expect(newCard.getByRole("switch")).toHaveCount(0);
  await newCard.getByLabel("What should the agent do?", { exact: true }).fill(text);
  await newCard.getByRole("button", { name: "Create task" }).click();
  await expect(newCard).toBeHidden();

  // The card agent's card: the brief, parallel subagents, and the card it waits for.
  const inProgress = column(page, "In progress");
  await expect(cardButton(inProgress, firstLine)).toContainText("Waiting for 1", { timeout: AGENT_TIMEOUT });
  const tasks = (await (
    await request.get(`/api/v1/boards/${board.id}/tasks`, {
      headers: { authorization: `Bearer ${await apiToken(request)}` },
    })
  ).json()) as Task[];
  const created = tasks.find((t) => t.title === firstLine);
  expect(created?.status).toBe("in_progress");
  expect(created?.blockedBy).toEqual([blocker.id]);
  expect(created?.description).toContain(`## Goal\n\n${text}`);
  expect(created?.description).toContain("orchestrate: split this work into parallel subagent tasks");

  // When the card agent fails, the text as typed runs anyway, with a note on the card.
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  const failing = uniqueName("[fake-draft:fail] fix the login redirect");
  await newCard.getByLabel("What should the agent do?", { exact: true }).fill(`${failing}\nIt loops forever.`);
  await newCard.getByRole("button", { name: "Create task" }).click();
  await expect(newCard).toBeHidden();
  const done = column(page, "Done");
  await expect(cardButton(done, failing)).toBeVisible({ timeout: AGENT_TIMEOUT });
  await cardButton(done, failing).click();
  const detail = page.getByRole("dialog", { name: failing });
  await expect(detail.getByText(/The card agent couldn't write this card/)).toBeVisible();
});

test("card lifecycle: edit, feedback, agent run to Done, log, reopen by comment", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const board = await createProjectViaApi(request, uniqueName("lifecycle"));
  const title = uniqueName("Add a health check");
  const feedback = "Please also return the version";
  const followUp = "Now add a test for it too";
  await createTaskViaApi(request, board.id, { title });

  await page.goto(`/b/${board.id}`);
  const todo = column(page, "To do");
  await expect(cardButton(todo, title)).toBeVisible();

  // Open the detail panel: the URL carries the card id.
  await cardButton(todo, title).click();
  await expect(page).toHaveURL(/[?&]task=[^&]+/);
  const detail = page.getByRole("dialog", { name: title });
  await expect(detail.getByLabel("Card title", { exact: true })).toHaveValue(title);

  // The description starts collapsed; edit it and it persists, collapsed again, across a reload of the deep link.
  const descriptionToggle = detail.getByRole("button", { name: "Description", exact: true });
  await expect(descriptionToggle).toHaveAttribute("aria-expanded", "false");
  await expect(detail.getByLabel("Description", { exact: true })).toHaveCount(0);
  await descriptionToggle.click();
  const description = detail.getByLabel("Description", { exact: true });
  await description.fill("Expose GET /health\nReturn 200 with { ok: true }");
  await detail.getByRole("button", { name: "Save", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Save", exact: true })).toBeHidden();
  await page.reload();
  const reloaded = page.getByRole("dialog", { name: title });
  await expect(reloaded.getByRole("button", { name: "Description", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  // The collapsed preview shows the saved text and opens the editor focused.
  await reloaded.getByRole("button", { name: /^Expose GET \/health/ }).click();
  await expect(reloaded.getByLabel("Description", { exact: true })).toBeFocused();
  await expect(reloaded.getByLabel("Description", { exact: true })).toHaveValue(
    "Expose GET /health\nReturn 200 with { ok: true }",
  );

  // Feedback on a To do card is stored as an open comment for the coming run.
  await expect(detail.getByText("Feedback will be included when the agent starts")).toBeVisible();
  await detail.getByRole("textbox", { name: "Feedback", exact: true }).fill(feedback);
  await detail.getByRole("button", { name: "Send feedback" }).click();
  const firstFeedback = detail.getByRole("listitem").filter({ hasText: feedback });
  await expect(firstFeedback.getByText("Open", { exact: true })).toBeVisible();
  await expect(detail.getByRole("textbox", { name: "Feedback", exact: true })).toHaveValue("");

  // Start from the detail header: the card goes In progress, the fake agent runs and lands it in Done.
  const status = detail.getByRole("status", { name: "Status" });
  await expect(status).toHaveText(/To do/);
  await detail.getByRole("button", { name: "Start", exact: true }).click();
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
  // Steps view: a tool call reads as its intent; tapping it reveals the exact command.
  const toolCall = log.getByTestId("log-action").filter({ hasText: "Running the tests" });
  await expect(toolCall).toBeVisible();
  await toolCall.getByText("Running the tests").click();
  await expect(toolCall.getByText("npm test", { exact: true })).toBeVisible();
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

test("dragging a card to another column does nothing; its Start quick action runs the agent", async ({
  page,
  request,
}) => {
  const board = await createProjectViaApi(request, uniqueName("drag"));
  const title = uniqueName("Drag me");
  await createTaskViaApi(request, board.id, { title });

  await page.goto(`/b/${board.id}`);
  const todo = column(page, "To do");
  const target = column(page, "In progress");
  const card = cardButton(todo, title);
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
  await page.mouse.up();

  // The agent owns the status: the drop is ignored and the card stays in To do.
  await expect(card).toBeVisible();
  await expect(cardButton(target, title)).toHaveCount(0);
  await expect(target.getByText("Nothing in progress.", { exact: false })).toBeVisible();
  // Nothing was persisted either, and no agent started.
  await page.reload();
  await expect(card).toBeVisible();
  await expect(cardButton(target, title)).toHaveCount(0);
  expect(fakeOmpCallsIn(board.workdir).filter((entry) => entry.kind === "argv")).toHaveLength(0);

  // The hover quick action starts the agent; the card moves by itself and ends in Done.
  await card.hover();
  await todo.getByRole("button", { name: "Start", exact: true }).click();
  await expect(cardButton(column(page, "Done"), title)).toBeVisible({
    timeout: AGENT_TIMEOUT,
  });
  await expect(cardButton(todo, title)).toHaveCount(0);
  await expect(cardButton(target, title)).toHaveCount(0);

  // The run happened in the board's folder.
  expect(fakeOmpCallsIn(board.workdir).filter((entry) => entry.kind === "argv")).toHaveLength(1);
});

test("Stop aborts a slow run and leaves the card in In progress; Revert moves it back to To do", async ({
  page,
  request,
}) => {
  const board = await createProjectViaApi(request, uniqueName("stop"));
  const task = await createTaskViaApi(request, board.id, {
    title: `${SLOW_MARKER} ${uniqueName("Long job")}`,
  });

  await page.goto(`/b/${board.id}?task=${task.id}`);
  const detail = page.getByRole("dialog", { name: task.title });
  const status = detail.getByRole("status", { name: "Status" });
  await expect(status).toHaveText(/To do/);

  await detail.getByRole("button", { name: "Start", exact: true }).click();
  await expect(detail.getByText("Working", { exact: true })).toBeVisible({ timeout: AGENT_TIMEOUT });
  await expect(status).toHaveText(/In progress/);

  // Wait until omp actually received the prompt, so Stop interrupts a working agent.
  await detail.getByRole("tab", { name: /Agent log/ }).click();
  const log = detail.getByRole("tabpanel");
  await expect(log.getByText("Prompt sent to agent")).toBeVisible({ timeout: AGENT_TIMEOUT });
  await expect(log.getByText("Running", { exact: true })).toBeVisible();

  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Resume", exact: true })).toBeVisible({ timeout: AGENT_TIMEOUT });
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

  // Revert to To do: the stopped card goes back to To do and can be started again.
  await detail.getByRole("button", { name: "Revert to To do", exact: true }).click();
  await expect(status).toHaveText(/To do/);
  await expect(detail.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Revert to To do", exact: true })).toHaveCount(0);

  await detail.getByRole("button", { name: "Close", exact: true }).click();
  await expect(detail).toBeHidden();
  await expect(cardButton(column(page, "To do"), task.title)).toBeVisible();
  await expect(cardButton(column(page, "In progress"), task.title)).toHaveCount(0);
});

test("a failing agent keeps the card in In progress and explains the error", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("fail"));
  const task = await createTaskViaApi(request, board.id, {
    title: `[fake:error] ${uniqueName("Doomed")}`,
  });

  await page.goto(`/b/${board.id}?task=${task.id}`);
  const detail = page.getByRole("dialog", { name: task.title });
  await detail.getByRole("button", { name: "Start", exact: true }).click();

  // Retried automatically after 15 s; until then the card says so and Stop cancels the retry.
  await expect(detail.getByText("Agent failed — retrying automatically (retry 1)", { exact: true })).toBeVisible({
    timeout: AGENT_TIMEOUT,
  });
  await expect(detail.getByRole("alert").filter({ hasText: "Agent failed" })).toContainText(
    "Fake model error: upstream failed",
  );
  await expect(detail.getByRole("status", { name: "Status" })).toHaveText(/In progress/);
  await expect(detail.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  await detail.getByRole("button", { name: "Close", exact: true }).click();
  const card = cardButton(column(page, "In progress"), task.title);
  await expect(card).toContainText("Retrying");
});
