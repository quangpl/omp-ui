import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import type { Board, Task, TaskStatus } from "@/lib/types";

// Shared by playwright.config.ts (server env) and the specs (fixtures on disk, login).
export const PORT = 3210;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const ADMIN_PASSWORD = "e2e-password-123";
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Wiped by the webServer command before every run. */
export const E2E_DATA_DIR = path.join(REPO_ROOT, ".e2e-data");
export const WORKSPACE_DIR = path.join(E2E_DATA_DIR, "ws");
export const PROJECTS_DIR = path.join(E2E_DATA_DIR, "projects");
export const FAKE_OMP_PATH = path.join(REPO_ROOT, "tests", "fixtures", "fake-omp.mjs");

/** Generous bound for a full fake agent run (spawn node + RPC handshake + DB writes + SSE). */
export const AGENT_TIMEOUT = 30_000;
/** Summary the fake omp posts for the default "success" scenario. */
export const FAKE_SUCCESS_SUMMARY = "Fake summary: implemented the task and ran the tests.";
/** A card title containing this marker makes the fake omp hang until steered or aborted. */
export const SLOW_MARKER = "[fake:slow]";
/** JSON-lines call log the fake omp appends to (FAKE_OMP_LOG in playwright.config.ts). */
export const FAKE_OMP_LOG = path.join(E2E_DATA_DIR, "fake-omp", "calls.jsonl");

export interface FakeOmpLogEntry {
  pid: number;
  kind: "argv" | "command" | "ui_response" | "steer" | "stdin_closed";
  argv?: string[];
  cwd?: string;
  command?: { type: string; [key: string]: unknown };
  message?: string;
}

/** Everything fake omp processes started in `workdir` logged so far (oldest first). */
export function fakeOmpCallsIn(workdir: string): FakeOmpLogEntry[] {
  if (!existsSync(FAKE_OMP_LOG)) return [];
  const entries = readFileSync(FAKE_OMP_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeOmpLogEntry);
  // The child reports process.cwd(), which resolves symlinks.
  const dirs = new Set([workdir, realpathSync(workdir)]);
  const pids = new Set(
    entries.filter((e) => e.kind === "argv" && e.cwd && dirs.has(e.cwd)).map((e) => e.pid),
  );
  return entries.filter((e) => pids.has(e.pid));
}

let counter = 0;
/** Unique, filesystem-safe name so tests never collide on the shared server. */
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 6)}`;
}

/** Signs in through the login form and waits until the app lands on `/`. */
export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

/**
 * Opens the Projects page and waits until the client has loaded the list (the page is
 * interactive only after hydration + fetch, so clicking earlier could hit dead SSR markup).
 */
export async function gotoProjects(page: Page): Promise<void> {
  await page.goto("/");
  await expect(
    page.getByText(/tap one to open its board/).or(page.getByText("Create your first project")),
  ).toBeVisible();
}

/**
 * A second, independently signed-in browser session (own cookies and SSE stream), sized like
 * the desktop project: `browser.newContext()` does not inherit the project's `use` options.
 */
export async function openSecondSession(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await login(page);
  return { context, page };
}

const tokens = new WeakMap<APIRequestContext, string>();

/** Bearer token for API setup calls (cached per request context). */
export async function apiToken(request: APIRequestContext): Promise<string> {
  const cached = tokens.get(request);
  if (cached) return cached;
  const res = await request.post("/api/v1/auth/login", { data: { password: ADMIN_PASSWORD } });
  expect(res.status(), await res.text()).toBe(200);
  const { token } = (await res.json()) as { token: string };
  tokens.set(request, token);
  return token;
}

async function authHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await apiToken(request)}` };
}

/** Creates a fresh project folder on disk and a board for it (auto-run on). */
export async function createProjectViaApi(request: APIRequestContext, name: string): Promise<Board> {
  mkdirSync(PROJECTS_DIR, { recursive: true });
  const workdir = mkdtempSync(path.join(PROJECTS_DIR, `${name}-`));
  const res = await request.post("/api/v1/boards", {
    headers: await authHeaders(request),
    data: { name, workdir, autoRun: true },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Board;
}

export async function createTaskViaApi(
  request: APIRequestContext,
  boardId: string,
  input: { title: string; description?: string; status?: TaskStatus },
): Promise<Task> {
  const res = await request.post(`/api/v1/boards/${encodeURIComponent(boardId)}/tasks`, {
    headers: await authHeaders(request),
    data: input,
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Task;
}

/** The page must not scroll sideways (a classic mobile layout bug). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  // Mobile Chromium zooms out to fit overflowing content, which would widen innerWidth too,
  // so also hold the page to the emulated device width.
  const deviceWidth = page.viewportSize()?.width ?? innerWidth;
  const limit = Math.min(innerWidth, deviceWidth);
  expect(scrollWidth, `page is ${scrollWidth}px wide in a ${limit}px viewport`).toBeLessThanOrEqual(limit);
}

/**
 * A card's open button. Its accessible name is the title plus badges/preview (and a leading
 * "Done" icon label in Done), so match from the start of the name: a plain substring would also
 * hit the "More actions for <title>" menu button on phones.
 */
export function cardButton(scope: Page | Locator, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return scope.getByRole("button", { name: new RegExp(`^(?:Done\\s*)?${escaped}`) });
}

/** Minimum comfortable touch target (Apple HIG / WCAG 2.5.5). */
const MIN_TOUCH = 44;
/** Device-pixel rounding can shave a fraction off an exact 44px box on a 2.625x DPR screen. */
const ROUNDING = 0.5;

export async function expectTouchTarget(locator: Locator, label: string): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has no layout box`).not.toBeNull();
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(MIN_TOUCH - ROUNDING);
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TOUCH - ROUNDING);
}

/** Accessible name of a mobile column tab, e.g. "To do · 2". */
export function columnTabName(label: string, count: number): RegExp {
  return new RegExp(`^${label}\\s*·\\s*${count}$`);
}
