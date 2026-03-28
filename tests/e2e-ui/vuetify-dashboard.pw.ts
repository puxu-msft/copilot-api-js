import { test, expect } from "@playwright/test"
import { ensureServerRunning, uiUrl } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("Vuetify Dashboard", () => {
  test("renders dashboard overview", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")
    await expect(main).toContainText("Authentication")
    await expect(main).toContainText("Configuration")
  })

  test("Status card shows health status", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    const healthText = await main.getByText(/healthy|unhealthy|shutting_down/).first().textContent()
    expect(healthText?.trim()).toMatch(/^(healthy|unhealthy|shutting_down)$/)
  })

  test("Status card shows uptime value", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    const uptimePattern = /\d+[hms]/
    const uptimeItem = main.locator("xpath=.//*[normalize-space()='Uptime']/following-sibling::*[1]").first()
    await expect(uptimeItem).toBeVisible()
    const uptimeText = await uptimeItem.textContent()
    expect(uptimeText?.trim()).toMatch(uptimePattern)
  })

  test("Memory card renders", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    await expect(main.getByText("Memory")).toBeVisible()

    const hasHeap = await main.getByText("Heap").isVisible().catch(() => false)
    const hasNoInfo = await main.getByText("No memory info").isVisible().catch(() => false)
    expect(hasHeap || hasNoInfo).toBeTruthy()
  })

  test("Configuration card renders with key-value pairs", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    await expect(main.getByText("Configuration")).toBeVisible({ timeout: 10000 })

    const hasEntries = (await main.locator("table").count()) > 0
    const hasNoConfig = await main.getByText("No config available").isVisible().catch(() => false)
    expect(hasEntries || hasNoConfig).toBeTruthy()
  })

  test("Rate Limiter card renders", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    await expect(main).toContainText("Rate Limiter")
    await expect(main).toContainText("Mode")

    const mainText = await main.textContent()
    expect(mainText).toMatch(/normal|rate-limited|recovering|N\/A/)
  })

  test("Authentication card renders", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    await expect(main).toContainText("Authentication")
    await expect(main).toContainText("Account")

    const mainText = await main.textContent()
    expect(mainText).toMatch(/enterprise|individual|business|No auth info/)
  })

  test("status polling updates data", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    const uptimeItem = main.locator("xpath=.//*[normalize-space()='Uptime']/following-sibling::*[1]").first()
    await expect(uptimeItem).toBeVisible()
    const initialUptime = await uptimeItem.textContent()

    await page.waitForTimeout(6000)

    const updatedUptime = await uptimeItem.textContent()
    expect(updatedUptime).not.toBe(initialUptime)
  })

  test("WS connection indicator shows status", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))

    const wsChip = page.getByText(/WS (Live|Offline)/)
    await expect(wsChip).toBeVisible()
  })
})
