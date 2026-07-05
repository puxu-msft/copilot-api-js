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

import { ModelsFilterBar } from "@/components/models/ModelsFilterBar"
import { EMPTY_FILTERS } from "@/lib/model-filters"

const OPTIONS = {
  vendors: ["Anthropic", "OpenAI"],
  types: ["chat", "embeddings"],
  restrictedTo: ["pro", "max"],
  policyStates: ["enabled"],
}

/**
 * Golden behavior lock for `ModelsFilterBar` BEFORE any Radix Select migration
 * (P3, optional). Captures the native `<select>`/input onChange contract so a
 * later migration proves equivalence. See plans/2026-07-05-radix-migration.md §P0.
 */
describe("ModelsFilterBar (golden, pre-Radix)", () => {
  function renderBar(onChange = vi.fn()) {
    render(
      <ModelsFilterBar
        filters={EMPTY_FILTERS}
        onChange={onChange}
        options={OPTIONS}
      />,
    )
    return onChange
  }

  it("emits {search} on search input", () => {
    const onChange = renderBar()
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "opus" } })
    expect(onChange).toHaveBeenCalledWith({ search: "opus" })
  })

  it("emits {vendor} on vendor select", () => {
    const onChange = renderBar()
    fireEvent.change(screen.getByLabelText("Vendor"), { target: { value: "OpenAI" } })
    expect(onChange).toHaveBeenCalledWith({ vendor: "OpenAI" })
  })

  it("emits tri-state {premium} on premium select", () => {
    const onChange = renderBar()
    fireEvent.change(screen.getByLabelText("Premium"), { target: { value: "yes" } })
    expect(onChange).toHaveBeenCalledWith({ premium: true })
  })

  it("toggles a capability into {capabilities}", () => {
    const onChange = renderBar()
    fireEvent.click(screen.getByRole("button", { name: /^Vision$/i }))
    expect(onChange).toHaveBeenCalledWith({ capabilities: ["vision"] })
  })

  it("toggles a restricted-to plan into {restrictedTo}", () => {
    const onChange = renderBar()
    fireEvent.click(screen.getByRole("button", { name: /^pro$/i }))
    expect(onChange).toHaveBeenCalledWith({ restrictedTo: ["pro"] })
  })
})
