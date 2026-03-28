import { test, expect } from "@playwright/test"
import { BASE_URL, ensureServerRunning, uiUrl } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("Navigation", () => {
  test("/history is not a UI entrypoint", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/history`)
    expect(response).not.toBeNull()
    expect(response?.status()).toBe(404)
  })

  test("/ui loads and shows the NavBar", async ({ page }) => {
    await page.goto(uiUrl())
    // NavBar should be visible with the brand text
    const navbar = page.locator("nav.navbar")
    await expect(navbar).toBeVisible()
    await expect(navbar.locator(".navbar-brand")).toHaveText("copilot-api")
  })

  test("default route goes to /v/dashboard", async ({ page }) => {
    await page.goto(uiUrl())
    // The hash router defaults to /v/dashboard
    await page.waitForURL(/\/ui#\/v\/dashboard/)
    await expect(page.locator("main")).toContainText("Authentication")
  })

  test("clicking History nav link navigates to /v/history", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    await page.locator("a.nav-link", { hasText: "History" }).click()
    await page.waitForURL(/\/ui#\/v\/history/)
    // History page renders a navigation drawer with a toolbar containing "History" text
    await expect(page.locator(".v-navigation-drawer")).toBeVisible({ timeout: 10000 })
  })

  test("clicking Logs nav link navigates to /v/logs", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    await page.locator("a.nav-link", { hasText: "Logs" }).click()
    await page.waitForURL(/\/ui#\/v\/logs/)
    await expect(page.locator("main")).toContainText("Live Logs")
  })

  test("clicking Dashboard nav link navigates to /v/dashboard", async ({ page }) => {
    await page.goto(uiUrl("#/v/logs"))
    await page.locator("a.nav-link", { hasText: "Dashboard" }).click()
    await page.waitForURL(/\/ui#\/v\/dashboard/)
    await expect(page.locator("main")).toContainText("Authentication")
  })

  test("clicking Models nav link navigates to /v/models", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    await page.locator("a.nav-link", { hasText: "Models" }).click()
    await page.waitForURL(/\/ui#\/v\/models/)
    await expect(page.getByPlaceholder("Search models...")).toBeVisible()
  })

  test("clicking Usage nav link navigates to /v/usage", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    await page.locator("a.nav-link", { hasText: "Usage" }).click()
    await page.waitForURL(/\/ui#\/v\/usage/)
    await expect(page.locator("main")).toContainText("Quota")
  })
})
