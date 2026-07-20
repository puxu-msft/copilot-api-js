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

import { JsonModalButton } from "@/components/detail/JsonModalButton"

describe("JsonModalButton", () => {
  it("renders a labeled button and no modal until clicked", () => {
    render(
      <JsonModalButton
        value={{ type: "text", text: "hi" }}
        label="View block JSON"
      />,
    )
    expect(screen.getByLabelText("View block JSON")).toBeDefined()
    expect(screen.queryByText("text JSON")).toBeNull()
  })

  it("opens the JSON modal for its value on click", () => {
    render(
      <JsonModalButton
        value={{ role: "user", content: [] }}
        label="View message JSON"
      />,
    )
    fireEvent.click(screen.getByLabelText("View message JSON"))
    // Title derives from role when there is no type → "user JSON".
    expect(screen.getByText("user JSON")).toBeDefined()
  })
})
