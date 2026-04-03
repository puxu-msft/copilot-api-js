import { test, expect } from "@playwright/test"

import { ensureServerRunning, uiUrl } from "./helpers"
import { createHistoryUiScenario, installHistoryUiMocks } from "./history-mocks"

test.beforeAll(ensureServerRunning)

test.describe("Vuetify History And Activity", () => {
  test("renders the expected activity view data chain from HTTP plus websocket fixtures", async ({ page }) => {
    const scenario = createHistoryUiScenario()
    await installHistoryUiMocks(page, scenario)

    await page.goto(uiUrl("#/v/activity"))

    await expect(page.locator("main")).toContainText("Activity")
    await expect(page.getByTestId("activity-realtime-panel-body")).toContainText("gpt-5.4")
    await expect(page.getByTestId("activity-realtime-panel-body")).toContainText("/v1/responses")
    await expect(page.getByTestId("activity-realtime-panel-body")).toContainText("streaming")

    await expect(page.locator(".stream-table")).toContainText("Summarize the build failures")
    await expect(page.locator(".stream-table")).toContainText("sess-abc")

    await expect(page.locator("main")).toContainText("2 recent events")
    await expect(page.locator(".stream-table")).toContainText(
      "Fresh websocket activity arrived after the initial page load.",
    )
  })

  test("opens request detail in a wide desktop dialog and keeps Activity selected", async ({ page }) => {
    const scenario = createHistoryUiScenario()
    await installHistoryUiMocks(page, scenario)
    await page.setViewportSize({ width: 2200, height: 1300 })

    await page.goto(uiUrl("#/v/activity"))
    await expect(page.locator(".stream-table")).toContainText("Summarize the build failures")

    await page
      .locator(".stream-table tbody tr")
      .filter({
        hasText: "Summarize the build failures",
      })
      .getByRole("button", { name: "Details" })
      .click()

    await page.waitForURL(/\/ui#\/v\/history\/req-history-primary/)

    const detailCard = page.getByTestId("activity-detail-card")
    await expect(detailCard).toBeVisible()
    await expect(detailCard).toContainText("Request")
    await expect(detailCard).toContainText("Request")
    await expect(detailCard).toContainText("Response")
    await expect(detailCard).toContainText("Meta")
    await expect(detailCard).toContainText("Request Id")
    await expect(detailCard).toContainText("Session Id")
    await expect(detailCard).toContainText("Queue Wait")
    await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")

    const box = await detailCard.boundingBox()
    expect(box).not.toBeNull()
    expect(box?.width ?? 0).toBeGreaterThan(2100)

    const detailScrollState = await page
      .locator("[data-testid='activity-detail-card'] .detail-panel .detail-body")
      .evaluate((node) => {
        const element = node as HTMLDivElement
        const before = element.scrollTop
        element.scrollTop = 400
        return {
          before,
          after: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          overflowY: getComputedStyle(element).overflowY,
        }
      })

    expect(detailScrollState.overflowY).toBe("auto")
    expect(detailScrollState.scrollHeight).toBeGreaterThan(detailScrollState.clientHeight)
    expect(detailScrollState.after).toBeGreaterThan(detailScrollState.before)

    const nestedVerticalScrollables = await detailCard.evaluate((node) => {
      return Array.from(node.querySelectorAll<HTMLElement>("*"))
        .filter((element) => {
          const style = getComputedStyle(element)
          const canScroll = style.overflowY === "auto" || style.overflowY === "scroll"
          return canScroll && element.scrollHeight > Number(element.clientHeight) + 8
        })
        .map((element) => element.className)
    })

    expect(nestedVerticalScrollables).toContain("detail-body")
    expect(
      nestedVerticalScrollables.some(
        (className) =>
          className.includes("msg-body")
          || className.includes("system-body")
          || className.includes("content-block-body"),
      ),
    ).toBe(true)
  })

  test("opens missing detail from the realtime panel and returns cleanly to Activity", async ({ page }) => {
    const scenario = createHistoryUiScenario()
    await installHistoryUiMocks(page, scenario)

    await page.goto(uiUrl("#/v/activity"))
    await expect(page.getByTestId("activity-realtime-panel-body")).toContainText("gpt-5.4")

    await page.getByTestId("activity-realtime-panel-body").getByRole("button", { name: "Details" }).click()
    await page.waitForURL(/\/ui#\/v\/history\/req-live-1/)

    const detailCard = page.getByTestId("activity-detail-card")
    await expect(detailCard).toBeVisible()
    await expect(detailCard).toContainText("Detail is not available yet.")
    await expect(detailCard).toContainText("Retry from Activity in a moment.")
    await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")

    await detailCard.getByRole("button", { name: "Close" }).click()
    await page.waitForURL(/\/ui#\/v\/activity/)
    await expect(page.locator("main")).toContainText("Activity")
  })

  test("opens the request raw JSON dialog on top of the detail dialog and allows scrolling", async ({ page }) => {
    const scenario = createHistoryUiScenario()
    await installHistoryUiMocks(page, scenario)
    await page.setViewportSize({ width: 1720, height: 1200 })

    await page.goto(uiUrl("#/v/history/req-history-primary"))
    await page.waitForURL(/\/ui#\/v\/history\/req-history-primary/)

    const detailCard = page.getByTestId("activity-detail-card")
    await expect(detailCard).toBeVisible()

    await page.getByTestId("section-raw-request").click()

    const rawJsonCard = page.getByTestId("raw-json-card")
    await expect(rawJsonCard).toBeVisible()
    await expect(rawJsonCard).toContainText("Request")
    await expect(rawJsonCard).toContainText("Original")
    await expect(rawJsonCard).toContainText("Rewritten")

    const topmostTarget = await rawJsonCard.evaluate((node) => {
      const elementNode = node as HTMLDivElement
      const rect = elementNode.getBoundingClientRect()
      const x = Number(rect.left) + Number(rect.width) / 2
      const y = Number(rect.top) + Math.min(120, Number(rect.height) / 2)
      const doc = (
        globalThis as unknown as {
          document: {
            elementFromPoint: (left: number, top: number) => { closest: (selector: string) => unknown } | null
          }
        }
      ).document
      const element = doc.elementFromPoint(x, y)
      return element?.closest("[data-testid='raw-json-card']") !== null
    })
    expect(topmostTarget).toBe(true)

    const scrollState = await page
      .locator("[data-testid='raw-json-card'] .json-viewer")
      .first()
      .evaluate((node) => {
        const element = node as HTMLDivElement
        const before = element.scrollTop
        element.scrollTop = 240
        return {
          before,
          after: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        }
      })

    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight)
    expect(scrollState.after).toBeGreaterThan(scrollState.before)

    await rawJsonCard.getByRole("button", { name: "Close" }).click()
    await expect(rawJsonCard).toHaveCount(0)
    await expect(detailCard).toBeVisible()
  })

  test("unknown detail route shows the unavailable state and closing returns to Activity", async ({ page }) => {
    const scenario = createHistoryUiScenario()
    await installHistoryUiMocks(page, scenario)

    await page.goto(uiUrl("#/v/history/does-not-exist"))
    await page.waitForURL(/\/ui#\/v\/history\/does-not-exist/)

    const detailCard = page.getByTestId("activity-detail-card")
    await expect(detailCard).toContainText("Detail is not available yet.")
    await expect(detailCard).toContainText("The request entry may still be initializing.")

    await detailCard.getByRole("button", { name: "Close" }).click()
    await page.waitForURL(/\/ui#\/v\/activity/)
    await expect(page.locator("main")).toContainText("Activity")
  })
})
