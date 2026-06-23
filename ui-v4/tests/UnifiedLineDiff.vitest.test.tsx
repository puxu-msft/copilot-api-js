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

import { UnifiedLineDiff } from "@/components/detail/diff/UnifiedLineDiff"
import { diffLinesRich } from "@/lib/diff/block-diff"

describe("UnifiedLineDiff", () => {
  it("renders add/del rows with gutter numbers and highlights changed words", () => {
    const rows = diffLinesRich("a\nb\nc", "a\nB\nc")
    render(<UnifiedLineDiff rows={rows} />)

    // The changed line surfaces as a paired del→add with word highlights.
    expect(screen.getByText("b")).toBeDefined()
    expect(screen.getByText("B")).toBeDefined()

    // Gutter line numbers for the surrounding "same" lines render.
    const container = render(<UnifiedLineDiff rows={rows} />).container
    expect(container.textContent).toContain("1")
    expect(container.textContent).toContain("3")

    // Both add (+) and del (−, U+2212) signs are present.
    expect(container.textContent).toContain("+")
    expect(container.textContent).toContain("−")
  })

  it("caps rendered rows at MAX_ROWS and shows a more-lines notice", () => {
    const big = Array.from({ length: 700 }, (_, i) => `line ${i}`).join("\n")
    const rows = diffLinesRich("", big)
    const { container } = render(<UnifiedLineDiff rows={rows} />)
    expect(container.textContent).toMatch(/more lines\./)
  })
})
