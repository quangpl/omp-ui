import { expect, test, type Page } from "@playwright/test";
import type { Comment, Task } from "@/lib/types";
import {
  AGENT_TIMEOUT,
  FAKE_SUCCESS_SUMMARY,
  SLOW_MARKER,
  apiToken,
  cardButton,
  createProjectViaApi,
  createTaskViaApi,
  gotoProjects,
  login,
  openSecondSession,
  uniqueName,
} from "./helpers";

// Live updates over SSE: every assertion here holds without reloading the observing page.

declare global {
  interface Window {
    /** Set by markNoReload; a reload would drop it. */
    __e2eNoReload?: boolean;
  }
}

const STREAM_MARKER = "[fake:stream]";

function column(page: Page, name: "To do" | "In progress" | "Done") {
  return page.getByRole("region", { name, exact: true });
}

function connectionPill(page: Page) {
  return page.getByRole("banner").getByRole("status");
}

/** Flags the document so a later check proves the page was never reloaded. */
async function markNoReload(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__e2eNoReload = true;
  });
}

async function expectNotReloaded(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__e2eNoReload)).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("the board header shows the live connection pill", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("pill"));
  await page.goto(`/b/${board.id}`);
  await expect(connectionPill(page)).toContainText("Live");
  await expect(connectionPill(page)).not.toContainText("Reconnecting");
});

