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

import { Modal } from "@/components/shared/Modal"

describe("Modal", () => {
  it("renders its title and children", () => {
    render(
      <Modal
        title="tool_use JSON"
        onClose={() => {}}
      >
        <div>body content</div>
      </Modal>,
    )
    expect(screen.getByText("tool_use JSON")).toBeDefined()
    expect(screen.getByText("body content")).toBeDefined()
  })

  it("closes on Escape", () => {
    const onClose = vi.fn()
    render(
      <Modal onClose={onClose}>
        <div>body</div>
      </Modal>,
    )
    // keydown on document bubbles to the window-level listener the modal installs.
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes when the backdrop is clicked", () => {
    const onClose = vi.fn()
    render(
      <Modal onClose={onClose}>
        <div>body</div>
      </Modal>,
    )
    fireEvent.click(screen.getByTestId("modal-backdrop"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does not close when the content area is clicked", () => {
    const onClose = vi.fn()
    render(
      <Modal onClose={onClose}>
        <div>body</div>
      </Modal>,
    )
    fireEvent.click(screen.getByText("body"))
    expect(onClose).not.toHaveBeenCalled()
  })

  it("closes via the close button", () => {
    const onClose = vi.fn()
    render(
      <Modal onClose={onClose}>
        <div>body</div>
      </Modal>,
    )
    fireEvent.click(screen.getByLabelText("Close"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // a11y GAIN from the Radix Dialog migration (was intentionally absent in the
  // hand-rolled version): focus moves into the dialog on open (Radix FocusScope).
  it("moves focus into the dialog on open (Radix focus management)", () => {
    render(
      <Modal
        title="t"
        onClose={() => {}}
      >
        <div>body</div>
      </Modal>,
    )
    const dialog = screen.getByRole("dialog")
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})
