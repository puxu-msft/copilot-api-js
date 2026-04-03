import { test, expect } from "@playwright/test"
import { ensureServerRunning, uiUrl } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("Vuetify Dashboard", () => {
  test("renders the unified operations dashboard", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    await expect(main).toContainText("Operations Workspace")
    await expect(main).toContainText("Rate Limiter")
    await expect(main).toContainText("Quota")
    await expect(main).toContainText("Memory Pressure")
    await expect(main).toContainText("Accepted Requests")
    await expect(main).toContainText("Model Telemetry")
  })

  test("shows health and websocket status chips", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))

    await expect(page.getByText(/healthy|unhealthy|shutting_down/).first()).toBeVisible()
    await expect(page.getByText(/requests \+ status: (live|offline)/i)).toBeVisible()
  })

  test("shows an uptime chip", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))

    await expect(page.getByText(/\b\d+[hms]\b/).first()).toBeVisible()
  })

  test("rate limiter panel renders runtime state and effective config", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    await expect(main).toContainText("Rate Limiter")

    const hasEnabledState = await main.getByText("Limiter policy").isVisible().catch(() => false)
    const hasDisabledState = await main.getByText("Adaptive rate limiting is not enabled at startup").isVisible().catch(() => false)
    expect(hasEnabledState || hasDisabledState).toBeTruthy()

    if (hasEnabledState) {
      await expect(main).toContainText("Queue Depth")
      await expect(main).toContainText("Request Cadence")
      await expect(main).toContainText("Retry Backoff")
      await expect(main).toContainText("Recovery Timeout")
      await expect(main).toContainText("effective limiter configuration")
    }
  })

  test("quota and memory panels render independently", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))
    const main = page.locator("main")

    await expect(main).toContainText("Quota")
    await expect(main).toContainText("Quota Reset")

    const hasQuota = await main.getByText("Current plan:").isVisible().catch(() => false)
    const hasNoQuota = await main.getByText("No quota data available.").isVisible().catch(() => false)
    expect(hasQuota || hasNoQuota).toBeTruthy()

    await expect(main).toContainText("Memory Pressure")
    const hasHeap = await main.getByText("Heap").isVisible().catch(() => false)
    const hasNoMemory = await main.getByText("No memory data available.").isVisible().catch(() => false)
    expect(hasHeap || hasNoMemory).toBeTruthy()
  })

  test("status polling updates uptime text", async ({ page }) => {
    await page.goto(uiUrl("#/v/dashboard"))

    const uptimeChip = page.getByText(/\b\d+[hms]\b/).first()
    await expect(uptimeChip).toBeVisible()
    const initialUptime = await uptimeChip.textContent()

    await page.waitForTimeout(6000)

    const updatedUptime = await uptimeChip.textContent()
    expect(updatedUptime).not.toBe(initialUptime)
  })
})
