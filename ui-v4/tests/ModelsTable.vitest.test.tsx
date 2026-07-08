import type {
  //
  SortingState,
  VisibilityState,
} from "@tanstack/react-table"
import type { Model } from "~backend/lib/models/client"

import {
  //
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { useState } from "react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import {
  //
  augmentRows,
  sortModelRows,
} from "@/components/models/model-table-columns"
import { ModelsTable } from "@/components/models/ModelsTable"

const MODELS = [
  {
    id: "a-model",
    name: "A",
    vendor: "Zed",
    version: "1",
    preview: false,
    is_chat_default: false,
    capabilities: { supports: { vision: true }, limits: { max_context_window_tokens: 100 } },
    billing: { multiplier: 1 },
  },
  {
    id: "z-model",
    name: "Z",
    vendor: "Acme",
    version: "1",
    preview: false,
    is_chat_default: false,
    capabilities: { supports: {}, limits: { max_context_window_tokens: 900 } },
    billing: { multiplier: 3 },
  },
] as unknown as Array<Model>

const telemetryFor = (id: string) => (id === "a-model" ? ({ last7d: { requestCount: 42 } } as ReturnType<Parameters<typeof augmentRows>[1]>) : null)

/** Wrap the controlled table with local sorting state so header clicks flow through
 *  TanStack's `onSortingChange` exactly as they do under ModelsPage. */
function Harness({ columnVisibility = {} as VisibilityState, initialSorting = [{ id: "id", desc: false }] as SortingState }) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting)
  return (
    <ModelsTable
      models={MODELS}
      columnVisibility={columnVisibility}
      sorting={sorting}
      onSortingChange={setSorting}
      telemetryFor={telemetryFor}
      statusFor={() => "enabled"}
      maxRequests7d={42}
      onSelect={() => {}}
    />
  )
}

/** First data row's Model-cell text (row 0 is the header). */
function firstRowId(): string {
  return screen.getAllByRole("row")[1].querySelector("td")?.textContent ?? ""
}

/** All data rows' first-cell (Model id) text, in DOM order. */
function domRowIds(): Array<string | null> {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getByRole("button", { name: /Open details/i }).textContent)
}

