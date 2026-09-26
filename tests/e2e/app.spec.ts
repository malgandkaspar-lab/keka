import { expect, test, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "admin@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "a-very-secure-password-123";
const SHOTS = process.env.E2E_SCREENSHOTS;

async function signIn(page: Page) {
  await page.goto("/register");
  if (await page.getByRole("button", { name: "Create account" }).isVisible().catch(() => false)) {
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    const failed = await page.getByText("already exists").isVisible({ timeout: 3000 }).catch(() => false);
    if (!failed) {
      await page.waitForURL("/");
      return;
    }
  }
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}

test("unauthenticated users are redirected to sign in", async ({ page }) => {
  await page.goto("/videos");
  await expect(page).toHaveURL(/\/(login|register)$/);
});

test("navigation, generation form and live pipeline status", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });

  for (const [label, heading] of [
    ["Videos", "Videos"],
    ["Topics", "Topics"],
    ["Schedules", "Schedules · Auto mode"],
    ["YouTube", "YouTube"],
    ["Analytics", "Analytics"],
    ["Settings", "Settings"],
    ["Logs", "Logs"],
  ] as const) {
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${label.toLowerCase()}.png`, fullPage: true });
  }

  await page.getByRole("link", { name: "Generate", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Generate a Short" })).toBeVisible();
  await page.getByLabel("Topic").fill("Why do astronauts grow taller in space?");
  await page.getByLabel("Category").selectOption("space");
  await page.getByLabel("Duration").selectOption("30");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/generate.png`, fullPage: true });
  await page.getByRole("button", { name: "GENERATE SHORT" }).click();

  await page.waitForURL(/\/videos\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Generation progress")).toBeVisible();
  // The worker picks the job up and the live log shows pipeline events.
  await expect(page.getByText(/Researching|Research completed|Missing credential/).first()).toBeVisible({ timeout: 60_000 });
  if (SHOTS) {
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${SHOTS}/video.png`, fullPage: true });
  }
});

test("switching to automatic topic mode disables manual topic entry", async ({ page }) => {
  await signIn(page);
  await page.goto("/generate");
  await page.getByRole("button", { name: "Generate topic automatically" }).click();
  await expect(page.getByLabel("Topic")).toBeDisabled();
  await expect(page.getByRole("button", { name: "GENERATE SHORT" })).toBeEnabled();
});
