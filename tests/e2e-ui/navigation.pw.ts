import { test, expect } from "@playwright/test"
import { BASE_URL, ensureServerRunning, uiUrl } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("Navigation", () => {
  test("/history redirects to /ui#/v/activity", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/history`)
    expect(response).not.toBeNull()
    expect(response?.status()).toBe(200)
    await page.waitForURL(/\/ui#\/v\/activity/)
  })

  test("/ui loads and shows the Vuetify app bar", async ({ page }) => {
    await page.goto(uiUrl())
    await page.waitForURL(/\/ui#\/v\/dashboard/)

    const appBar = page.locator(".v-app-bar")
    await expect(appBar).toBeVisible()
    await expect(appBar).toContainText("copilot-api")
  })

  test("default route goes to /v/dashboard", async ({ page }) => {
    await page.goto(uiUrl())
    await page.waitForURL(/\/ui#\/v\/dashboard/)
    await expect(page.locator("main")).toContainText("Operations Workspace")
  })

  test("History does not appear as a navbar tab", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    await expect(page.getByRole("tab", { name: "History" })).toHaveCount(0)
  })

  test("clicking Activity nav link navigates to /v/activity", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    await page.getByRole("tab", { name: "Activity" }).click()
    await page.waitForURL(/\/ui#\/v\/activity/)
    await expect(page.locator("main")).toContainText("Activity")
  })

  test("clicking Dashboard nav link navigates to /v/dashboard", async ({ page }) => {
    await page.goto(uiUrl("#/v/activity"))
    await page.getByRole("tab", { name: "Dashboard" }).click()
    await page.waitForURL(/\/ui#\/v\/dashboard/)
    await expect(page.locator("main")).toContainText("Dashboard and usage are now one surface.")
  })

  test("clicking Models nav link navigates to /v/models", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    await page.getByRole("tab", { name: "Models" }).click()
    await page.waitForURL(/\/ui#\/v\/models/)
    await expect(page.getByPlaceholder("Search model id or name")).toBeVisible()
  })

  test("from /v/models, clicking Config tab navigates to /v/config", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))
    await expect(page.getByPlaceholder("Search model id or name")).toBeVisible({ timeout: 15000 })
    await page.getByRole("tab", { name: "Config" }).click()
    await page.waitForURL(/\/ui#\/v\/config/)
    await expect(page.locator("main")).toContainText("Config")
  })

  test("/v/history redirects to /v/activity", async ({ page }) => {
    await page.goto(uiUrl("#/v/history"))
    await page.waitForURL(/\/ui#\/v\/activity/)
    await expect(page.locator("main")).toContainText("Activity")
  })

  test("/v/usage redirects back to /v/dashboard", async ({ page }) => {
    await page.goto(uiUrl("#/v/usage"))
    await page.waitForURL(/\/ui#\/v\/dashboard/)
    await expect(page.locator("main")).toContainText("Operations Workspace")
  })
})
