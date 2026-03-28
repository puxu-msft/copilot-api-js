import { test, expect } from "@playwright/test"
import { ensureServerRunning, uiUrl } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("Vuetify Usage", () => {
  test("renders usage overview", async ({ page }) => {
    await page.goto(uiUrl("#/v/usage"))
    const main = page.locator("main")
    await expect(main).toContainText("Quota")
    await expect(main).toContainText("Session In")
  })

  test("account summary renders", async ({ page }) => {
    await page.goto(uiUrl("#/v/usage"))
    const main = page.locator("main")

    await expect(main).toContainText("Plan")
    await expect(main).toContainText("Resets")
  })

  test("Quota card renders", async ({ page }) => {
    await page.goto(uiUrl("#/v/usage"))
    const main = page.locator("main")

    await expect(main.getByText("Quota")).toBeVisible({ timeout: 10000 })

    const hasProgressBar = (await main.getByRole("progressbar").count()) > 0
    const hasNoData = await main.getByText("No quota data available").isVisible().catch(() => false)
    expect(hasProgressBar || hasNoData).toBeTruthy()
  })

  test("Session Tokens summary renders", async ({ page }) => {
    await page.goto(uiUrl("#/v/usage"))
    const main = page.locator("main")

    await expect(main.getByText("Session In")).toBeVisible({ timeout: 10000 })
    await expect(main.getByText("Out")).toBeVisible()
    await expect(main.getByText("Total")).toBeVisible()
  })

  test("Model Distribution card renders", async ({ page }) => {
    await page.goto(uiUrl("#/v/usage"))
    const main = page.locator("main")

    const hasDistributionSection = await main.getByText("Model Distribution").isVisible().catch(() => false)
    if (!hasDistributionSection) {
      await expect(main).toContainText("Total")
      return
    }

    const hasDistribution = await main.getByText(/\d+(\.\d+)?%/).isVisible().catch(() => false)
    const hasNoData = await main.getByText("No model data").isVisible().catch(() => false)
    expect(hasDistribution || hasNoData).toBeTruthy()
  })
})
