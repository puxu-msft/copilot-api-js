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

import { MessageBlock } from "@/components/detail/MessageBlock"

describe("MessageBlock", () => {
  it("exposes a message-level JSON affordance showing the enclosing role/content layer", () => {
    render(<MessageBlock message={{ role: "user", content: [{ type: "text", text: "hello" }] }} />)

    fireEvent.click(screen.getByLabelText("View message JSON"))
    // Title derives from the message role, and the modal shows the whole message object.
    expect(screen.getByText("user JSON")).toBeDefined()
    expect(document.body.textContent).toContain('"role"')
    expect(document.body.textContent).toContain('"user"')
  })

  it("still renders its content blocks (each with its own block-level affordance)", () => {
    render(<MessageBlock message={{ role: "user", content: [{ type: "text", text: "hello" }] }} />)
    expect(screen.getByText(/hello/)).toBeDefined()
    expect(screen.getByLabelText("View block JSON")).toBeDefined()
  })
})
