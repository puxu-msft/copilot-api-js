import {
  //
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
  it("unknown type falls into GenericBlock", () => {
    render(<ContentRenderer blocks={[{ type: "weird_thing" } as never]} />)
    // GenericBlock renders the type both as a label and inside the JSON dump → getAllByText.
    expect(screen.getAllByText(/weird_thing/).length).toBeGreaterThan(0)
  })
})
