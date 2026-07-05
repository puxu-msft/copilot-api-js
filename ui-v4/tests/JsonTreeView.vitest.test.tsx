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

import { JsonTreeView } from "@/components/tools/JsonTreeView"

describe("JsonTreeView (Radix Collapsible)", () => {
  it("renders nested keys and primitives", () => {
    render(<JsonTreeView value={{ a: 1, nested: { b: "x" } }} />)
    expect(screen.getByText("a")).toBeDefined()
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("nested")).toBeDefined()
    expect(screen.getByText(/"x"/)).toBeDefined()
  })

  it("collapse toggle is a keyboard-operable button with aria-expanded", async () => {
    const user = userEvent.setup()
    render(<JsonTreeView value={{ nested: { b: "x" } }} />)
    // The container node's trigger is a real button (was a div onClick).
    const trigger = screen.getByRole("button", { name: /nested/i })
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText(/"x"/)).toBeDefined()
    // Keyboard toggle: Enter collapses → child disappears + aria-expanded flips.
    trigger.focus()
    await user.keyboard("{Enter}")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText(/"x"/)).toBeNull()
  })
})
