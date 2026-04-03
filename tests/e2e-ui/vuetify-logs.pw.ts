import { test, expect } from "@playwright/test"
import { ensureServerRunning, uiUrl } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("Vuetify Activity", () => {
  test("renders Activity heading", async ({ page }) => {
    await page.goto(uiUrl("#/v/activity"))
    await expect(page.locator("main")).toContainText("Activity")
    await expect(page.locator("main")).toContainText("Recent Request Stream")
  })

  test("legacy /v/logs route redirects to /v/activity", async ({ page }) => {
    await page.goto(uiUrl("#/v/logs"))
    await page.waitForURL(/\/ui#\/v\/activity/)
    await expect(page.locator("main")).toContainText("Activity")
  })

  test("activity stream renders richer table headers", async ({ page }) => {
    await page.goto(uiUrl("#/v/activity"))
    await page.waitForTimeout(1500)

    const table = page.locator(".stream-table")
    const emptyState = page.getByText("No activity entries yet")

    const tableVisible = await table.isVisible().catch(() => false)
    const emptyVisible = await emptyState.isVisible().catch(() => false)
    expect(tableVisible || emptyVisible).toBeTruthy()

    if (tableVisible) {
      const headers = page.locator(".stream-table thead th")
      const headerTexts = await headers.allTextContents()

      expect(headerTexts.some((h) => h.includes("Time"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Endpoint"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Model"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("State"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Msgs"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Strm"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Cache"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Session"))).toBeTruthy()
      expect(headerTexts.some((h) => h.includes("Preview"))).toBeTruthy()
    }
  })

  test("entry count summary is visible", async ({ page }) => {
    await page.goto(uiUrl("#/v/activity"))
    await expect(page.getByText(/\d+ recent events/)).toBeVisible({ timeout: 10000 })
  })

  test("realtime panel keeps a fixed height", async ({ page }) => {
    await page.goto(uiUrl("#/v/activity"))

    const panel = page.getByTestId("activity-realtime-panel-body")
    await expect(panel).toBeVisible()

    const box = await panel.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(230)
    expect(Math.round(box!.height)).toBeLessThanOrEqual(260)
  })
})
