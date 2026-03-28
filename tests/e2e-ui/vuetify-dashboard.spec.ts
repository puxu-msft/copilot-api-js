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

test.describe("Vuetify Dashboard", () => {
  test("renders Dashboard heading", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")
    await expect(page.locator(".v-toolbar-title", { hasText: "Dashboard" })).toBeVisible()
  })

  test("Status card shows health status", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")

    // Wait for the Status card to appear
    const statusCard = page.locator(".v-card", { hasText: "Status" }).first()
    await expect(statusCard).toBeVisible()

    // Health chip should show "healthy" or "unhealthy"
    const healthChip = statusCard.locator(".v-chip").first()
    await expect(healthChip).toBeVisible()
    const healthText = await healthChip.textContent()
    expect(healthText?.trim()).toMatch(/^(healthy|unhealthy|shutting_down)$/)
  })

  test("Status card shows uptime value", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")

    const statusCard = page.locator(".v-card", { hasText: "Status" }).first()
    await expect(statusCard).toBeVisible()

    // Uptime displays as "Xh Ym Zs" or "Ym Zs" or "Zs" format in a list item
    // The uptime value is in a v-list-item-title with class text-caption
    const uptimePattern = /\d+[hms]/
    const uptimeItem = statusCard.locator(".v-list-item-title.text-caption").first()
    await expect(uptimeItem).toBeVisible()
    const uptimeText = await uptimeItem.textContent()
    expect(uptimeText?.trim()).toMatch(uptimePattern)
  })

  test("Memory card renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")

    const memoryCard = page.locator(".v-card", { hasText: "Memory" })
    await expect(memoryCard).toBeVisible()

    // Should show heap info (e.g. "XX MB") or "No memory info"
    const hasHeap = await memoryCard.getByText(/\d+ MB/).isVisible().catch(() => false)
    const hasNoInfo = await memoryCard.getByText("No memory info").isVisible().catch(() => false)
    expect(hasHeap || hasNoInfo).toBeTruthy()
  })

  test("Configuration card renders with key-value pairs", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")

    // Wait for config to load (polled every 30s, initial fetch on mount)
    const configCard = page.locator(".v-card", { hasText: "Configuration" })
    await expect(configCard).toBeVisible({ timeout: 10000 })

    // Should have config entries or "No config available"
    const hasEntries = await configCard.locator(".v-list-item").count()
    const hasNoConfig = await configCard.getByText("No config available").isVisible().catch(() => false)
    expect(hasEntries > 0 || hasNoConfig).toBeTruthy()
  })

  test("Rate Limiter card renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")

    const rateLimiterCard = page.locator(".v-card", { hasText: "Rate Limiter" })
    await expect(rateLimiterCard).toBeVisible()

    // Should show mode chip (normal, rate-limited, or recovering)
    const modeChip = rateLimiterCard.locator(".v-chip")
    await expect(modeChip).toBeVisible()
    const modeText = await modeChip.textContent()
    expect(modeText?.trim()).toMatch(/^(normal|rate-limited|recovering|N\/A)$/)
  })

  test("Authentication card renders", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")

    const authCard = page.locator(".v-card", { hasText: "Authentication" })
    await expect(authCard).toBeVisible()

    // Should show auth info (account type like "enterprise" or "individual")
    // or "No auth info"
    const hasAccountType = await authCard.getByText(/enterprise|individual/).isVisible().catch(() => false)
    const hasNoAuth = await authCard.getByText("No auth info").isVisible().catch(() => false)
    expect(hasAccountType || hasNoAuth).toBeTruthy()
  })

  test("status polling updates data", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")

    // Wait for the initial status load
    const statusCard = page.locator(".v-card", { hasText: "Status" }).first()
    await expect(statusCard).toBeVisible()

    // Capture initial uptime text from the first text-caption list item (uptime value)
    const uptimeItem = statusCard.locator(".v-list-item-title.text-caption").first()
    await expect(uptimeItem).toBeVisible()
    const initialUptime = await uptimeItem.textContent()

    // Wait for the next polling cycle (5s) plus buffer
    await page.waitForTimeout(6000)

    // Uptime should have changed (it increments every second)
    const updatedUptime = await uptimeItem.textContent()
    expect(updatedUptime).not.toBe(initialUptime)
  })

  test("WS connection indicator shows status", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/dashboard")

    // WS chip in toolbar area
    const wsChip = page.locator(".v-chip", { hasText: /WS (Live|Offline)/ })
    await expect(wsChip).toBeVisible()
  })
})
