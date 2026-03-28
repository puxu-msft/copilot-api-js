import { test, expect } from "@playwright/test"

const BASE_URL = "http://localhost:4141"

test.beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`)
    if (!res.ok) throw new Error(`Health check returned ${res.status}`)
  } catch (error) {
    throw new Error(
      `Server is not running at ${BASE_URL}. Start the server before running E2E tests. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
})

test.describe("Vuetify Usage", () => {
  test("renders Usage heading", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/usage")
    await expect(page.locator(".v-toolbar-title", { hasText: "Usage" })).toBeVisible()
  })

  test("Account card renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/usage")

    const accountCard = page.locator(".v-card", { hasText: "Account" })
    await expect(accountCard).toBeVisible({ timeout: 10000 })

    // Should show account info or "No account info"
    const hasPlan = await accountCard.getByText("Plan").isVisible().catch(() => false)
    const hasNoInfo = await accountCard.getByText("No account info").isVisible().catch(() => false)
    expect(hasPlan || hasNoInfo).toBeTruthy()
  })

  test("Quota card renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/usage")

    const quotaCard = page.locator(".v-card", { hasText: "Quota" }).first()
    await expect(quotaCard).toBeVisible({ timeout: 10000 })

    // Should show quota items or "No quota data available"
    const hasProgressBar = await quotaCard.locator(".v-progress-linear").count()
    const hasNoData = await quotaCard.getByText("No quota data available").isVisible().catch(() => false)
    expect(hasProgressBar > 0 || hasNoData).toBeTruthy()
  })

  test("Session Tokens card renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/usage")

    const sessionCard = page.locator(".v-card", { hasText: "Session Tokens" })
    await expect(sessionCard).toBeVisible({ timeout: 10000 })

    // Should show token counts or "No session data"
    const hasInputTokens = await sessionCard.getByText("Input Tokens").isVisible().catch(() => false)
    const hasNoSession = await sessionCard.getByText("No session data").isVisible().catch(() => false)
    expect(hasInputTokens || hasNoSession).toBeTruthy()
  })

  test("Model Distribution card renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/usage")

    const distCard = page.locator(".v-card", { hasText: "Model Distribution" })
    await expect(distCard).toBeVisible({ timeout: 10000 })

    // Should show model data or "No model data"
    const hasProgressBar = await distCard.locator(".v-progress-linear").count()
    const hasNoData = await distCard.getByText("No model data").isVisible().catch(() => false)
    expect(hasProgressBar > 0 || hasNoData).toBeTruthy()
  })
})