test("two sessions on one board see each other's card changes live", async ({ page, request, browser }) => {
  test.setTimeout(90_000);
  const board = await createProjectViaApi(request, uniqueName("shared"));
  const title = uniqueName("Shared card");
  const comment = "Seen from the other tab?";
  const second = await openSecondSession(browser);
  const other = second.page;
  try {
    await page.goto(`/b/${board.id}`);
    await other.goto(`/b/${board.id}`);
    await expect(connectionPill(page)).toContainText("Live");
    await expect(connectionPill(other)).toContainText("Live");
    await markNoReload(other);

    // Create in A → appears in B; it starts on its own and the run lands it in Done in both tabs.
    const todo = column(page, "To do");
    await page.getByRole("button", { name: "Add card", exact: true }).click();
    const newCard = page.getByRole("dialog", { name: "New card" });
    await newCard.getByLabel("What should the agent do?", { exact: true }).fill(title);
    await newCard.getByRole("button", { name: "Create card" }).click();
    await expect(newCard).toBeHidden({ timeout: AGENT_TIMEOUT });
    await expect(cardButton(column(page, "Done"), title)).toBeVisible({ timeout: AGENT_TIMEOUT });
    await expect(cardButton(column(other, "Done"), title)).toBeVisible({ timeout: AGENT_TIMEOUT });

    await cardButton(column(page, "Done"), title).click();
    const detail = page.getByRole("dialog", { name: title });
    const status = detail.getByRole("status", { name: "Status" });
    await expect(status).toHaveText(/Done/);

    // A reverts it → B sees it back in To do.
    await detail.getByRole("button", { name: "Revert to To do", exact: true }).click();
    await expect(status).toHaveText(/To do/);
    await expect(cardButton(column(other, "To do"), title)).toBeVisible();
    await expect(cardButton(column(other, "Done"), title)).toHaveCount(0);

    // B opens the same card (with the agent's summary); A's comment shows up in B's open drawer
    // (To do: no agent starts).
    await cardButton(column(other, "To do"), title).click();
    const otherDetail = other.getByRole("dialog", { name: title });
    await expect(otherDetail.getByRole("listitem").filter({ hasText: FAKE_SUCCESS_SUMMARY })).toHaveCount(1);
    await detail.getByRole("textbox", { name: "Feedback", exact: true }).fill(comment);
    await detail.getByRole("button", { name: "Send feedback" }).click();
    const otherComment = otherDetail.getByRole("listitem").filter({ hasText: comment });
    await expect(otherComment).toBeVisible();
    await expect(otherComment.getByText("Open", { exact: true })).toBeVisible();

    // Delete in A → B's drawer closes and the card disappears.
    await detail.getByRole("button", { name: "Delete card", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete this card?" });
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(detail).toBeHidden();
    await expect(cardButton(todo, title)).toHaveCount(0);

    await expect(otherDetail).toBeHidden();
    await expect(other.getByText("This card was deleted")).toBeVisible();
    await expect(cardButton(column(other, "To do"), title)).toHaveCount(0);
    await expect(column(other, "To do").getByText("No cards yet.")).toBeVisible();
    await expectNotReloaded(other);
  } finally {
    await second.context.close();
  }
});

test("the agent log streams output live, then shows the persisted result", async ({ page, request }) => {
  const board = await createProjectViaApi(request, uniqueName("stream"));
  const task = await createTaskViaApi(request, board.id, {
    title: `${STREAM_MARKER} ${uniqueName("Streamed")}`,
  });

  await page.goto(`/b/${board.id}?task=${task.id}`);
  await markNoReload(page);
  const detail = page.getByRole("dialog", { name: task.title });
  await detail.getByRole("tab", { name: /Agent log/ }).click();
  const log = detail.getByRole("tabpanel");
  await expect(log.getByText("The agent hasn't run on this card yet", { exact: false })).toBeVisible();

  await detail.getByRole("button", { name: "Start", exact: true }).click();
  const live = detail.getByTestId("live-output");
  await expect(live).toBeVisible({ timeout: AGENT_TIMEOUT });

  // Sample without auto-waiting: the block disappears as soon as the message is persisted.
  const liveText = () =>
    page.evaluate(() => document.querySelector('[data-testid="live-output"]')?.textContent ?? null);
  let first = 0;
  await expect
    .poll(async () => (first = (await liveText())?.length ?? 0), { intervals: [25] })
    .toBeGreaterThan(0);
  await expect
    .poll(async () => (await liveText())?.length ?? 0, { intervals: [25] })
    .toBeGreaterThan(first);

  // Message end: the live block is replaced by the persisted text and the card is Done.
  await expect(live).toBeHidden({ timeout: AGENT_TIMEOUT });
  await expect(detail.getByRole("status", { name: "Status" })).toHaveText(/Done/, {
    timeout: AGENT_TIMEOUT,
  });
  await expect(log.getByText("Succeeded", { exact: true })).toBeVisible();

  const res = await request.get(`/api/v1/tasks/${task.id}`, {
    headers: { Authorization: `Bearer ${await apiToken(request)}` },
  });
  expect(res.status()).toBe(200);
  const { comments } = (await res.json()) as { task: Task; comments: Comment[] };
  const summary = comments.find((c) => c.author === "agent")?.body.trim() ?? "";
  expect(summary, "agent summary comment").not.toBe("");
  const firstLine = summary.split("\n")[0];
  await expect(log.getByText(firstLine, { exact: false }).first()).toBeVisible();

  await detail.getByRole("button", { name: "Close", exact: true }).click();
  await expect(cardButton(column(page, "Done"), task.title)).toBeVisible();
  await expectNotReloaded(page);
});

test("the Projects page follows counts and the running indicator live", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(90_000);
  const name = uniqueName("watched");
  const board = await createProjectViaApi(request, name);
  // Slow: stays running until feedback is steered in, so the indicator is observable.
  const task = await createTaskViaApi(request, board.id, { title: `${SLOW_MARKER} ${uniqueName("Watch me")}` });
  const second = await openSecondSession(browser);
  const other = second.page;
  try {
    await gotoProjects(other);
    await markNoReload(other);
    const projectCard = other
      .getByRole("article")
      .filter({ has: other.getByRole("link", { name, exact: true }) });
    await expect(projectCard).toContainText(/To do\s*1(?!\d)/);
    await expect(projectCard).not.toContainText("running");

    // A starts the card.
    await page.goto(`/b/${board.id}?task=${task.id}`);
    const detail = page.getByRole("dialog", { name: task.title });
    await detail.getByRole("button", { name: "Start", exact: true }).click();
    await expect(detail.getByText("Working", { exact: true })).toBeVisible({ timeout: AGENT_TIMEOUT });

    await expect(projectCard).toContainText(/In progress\s*1(?!\d)/);
    await expect(projectCard).toContainText(/To do\s*0(?!\d)/);
    await expect(projectCard).toContainText("1 running");

    // Feedback finishes the slow run → Done, indicator gone.
    await detail.getByRole("textbox", { name: "Feedback", exact: true }).fill("Wrap it up");
    await detail.getByRole("button", { name: "Send feedback" }).click();
    await expect(projectCard).toContainText(/Done\s*1(?!\d)/, { timeout: AGENT_TIMEOUT });
    await expect(projectCard).toContainText(/In progress\s*0(?!\d)/);
    await expect(projectCard).not.toContainText("running");
    await expectNotReloaded(other);
  } finally {
    await second.context.close();
  }
});