describe("ModelsTable (TanStack)", () => {
  it("renders derived (Ctx/caps) + joined (Req 7d) columns", () => {
    render(<Harness columnVisibility={{ requests7d: true }} />)
    expect(screen.getByRole("columnheader", { name: /Ctx/i })).toBeDefined()
    expect(screen.getByRole("columnheader", { name: /Vis/i })).toBeDefined()
    expect(screen.getByRole("columnheader", { name: /Req 7d/i })).toBeDefined()
    expect(screen.getByText("42")).toBeDefined() // joined telemetry
    expect(screen.getAllByText("✓").length).toBe(1) // a-model vision:true
  })

  it("TanStack owns sorting — clicking Ctx sorts DESC first + sets aria-sort", () => {
    render(<Harness />)
    expect(firstRowId()).toContain("a-model") // id asc default
    // Ctx is numeric → smart default sorts DESC first (900 before 100).
    fireEvent.click(screen.getByRole("button", { name: /^Ctx/i }))
    const ctx = screen.getByRole("columnheader", { name: /Ctx/i })
    expect(ctx.getAttribute("aria-sort")).toBe("descending")
    expect(firstRowId()).toContain("z-model")
    fireEvent.click(screen.getByRole("button", { name: /^Ctx/i }))
    expect(ctx.getAttribute("aria-sort")).toBe("ascending")
    expect(firstRowId()).toContain("a-model")
  })

  it("string column (Vendor) sorts ASC first", () => {
    render(<Harness />)
    const vendor = screen.getByRole("columnheader", { name: /Vendor/i })
    expect(vendor.getAttribute("aria-sort")).toBe("none")
    fireEvent.click(screen.getByRole("button", { name: /Vendor/i }))
    expect(vendor.getAttribute("aria-sort")).toBe("ascending")
    expect(firstRowId()).toContain("z-model") // Acme < Zed
  })

  it("derived/cap headers are NOT sortable (no aria-sort, no button)", () => {
    render(<Harness />)
    const vis = screen.getByRole("columnheader", { name: /Vis/i })
    expect(vis.getAttribute("aria-sort")).toBeNull()
    expect(within(vis).queryByRole("button")).toBeNull()
  })

  it("TanStack owns column visibility — hidden column is not rendered", () => {
    render(<Harness columnVisibility={{ vendor: false }} />)
    expect(screen.queryByRole("columnheader", { name: /Vendor/i })).toBeNull()
    expect(screen.getByRole("columnheader", { name: /Ctx/i })).toBeDefined()
  })

  it("CSV order === table order: sortModelRows reproduces the DOM row order", () => {
    // Render with a concrete sorting; the shared sort (backing CSV) must match the
    // table's rendered order exactly — the spec §7 guarantee, verified against the
    // real TanStack DOM as an independent oracle.
    const sorting: SortingState = [{ id: "context", desc: true }]
    render(<Harness initialSorting={sorting} />)
    const shared = sortModelRows(
      augmentRows(MODELS, telemetryFor, () => "enabled"),
      sorting,
    ).map((r) => r.model.id)
    expect(domRowIds()).toEqual(shared)
    expect(shared).toEqual(["z-model", "a-model"]) // 900 desc before 100
  })

  it("thinking cell shows adaptive / ≤N / · with a budget tooltip", () => {
    // The dedicated thinking column renders the actual budget (adaptive > ≤N > ·),
    // each carrying a `title` tooltip that thinkingLabel derives from caps.
    const thinkingModels = [
      {
        id: "adaptive-m",
        name: "AD",
        vendor: "V",
        version: "1",
        preview: false,
        is_chat_default: false,
        capabilities: { supports: { adaptive_thinking: true }, limits: {} },
        billing: { multiplier: 1 },
      },
      {
        id: "budget-m",
        name: "BD",
        vendor: "V",
        version: "1",
        preview: false,
        is_chat_default: false,
        capabilities: { supports: { max_thinking_budget: 8192 }, limits: {} },
        billing: { multiplier: 1 },
      },
      {
        id: "none-m",
        name: "NO",
        vendor: "V",
        version: "1",
        preview: false,
        is_chat_default: false,
        capabilities: { supports: {}, limits: {} },
        billing: { multiplier: 1 },
      },
    ] as unknown as Array<Model>
    render(
      <ModelsTable
        models={thinkingModels}
        columnVisibility={{}}
        sorting={[{ id: "id", desc: false }]}
        onSortingChange={() => {}}
        telemetryFor={() => null}
        statusFor={() => "enabled"}
        maxRequests7d={0}
      />,
    )
    // adaptive form + tooltip
    const adaptive = document.querySelector('[title="adaptive thinking"]')
    expect(adaptive?.textContent).toBe("adaptive")
    // fixed-budget form ≤N + tooltip
    const budget = document.querySelector('[title="max thinking budget 8192"]')
    expect(budget?.textContent).toBe("≤8192")
    // none form · + tooltip
    const none = document.querySelector('[title="no thinking"]')
    expect(none?.textContent).toBe("·")
  })

  it("thinking column stays hideable + last of the caps (before billing)", () => {
    // Guards the CRITICAL invariant: the dedicated thinking cell must keep id
    // `"thinking"` (column-menu + localStorage key) AND its position — last
    // capability column, immediately before billing ($×).
    const { unmount } = render(<Harness />)
    const cols = screen.getAllByRole("columnheader").map((h) => h.textContent.trim())
    const think = cols.findIndex((t) => t.startsWith("Think"))
    const strm = cols.findIndex((t) => t.startsWith("Strm"))
    const billing = cols.findIndex((t) => t.includes("$×"))
    expect(think).toBeGreaterThan(-1)
    expect(strm).toBeLessThan(think) // last of the caps
    expect(think).toBeLessThan(billing) // immediately before billing
    unmount()

    // Hiding via the `thinking` visibility key removes only that column.
    render(<Harness columnVisibility={{ thinking: false }} />)
    expect(screen.queryByRole("columnheader", { name: /^Think/ })).toBeNull()
    expect(screen.getByRole("columnheader", { name: /^Strm/ })).toBeDefined()
    expect(screen.getByRole("columnheader", { name: /\$×/ })).toBeDefined()
  })

  it("mutes config-disabled rows and shows a config-off chip", () => {
    render(
      <ModelsTable
        models={[{ id: "d", name: "D", vendor: "V", model_picker_enabled: true } as unknown as Model]}
        columnVisibility={{}}
        telemetryFor={() => null}
        statusFor={() => "config-disabled"}
        maxRequests7d={1}
        sorting={[]}
        onSortingChange={() => {}}
      />,
    )
    expect(screen.getByText("config-off")).toBeDefined()
    // Row foreground muting class present (a FOREGROUND token, not opacity).
    const row = screen.getByText("d").closest("tr")
    expect(row?.className ?? "").toContain("text-[var(--color-muted)]")
  })
})
