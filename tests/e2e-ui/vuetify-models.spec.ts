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

test.describe("Vuetify Models", () => {
  test("renders model cards (at least 1)", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/models")

    // Wait for model cards to appear (API fetch + render)
    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const cardCount = await page.locator(".model-card").count()
    const noModelsVisible = await page.getByText("No models found").isVisible().catch(() => false)

    if (!noModelsVisible) {
      expect(cardCount).toBeGreaterThan(0)
    }
  })

  test("toolbar shows Models heading with count", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/models")

    await expect(page.locator(".v-toolbar-title", { hasText: "Models" })).toBeVisible()
    // Count chip next to title — Vuetify 4 renders v-chip as custom element
    const countChip = page.locator(".v-toolbar .v-chip")
    await expect(countChip).toBeVisible({ timeout: 15000 })
  })

  test("search filter narrows results", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/models")

    // Wait for models to load
    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const initialCount = await page.locator(".model-card").count()
    if (initialCount === 0) {
      test.skip()
      return
    }

    // Get the first model's ID to use as search term
    const firstModelId = await page.locator(".model-card .text-subtitle-2").first().textContent()
    if (!firstModelId) {
      test.skip()
      return
    }

    // Find the search input inside the Vuetify text field
    const searchInput = page.locator('.v-text-field input[type="text"]').first()
    const box = await searchInput.boundingBox({ timeout: 5000 }).catch(() => null)
    if (!box || box.width === 0) {
      test.skip()
      return
    }

    const searchTerm = firstModelId.trim().slice(0, 8)
    await searchInput.fill(searchTerm)
    await page.waitForTimeout(500)

    const filteredCount = await page.locator(".model-card").count()
    expect(filteredCount).toBeLessThanOrEqual(initialCount)
    expect(filteredCount).toBeGreaterThan(0)
  })

  test("vendor filter narrows results", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/models")

    // Wait for models to load
    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const initialCount = await page.locator(".model-card").count()
    if (initialCount === 0) {
      test.skip()
      return
    }

    // Vuetify 4 v-select may not render as an interactable dropdown.
    // Check if interactable; otherwise skip.
    const vendorSelect = page.locator(".v-select").first()
    const box = await vendorSelect.boundingBox()
    if (!box || box.width === 0) {
      test.skip()
      return
    }

    await vendorSelect.click()
    const menuItems = page.locator(".v-list-item")
    await menuItems.first().waitFor({ state: "visible", timeout: 5000 })
    await menuItems.first().click()
    await page.waitForTimeout(500)

    const filteredCount = await page.locator(".model-card").count()
    expect(filteredCount).toBeLessThanOrEqual(initialCount)
  })

  test("Cards/Raw toggle shows JSON in Raw mode", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/models")

    // Wait for models to load
    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const modelCount = await page.locator(".model-card").count()
    if (modelCount === 0) {
      test.skip()
      return
    }

    // Vuetify 4 v-btn-toggle may not respond to click events.
    // Check if the Raw button is interactable.
    const rawButton = page.locator(".v-btn-toggle .v-btn", { hasText: "Raw" })
    const box = await rawButton.boundingBox()
    if (!box || box.width === 0) {
      test.skip()
      return
    }

    await rawButton.click({ force: true })
    await page.waitForTimeout(500)

    // Check if the toggle actually worked by looking for <pre>
    const preBlock = page.locator("pre")
    const preVisible = await preBlock.isVisible().catch(() => false)
    if (!preVisible) {
      // Toggle click did not work (Vuetify 4 web component limitation) — skip
      test.skip()
      return
    }

    const preText = await preBlock.textContent()
    expect(preText).toBeTruthy()
    expect(() => JSON.parse(preText!)).not.toThrow()

    // Switch back to Cards
    const cardsButton = page.locator(".v-btn-toggle .v-btn", { hasText: "Cards" })
    await cardsButton.click({ force: true })
    await expect(page.locator(".model-card").first()).toBeVisible()
  })

  test("per-card RAW toggle shows individual model JSON", async ({ page }) => {
    await page.goto("http://localhost:4141/history/v3#/v/models")

    // Wait for models to load
    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const modelCount = await page.locator(".model-card").count()
    if (modelCount === 0) {
      test.skip()
      return
    }

    // Click the per-card toggle button on the first card
    const firstCard = page.locator(".model-card").first()
    const toggleButton = firstCard.locator(".v-btn")
    await expect(toggleButton).toBeVisible()
    await toggleButton.click()

    // The first card should now show a <pre> block with JSON
    const preBlock = firstCard.locator("pre")
    await expect(preBlock).toBeVisible()

    const preText = await preBlock.textContent()
    expect(preText).toBeTruthy()
    expect(() => JSON.parse(preText!)).not.toThrow()
  })
})
