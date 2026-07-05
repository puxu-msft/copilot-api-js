import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
 * `ModelsFilterBar` selects migrated to Radix `Select` (P-radix). The trigger is
 * now a `combobox` (open via userEvent) whose menu items are `option`s; search /
 * capability / plan controls are unchanged. Verifies the same onChange contract
 * the pre-Radix golden locked (search / vendor / tri-state premium / capability /
 * plan), plus that the "all/any" sentinel maps back to null.
 */
describe("ModelsFilterBar (Radix Select)", () => {
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

  async function pick(user: ReturnType<typeof userEvent.setup>, comboLabel: string, optionName: string) {
    await user.click(screen.getByRole("combobox", { name: comboLabel }))
    await user.click(screen.getByRole("option", { name: optionName }))
  }

  it("emits {search} on search input (native input, unchanged)", () => {
    const onChange = renderBar()
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "opus" } })
    expect(onChange).toHaveBeenCalledWith({ search: "opus" })
  })

  it("emits {vendor} on vendor select", async () => {
    const user = userEvent.setup()
    const onChange = renderBar()
    await pick(user, "Vendor", "OpenAI")
    expect(onChange).toHaveBeenCalledWith({ vendor: "OpenAI" })
  })

  it("maps the all/any sentinel back to null", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <ModelsFilterBar
        filters={{ ...EMPTY_FILTERS, vendor: "OpenAI" }}
        onChange={onChange}
        options={OPTIONS}
      />,
    )
    await pick(user, "Vendor", "all vendors")
    expect(onChange).toHaveBeenCalledWith({ vendor: null })
  })

  it("emits tri-state {premium} on premium select", async () => {
    const user = userEvent.setup()
    const onChange = renderBar()
    await pick(user, "Premium", "premium")
    expect(onChange).toHaveBeenCalledWith({ premium: true })
  })

  it("toggles a capability into {capabilities} (native button, unchanged)", () => {
    const onChange = renderBar()
    fireEvent.click(screen.getByRole("button", { name: /^Vision$/i }))
    expect(onChange).toHaveBeenCalledWith({ capabilities: ["vision"] })
  })

  it("toggles a restricted-to plan into {restrictedTo} (native button, unchanged)", () => {
    const onChange = renderBar()
    fireEvent.click(screen.getByRole("button", { name: /^pro$/i }))
    expect(onChange).toHaveBeenCalledWith({ restrictedTo: ["pro"] })
  })
})
