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

import { AgnosticDialog } from "@/components/ui/AgnosticDialog"

/**
 * B↔C boundary adapter contract (RFC §2 / round2-A3). `AgnosticDialog` is the
 * design-version-agnostic seam that B content bodies (`BlockJsonModal`) depend on
 * instead of a concrete dialog skin. Whatever skin it delegates to (legacy
 * `shared/Modal` today, forked shadcn `Dialog` in C6), it MUST keep this contract:
 * `title` rendered, `data-testid="modal-backdrop"` on the dismiss overlay, and
 * `onClose` fired on Escape / backdrop / × — the shared contract the modal tests
 * assert. This test guards the seam so a C6 fork cannot silently break B's callers.
 */
describe("AgnosticDialog (B↔C boundary adapter)", () => {
  it("renders its title and children", () => {
    render(
      <AgnosticDialog
        title="tool_use JSON"
        onClose={() => {}}
      >
        <div>body content</div>
      </AgnosticDialog>,
    )
    expect(screen.getByText("tool_use JSON")).toBeDefined()
    expect(screen.getByText("body content")).toBeDefined()
  })

  it("exposes the modal-backdrop testid and fires onClose when it is clicked", () => {
    const onClose = vi.fn()
    render(
      <AgnosticDialog onClose={onClose}>
        <div>body</div>
      </AgnosticDialog>,
    )
    fireEvent.click(screen.getByTestId("modal-backdrop"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("fires onClose on Escape", () => {
    const onClose = vi.fn()
    render(
      <AgnosticDialog onClose={onClose}>
        <div>body</div>
      </AgnosticDialog>,
    )
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does not fire onClose when the content area is clicked", () => {
    const onClose = vi.fn()
    render(
      <AgnosticDialog onClose={onClose}>
        <div>body</div>
      </AgnosticDialog>,
    )
    fireEvent.click(screen.getByText("body"))
    expect(onClose).not.toHaveBeenCalled()
  })
})
