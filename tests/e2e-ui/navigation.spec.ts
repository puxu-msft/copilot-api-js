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

test.describe("Navigation", () => {
  test("/history redirects to /history/v3", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/history`)
    // After redirect, should end up at /history/v3 with hash routing
    expect(response).not.toBeNull()
    await expect(page).toHaveURL(/\/history\/v3/)
  })

  test("/history/v3 loads and shows the NavBar", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3")
    // NavBar should be visible with the brand text
    const navbar = page.locator("nav.navbar")
    await expect(navbar).toBeVisible()
    await expect(navbar.locator(".navbar-brand")).toHaveText("copilot-api")
  })

  test("default route goes to /v/dashboard", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3")
    // The hash router defaults to /v/dashboard
    await page.waitForURL(/\/history\/v3#\/v\/dashboard/)
    // Dashboard toolbar title should be visible (use v-toolbar-title to avoid NavBar ambiguity)
    await expect(page.locator(".v-toolbar-title", { hasText: "Dashboard" })).toBeVisible()
  })

  test("clicking History nav link navigates to /v/history", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")
    await page.locator("a.nav-link", { hasText: "History" }).click()
    await page.waitForURL(/\/history\/v3#\/v\/history/)
    // History page renders a navigation drawer with a toolbar containing "History" text
    await expect(page.locator(".v-navigation-drawer")).toBeVisible({ timeout: 10000 })
  })

  test("clicking Logs nav link navigates to /v/logs", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")
    await page.locator("a.nav-link", { hasText: "Logs" }).click()
    await expect(page.locator(".v-toolbar-title", { hasText: "Live Logs" })).toBeVisible({ timeout: 10000 })
  })

  test("clicking Dashboard nav link navigates to /v/dashboard", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/logs")
    await page.locator("a.nav-link", { hasText: "Dashboard" }).click()
    await page.waitForURL(/\/history\/v3#\/v\/dashboard/)
    await expect(page.locator(".v-toolbar-title", { hasText: "Dashboard" })).toBeVisible()
  })

  test("clicking Models nav link navigates to /v/models", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")
    await page.locator("a.nav-link", { hasText: "Models" }).click()
    await page.waitForURL(/\/history\/v3#\/v\/models/)
    await expect(page.locator(".v-toolbar-title", { hasText: "Models" })).toBeVisible()
  })

  test("clicking Usage nav link navigates to /v/usage", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")
    await page.locator("a.nav-link", { hasText: "Usage" }).click()
    await page.waitForURL(/\/history\/v3#\/v\/usage/)
    await expect(page.locator(".v-toolbar-title", { hasText: "Usage" })).toBeVisible()
  })
})
