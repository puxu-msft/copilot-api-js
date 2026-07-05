import type { Model } from "~backend/lib/models/client"

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

import { ModelsTableAria } from "@/components/models/ModelsTableAria.poc"

const MODELS = [
  {
    id: "a-model",
    name: "A",
    vendor: "Zed",
    version: "1",
    capabilities: { supports: { vision: true }, limits: { max_context_window_tokens: 100 } },
    billing: { multiplier: 1 },
  },
  {
    id: "z-model",
    name: "Z",
    vendor: "Acme",
    version: "1",
    capabilities: { supports: {}, limits: { max_context_window_tokens: 900 } },
    billing: { multiplier: 3 },
  },
] as unknown as Array<Model>

const telemetryFor = (id: string) =>
  id === "a-model" ? ({ last7d: { requestCount: 42 } } as ReturnType<Parameters<typeof ModelsTableAria>[0]["telemetryFor"]>) : null

/** First data row's row-header (id) cell text (react-aria id column is a rowheader). */
function firstRowId(): string {
  return screen.getAllByRole("row")[1].querySelector("[role='rowheader']")?.textContent ?? ""
}

describe("ModelsTableAria (PoC — react-aria)", () => {
  function renderTable(columnVisibility: Record<string, boolean> = {}) {
    render(
      <ModelsTableAria
        models={MODELS}
        telemetryFor={telemetryFor}
        columnVisibility={columnVisibility}
        onSelect={() => {}}
      />,
    )
  }

  it("renders derived (Ctx/Vis) + joined (Req 7d) columns + a11y grid (white-sent)", () => {
    renderTable()
    // react-aria renders a full ARIA grid — white-sent (TanStack: hand-written).
    expect(screen.getByRole("grid")).toBeDefined()
    expect(screen.getByRole("columnheader", { name: /Ctx/i })).toBeDefined()
    expect(screen.getByRole("columnheader", { name: /Vis/i })).toBeDefined()
    expect(screen.getByRole("columnheader", { name: /Req 7d/i })).toBeDefined()
    expect(screen.getByText("42")).toBeDefined() // joined telemetry
    expect(screen.getAllByText("✓").length).toBe(1) // a-model vision:true
  })

  it("sorting: react-aria gives the interaction + aria-sort (white-sent); comparator is hand-written", async () => {
    const user = userEvent.setup()
    renderTable()
    expect(firstRowId()).toContain("a-model") // initial id asc
    // Click Ctx header → react-aria default is ASCENDING first (no numeric-desc-first
    // smart default — contrast with TanStack). Hand-written comparator sorts 100<900.
    await user.click(screen.getByRole("columnheader", { name: /Ctx/i }))
    const ctx = screen.getByRole("columnheader", { name: /Ctx/i })
    expect(ctx.getAttribute("aria-sort")).toBe("ascending") // white-sent aria-sort
    expect(firstRowId()).toContain("a-model") // 100 first
    await user.click(screen.getByRole("columnheader", { name: /Ctx/i }))
    expect(ctx.getAttribute("aria-sort")).toBe("descending")
    expect(firstRowId()).toContain("z-model") // 900 first
  })

  it("column visibility is hand-rolled (no VisibilityState) — hidden column absent", () => {
    renderTable({ vendor: false })
    expect(screen.queryByRole("columnheader", { name: /Vendor/i })).toBeNull()
    expect(screen.getByRole("columnheader", { name: /Ctx/i })).toBeDefined()
  })
})
