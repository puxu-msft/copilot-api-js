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

test.describe("Vuetify Logs", () => {
  test("renders Live Logs heading", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/logs")
    await expect(page.locator(".v-toolbar-title", { hasText: "Live Logs" })).toBeVisible()
  })

  test("table renders with correct headers", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/logs")

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
      expect(headerTexts.some((h) => h.includes("St"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Time"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Model"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Dur"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("In"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Out"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Preview"))).toBeTruthy()
    }
  })

  test("entry count chip is visible", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/logs")

    // The chip showing entry count should be visible (Vuetify 4 custom element)
    const countChip = page.locator(".v-chip", { hasText: /\d+ entries/ })
    await expect(countChip).toBeVisible({ timeout: 10000 })
  })
})
