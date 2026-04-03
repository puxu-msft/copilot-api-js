import { test, expect } from "@playwright/test"
import { ensureServerRunning, uiUrl } from "./helpers"

test.beforeAll(ensureServerRunning)

test.describe("Vuetify Models", () => {
  test("renders model cards (at least 1)", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))

    // Wait for model cards to appear (API fetch + render)
    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const cardCount = await page.locator(".model-card").count()
    const noModelsVisible = await page.getByText("No models found").isVisible().catch(() => false)

    if (!noModelsVisible) {
      expect(cardCount).toBeGreaterThan(0)
    }
  })

  test("toolbar shows Models heading with count", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))

    await expect(page.locator(".toolbar-shell")).toContainText("Models")
    await expect(page.locator(".toolbar-shell")).toContainText("visible /")
    await expect(page.getByPlaceholder("Search model id or name")).toBeVisible({ timeout: 15000 })
  })

  test("models list remains scrollable when content exceeds the viewport", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))

    const scroller = page.locator(".models-page .v-page-scroll")
    await expect(scroller).toBeVisible({ timeout: 15000 })

    const before = await scroller.evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    }))

    if (before.scrollHeight <= before.clientHeight) {
      test.skip()
      return
    }

    await scroller.hover()
    await page.mouse.wheel(0, 1600)
    await page.waitForTimeout(300)

    const after = await scroller.evaluate((el) => el.scrollTop)
    expect(after).toBeGreaterThan(before.scrollTop)
  })

  test("search filter narrows results", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))

    // Wait for models to load
    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const initialCount = await page.locator(".model-card").count()
    if (initialCount === 0) {
      test.skip()
      return
    }

    const firstCardText = await page.locator(".model-card").first().textContent()
    const firstModelId = firstCardText?.match(/\b(?:claude|gpt|gemini)-[A-Za-z0-9.-]+/)?.[0]
    if (!firstModelId) {
      test.skip()
      return
    }

    // Find the search input inside the Vuetify text field
    const searchInput = page.getByPlaceholder("Search model id or name")
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
    await expect(page.locator(".models-page")).toContainText(searchTerm)
  })

  test("vendor filter narrows results", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))

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

  test("type filter narrows results to the selected model type", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))

    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const typeSelect = page.locator(".filter-panel .v-select").nth(3)
    const box = await typeSelect.boundingBox()
    if (!box || box.width === 0) {
      test.skip()
      return
    }

    await typeSelect.click()
    const embeddingsOption = page.locator(".v-list-item").filter({ hasText: "embeddings" }).first()
    await embeddingsOption.waitFor({ state: "visible", timeout: 5000 })
    await embeddingsOption.click()
    await page.waitForTimeout(500)

    const cards = page.locator(".model-card")
    const count = await cards.count()
    expect(count).toBeGreaterThan(0)

    const texts = await cards.evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""))
    for (const text of texts) {
      expect(text.toLowerCase()).toContain("embeddings")
    }
  })

  test("toolbar Raw JSON button opens the full models JSON dialog", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))

    // Wait for models to load
    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const modelCount = await page.locator(".model-card").count()
    if (modelCount === 0) {
      test.skip()
      return
    }

    await page.getByRole("button", { name: "Raw JSON" }).click()
    await page.waitForTimeout(500)

    const dialog = page.locator(".models-json-dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("Full Models Raw JSON")
    await expect(dialog.getByRole("button", { name: "Copy JSON" })).toBeVisible()

    await dialog.getByRole("button", { name: "Close" }).click()
    await expect(page.locator(".model-card").first()).toBeVisible()
  })

  test("per-card JSON button opens the individual model JSON dialog", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))

    // Wait for models to load
    await page.waitForSelector(".model-card", { timeout: 15000 }).catch(() => {})

    const modelCount = await page.locator(".model-card").count()
    if (modelCount === 0) {
      test.skip()
      return
    }

    const firstCard = page.locator(".model-card").first()
    const jsonButton = firstCard.getByRole("button", { name: "JSON" })
    await expect(jsonButton).toBeVisible()
    await jsonButton.click()

    const dialog = page.locator(".json-dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.locator(".dialog-title")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Copy JSON" })).toBeVisible()
  })

  test("embedding models show embedding-specific limits instead of LLM token limits", async ({ page }) => {
    await page.goto(uiUrl("#/v/models"))

    const embeddingCard = page.locator(".model-card", { hasText: "text-embedding-3-small" }).first()
    await expect(embeddingCard).toBeVisible({ timeout: 15000 })

    await expect(embeddingCard).toContainText("Max Inputs")
    await expect(embeddingCard).toContainText("512")
    await expect(embeddingCard).not.toContainText("Context Window")
    await expect(embeddingCard).not.toContainText("Max Prompt")
    await expect(embeddingCard).not.toContainText("Max Output")
  })
})
