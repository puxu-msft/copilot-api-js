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
  vi,
} from "vitest"

import { ModelsColumnMenu } from "@/components/models/ModelsColumnMenu"
import { DEFAULT_COLUMN_VISIBILITY } from "@/lib/model-columns"

/**
 * Golden behavior lock for `ModelsColumnMenu` BEFORE the Radix DropdownMenu
 * migration (P2). Captures the current `<details>`-based menu's observable
 * contract so the migration can prove behavior-equivalence. See
 * plans/2026-07-05-radix-migration.md §P0.
 */
describe("ModelsColumnMenu (golden, pre-Radix)", () => {
  it("renders a checkbox per toggleable column reflecting visibility", () => {
    render(
      <ModelsColumnMenu
        columns={{ ...DEFAULT_COLUMN_VISIBILITY, vendor: false }}
        onToggle={() => {}}
        onReset={() => {}}
      />,
    )
    const vendor = screen.getByRole("checkbox", { name: /Vendor/i })
    const context = screen.getByRole("checkbox", { name: /Context/i })
    expect((vendor as HTMLInputElement).checked).toBe(false)
    expect((context as HTMLInputElement).checked).toBe(true)
  })

  it("calls onToggle with the column key when a checkbox is clicked", () => {
    const onToggle = vi.fn()
    render(
      <ModelsColumnMenu
        columns={DEFAULT_COLUMN_VISIBILITY}
        onToggle={onToggle}
        onReset={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("checkbox", { name: /Streaming/i }))
    expect(onToggle).toHaveBeenCalledWith("streaming")
  })

  it("calls onReset when Reset is clicked", () => {
    const onReset = vi.fn()
    render(
      <ModelsColumnMenu
        columns={DEFAULT_COLUMN_VISIBILITY}
        onToggle={() => {}}
        onReset={onReset}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Reset/i }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
