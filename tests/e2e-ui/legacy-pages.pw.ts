import { test, expect } from "@playwright/test"
import { ensureServerRunning, uiUrl } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("Legacy Pages", () => {
  test("legacy /ui#/history renders", async ({ page }) => {
    await page.goto(uiUrl("#/history"))
    // Legacy history page uses the non-Vuetify layout (.app wrapper)
    await page.waitForTimeout(1000)
    // Should have the NavBar and no crash
    await expect(page.locator("nav.navbar")).toBeVisible()
    // Page content should be present (not a blank page)
    const bodyText = await page.locator("body").textContent()
    expect(bodyText).toBeTruthy()
  })

  test("legacy /ui#/logs renders", async ({ page }) => {
    await page.goto(uiUrl("#/logs"))
    await page.waitForTimeout(1000)
    await expect(page.locator("nav.navbar")).toBeVisible()
    const bodyText = await page.locator("body").textContent()
    expect(bodyText).toBeTruthy()
  })

  test("legacy /ui#/dashboard redirects to the Vuetify dashboard", async ({ page }) => {
    await page.goto(uiUrl("#/dashboard"))
    await page.waitForURL(/\/ui#\/v\/dashboard/)
    await expect(page.locator(".v-app-bar")).toBeVisible()
  })

  test("legacy /ui#/models redirects to the Vuetify models page", async ({ page }) => {
    await page.goto(uiUrl("#/models"))
    await page.waitForURL(/\/ui#\/v\/models/)
    await expect(page.locator(".toolbar-shell")).toBeVisible()
  })

  test("legacy /ui#/usage redirects to the Vuetify dashboard", async ({ page }) => {
    await page.goto(uiUrl("#/usage"))
    await page.waitForURL(/\/ui#\/v\/dashboard/)
    await expect(page.locator(".v-app-bar")).toBeVisible()
  })

  test("no console errors on legacy pages", async ({ page }) => {
    const consoleErrors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text())
      }
    })

    const legacyRoutes = [
      uiUrl("#/history"),
      uiUrl("#/logs"),
      uiUrl("#/dashboard"),
      uiUrl("#/models"),
      uiUrl("#/usage"),
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
