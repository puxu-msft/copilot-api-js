import type { Model } from "~backend/lib/models/client"

import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import { ModelsTableTanstack } from "@/components/models/ModelsTableTanstack.poc"

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
  id === "a-model" ? ({ last7d: { requestCount: 42 } } as ReturnType<Parameters<typeof ModelsTableTanstack>[0]["telemetryFor"]>) : null

/** First data row's Model-cell text (row 0 is the header). */
function firstRowId(): string {
  return screen.getAllByRole("row")[1].querySelector("td")?.textContent ?? ""
}

describe("ModelsTableTanstack (PoC — TanStack Table)", () => {
  function renderTable(columnVisibility = {}) {
    render(
      <ModelsTableTanstack
        models={MODELS}
        telemetryFor={telemetryFor}
        maxRequests7d={42}
        columnVisibility={columnVisibility}
        onSelect={() => {}}
      />,
    )
  }

  it("renders derived (Ctx/caps) + joined (Req 7d) columns", () => {
    renderTable()
    expect(screen.getByRole("columnheader", { name: /Ctx/i })).toBeDefined()
    expect(screen.getByRole("columnheader", { name: /Vis/i })).toBeDefined()
    expect(screen.getByRole("columnheader", { name: /Req 7d/i })).toBeDefined()
    expect(screen.getByText("42")).toBeDefined() // joined telemetry
    expect(screen.getAllByText("✓").length).toBe(1) // a-model vision:true
  })

  it("TanStack owns sorting — clicking a header sorts + sets aria-sort", () => {
    renderTable()
    // Initial: id asc → a-model first.
    expect(firstRowId()).toContain("a-model")
    // Ctx is numeric → TanStack's smart default sorts DESC first (900 before 100).
    fireEvent.click(screen.getByRole("button", { name: /^Ctx/i }))
    const ctx = screen.getByRole("columnheader", { name: /Ctx/i })
    expect(ctx.getAttribute("aria-sort")).toBe("descending")
    expect(firstRowId()).toContain("z-model")
    // Toggle to ascending → a-model (100) first.
    fireEvent.click(screen.getByRole("button", { name: /^Ctx/i }))
    expect(ctx.getAttribute("aria-sort")).toBe("ascending")
    expect(firstRowId()).toContain("a-model")
  })

  it("TanStack owns column visibility — hidden column is not rendered", () => {
    renderTable({ vendor: false })
    expect(screen.queryByRole("columnheader", { name: /Vendor/i })).toBeNull()
    // Other columns still present.
    expect(screen.getByRole("columnheader", { name: /Ctx/i })).toBeDefined()
  })
})
