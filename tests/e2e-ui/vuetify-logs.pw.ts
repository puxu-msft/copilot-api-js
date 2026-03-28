import { test, expect } from "@playwright/test"
import { ensureServerRunning, uiUrl } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("Vuetify Logs", () => {
  test("renders Live Logs heading", async ({ page }) => {
    await page.goto(uiUrl("#/v/logs"))
    await expect(page.locator("main")).toContainText("Live Logs")
  })

  test("table renders with correct headers", async ({ page }) => {
    await page.goto(uiUrl("#/v/logs"))

    // Wait for page to load
    await page.waitForTimeout(2000)

    // Check if table exists or "No log entries yet" is shown
    const table = page.locator(".v-table")
    const emptyState = page.getByText("No log entries yet")

    const tableVisible = await table.isVisible().catch(() => false)
    const emptyVisible = await emptyState.isVisible().catch(() => false)

    expect(tableVisible || emptyVisible).toBeTruthy()

    if (tableVisible) {
      // Verify table headers
      const headers = page.locator("thead th")
      const headerTexts = await headers.allTextContents()

      // Should have expected column headers
      expect(headerTexts.some((h) => h.includes("Time"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Model"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Dur"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("In"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Out"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Preview"))).toBeTruthy()
    }
  })

  test("entry count chip is visible", async ({ page }) => {
    await page.goto(uiUrl("#/v/logs"))

    const countChip = page.getByText(/\d+ entries/)
    await expect(countChip).toBeVisible({ timeout: 10000 })
  })
})
