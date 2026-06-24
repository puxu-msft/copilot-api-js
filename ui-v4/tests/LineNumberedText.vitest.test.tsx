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

import {
  //
  LineGutter,
  LineNumberedText,
} from "@/components/detail/LineNumberedText"

describe("LineNumberedText", () => {
  it("renders one numbered cell per line with its content", () => {
    render(<LineNumberedText text={"alpha\nbeta\ngamma"} />)
    // Line numbers 1..3
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
    expect(screen.getByText("3")).toBeDefined()
    // Content present
    expect(screen.getByText("alpha")).toBeDefined()
    expect(screen.getByText("beta")).toBeDefined()
    expect(screen.getByText("gamma")).toBeDefined()
  })

  it("escapes content as React text (no HTML injection)", () => {
    const { container } = render(<LineNumberedText text={"<b>bold</b>"} />)
    // The literal angle brackets survive as text, no <b> element is created.
    expect(container.querySelector("b")).toBeNull()
    expect(screen.getByText("<b>bold</b>")).toBeDefined()
  })

  it("renders blank lines without collapsing them", () => {
    render(<LineNumberedText text={"one\n\nthree"} />)
    // Three lines → three numbers, including the empty middle line.
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
    expect(screen.getByText("3")).toBeDefined()
  })

  it("truncates beyond 500 lines and reveals all on click", () => {
    const text = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n")
    render(<LineNumberedText text={text} />)

    // Only the first 500 line numbers are rendered initially.
    expect(screen.getByText("500")).toBeDefined()
    expect(screen.queryByText("501")).toBeNull()

    const button = screen.getByRole("button", { name: /显示全部 600 行/ })
    fireEvent.click(button)

    // After expanding, all 600 lines are rendered and the button is gone.
    expect(screen.getByText("600")).toBeDefined()
    expect(screen.queryByRole("button", { name: /显示全部/ })).toBeNull()
  })
})

describe("LineGutter", () => {
  it("renders provided ReactNode lines with 1-based numbers", () => {
    render(<LineGutter lines={[<span key="a">node-a</span>, <em key="b">node-b</em>]} />)
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
    expect(screen.getByText("node-a")).toBeDefined()
    expect(screen.getByText("node-b")).toBeDefined()
  })

  it("applies the same >500 truncation to ReactNode lines", () => {
    const lines = Array.from({ length: 600 }, (_, i) => <span key={i}>{`n${i}`}</span>)
    render(<LineGutter lines={lines} />)
    expect(screen.getByText("500")).toBeDefined()
    expect(screen.queryByText("501")).toBeNull()
    expect(screen.getByRole("button", { name: /显示全部 600 行/ })).toBeDefined()
  })
})
