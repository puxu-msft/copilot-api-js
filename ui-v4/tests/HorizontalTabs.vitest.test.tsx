import {
  //
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import { HorizontalTabs } from "@/components/ui/HorizontalTabs"

/**
 * C7 smoke gate: the horizontal Tabs content-layout primitive (RFC §4 C7 /
 * round2-A2). This is the ONLY真共享 shape between the two迥异 detail interaction
 * models — DetailPanel (inline full-page vertical tabs) and ModelDetail (Radix
 * Dialog drawer + resize + focus-trap): the竖→横 tab-list-over-content layout
 * (decision 10). It is a pure C-class layout primitive built on `components/ui/tabs`
 * — no Dialog / Portal / Overlay / resize / focus-trap and no `designVersion`.
 *
 * Depends on the Radix jsdom stubs in [setup.ts](./setup.ts) (ResizeObserver /
 * pointer-capture) — same prerequisite as `ui-primitives.vitest.test.tsx`.
 */
const TABS = [
  { value: "Convo", label: "Convo", content: <div>convo body</div> },
  { value: "System", label: "System", content: <div>system body</div> },
  { value: "Meta", label: "Meta", content: <div>meta body</div> },
]

describe("HorizontalTabs (content-layout primitive)", () => {
  it("renders a horizontal tablist with a tab per item", () => {
    render(
      <HorizontalTabs
        tabs={TABS}
        defaultValue="Convo"
        listAriaLabel="detail segments"
      />,
    )
    const tablist = screen.getByRole("tablist", { name: "detail segments" })
    // Decision 10: the primitive fixes横排 layout (list-on-top), never vertical.
    expect(tablist.dataset.orientation).toBe("horizontal")
    expect(screen.getAllByRole("tab")).toHaveLength(3)
    for (const t of TABS) expect(screen.getByRole("tab", { name: t.value })).toBeDefined()
  })

  it("renders only the active tab's content panel", () => {
    render(
      <HorizontalTabs
        tabs={TABS}
        defaultValue="Convo"
      />,
    )
    // Radix mounts only the active panel with role=tabpanel.
    expect(screen.getByRole("tabpanel").textContent).toBe("convo body")
    expect(screen.queryByText("system body")).toBeNull()
  })

  it("wires tab↔panel aria (aria-controls / aria-labelledby)", () => {
    render(
      <HorizontalTabs
        tabs={TABS}
        defaultValue="Convo"
      />,
    )
    const activeTab = screen.getByRole("tab", { name: "Convo" })
    const panel = screen.getByRole("tabpanel")
    expect(activeTab.getAttribute("aria-controls")).toBe(panel.getAttribute("id"))
    expect(panel.getAttribute("aria-labelledby")).toBe(activeTab.getAttribute("id"))
  })

  it("switches the content panel when another tab is clicked", async () => {
    const user = userEvent.setup()
    render(
      <HorizontalTabs
        tabs={TABS}
        defaultValue="Convo"
      />,
    )
    expect(screen.getByRole("tabpanel").textContent).toBe("convo body")
    await user.click(screen.getByRole("tab", { name: "Meta" }))
    expect(screen.getByRole("tabpanel").textContent).toBe("meta body")
  })

  it("supports Radix roving keyboard navigation between tabs", async () => {
    const user = userEvent.setup()
    render(
      <HorizontalTabs
        tabs={TABS}
        defaultValue="Convo"
      />,
    )
    await user.click(screen.getByRole("tab", { name: "Convo" }))
    // Automatic activation: ArrowRight moves selection to the next tab.
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tabpanel").textContent).toBe("system body")
  })

  it("is controllable via value / onValueChange", async () => {
    const user = userEvent.setup()
    const seen: Array<string> = []
    render(
      <HorizontalTabs
        tabs={TABS}
        value="Convo"
        onValueChange={(v) => seen.push(v)}
      />,
    )
    await user.click(screen.getByRole("tab", { name: "System" }))
    // Controlled: value stays "Convo" (parent owns it) but the change is reported.
    expect(seen).toContain("System")
    expect(screen.getByRole("tabpanel").textContent).toBe("convo body")
  })
})
