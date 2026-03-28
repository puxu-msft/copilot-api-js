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

test.describe("Legacy Pages", () => {
  test("legacy /history/v3#/history renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/history")
    // Legacy history page uses the non-Vuetify layout (.app wrapper)
    await page.waitForTimeout(1000)
    // Should have the NavBar and no crash
    await expect(page.locator("nav.navbar")).toBeVisible()
    // Page content should be present (not a blank page)
    const bodyText = await page.locator("body").textContent()
    expect(bodyText).toBeTruthy()
  })

  test("legacy /history/v3#/logs renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/logs")
    await page.waitForTimeout(1000)
    await expect(page.locator("nav.navbar")).toBeVisible()
    const bodyText = await page.locator("body").textContent()
    expect(bodyText).toBeTruthy()
  })

  test("legacy /history/v3#/dashboard renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/dashboard")
    await page.waitForTimeout(1000)
    await expect(page.locator("nav.navbar")).toBeVisible()
    const bodyText = await page.locator("body").textContent()
    expect(bodyText).toBeTruthy()
  })

  test("legacy /history/v3#/models renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/models")
    await page.waitForTimeout(1000)
    await expect(page.locator("nav.navbar")).toBeVisible()
    const bodyText = await page.locator("body").textContent()
    expect(bodyText).toBeTruthy()
  })

  test("legacy /history/v3#/usage renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/usage")
    await page.waitForTimeout(1000)
    await expect(page.locator("nav.navbar")).toBeVisible()
    const bodyText = await page.locator("body").textContent()
    expect(bodyText).toBeTruthy()
  })

  test("no console errors on legacy pages", async ({ page }) => {
    const consoleErrors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text())
      }
    })

    const legacyRoutes = [
      "http://localhost:4141/history/v3#/history",
      "http://localhost:4141/history/v3#/logs",
      "http://localhost:4141/history/v3#/dashboard",
      "http://localhost:4141/history/v3#/models",
      "http://localhost:4141/history/v3#/usage",
    ]

    for (const route of legacyRoutes) {
      consoleErrors.length = 0
      await page.goto(route)
      await page.waitForTimeout(1500)

      // Filter out expected/benign errors (e.g. WebSocket connection, network)
      const realErrors = consoleErrors.filter(
        (e) => !e.includes("WebSocket") && !e.includes("net::") && !e.includes("favicon"),
      )
      expect(realErrors).toEqual([])
    }
  })
})
