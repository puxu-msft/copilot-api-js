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

import { ContentRenderer } from "@/components/detail/ContentRenderer"

describe("ContentRenderer", () => {
  it("dispatches text and tool_use blocks", () => {
    render(
      <ContentRenderer
        blocks={[
          { type: "text", text: "aaa" },
          { type: "tool_use", id: "x", name: "Read", input: {} },
        ]}
      />,
    )
    expect(screen.getByText(/aaa/)).toBeDefined()
    expect(screen.getByText(/Read/)).toBeDefined()
  })
  it("gives every block a JSON affordance", () => {
    render(
      <ContentRenderer
        blocks={[
          { type: "text", text: "aaa" },
          { type: "tool_use", id: "x", name: "Read", input: {} },
        ]}
      />,
    )
    // One "View block JSON" button per block.
    expect(screen.getAllByLabelText("View block JSON")).toHaveLength(2)
  })
  it("opens the raw JSON modal for a block on click", () => {
    render(<ContentRenderer blocks={[{ type: "tool_use", id: "x", name: "Read", input: {} }]} />)
    fireEvent.click(screen.getByLabelText("View block JSON"))
    expect(screen.getByText("tool_use JSON")).toBeDefined()
  })
  it("unknown type falls into GenericBlock", () => {
    render(<ContentRenderer blocks={[{ type: "weird_thing" } as never]} />)
    // GenericBlock renders the type both as a label and inside the JSON dump → getAllByText.
    expect(screen.getAllByText(/weird_thing/).length).toBeGreaterThan(0)
  })
})
